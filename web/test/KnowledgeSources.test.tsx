import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, submit, type } from './dom';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/api', () => ({ api }));
const { Knowledge } = await import('../src/Knowledge');
const { setLang } = await import('../src/i18n');

const TOKEN = 'kt_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const source = (o: object) => ({ id: 's', comment: null, type: 'http', name: 'S', config: {}, hasSecret: false, syncIntervalMinutes: 60, enabled: true, lastStatus: 'ok', lastSyncAt: null, lastError: null, lastStats: null, ...o });
const collection = (sources: object[]) => ({ id: 'c1', comment: null, name: 'IT', description: '', public: false, allowedGroups: ['IT'], documents: 0, chunks: 0, sources });

function backend(cols: object[]) {
  api.mockImplementation(async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? (init.body ? 'POST' : 'GET');
    if (path === '/admin/knowledge/collections' && method === 'GET') return cols;
    if (path === '/admin/knowledge/sources' && method === 'POST') return { id: 'new' };
    if (path.endsWith('/trigger-token') && method === 'POST') return { token: TOKEN, url: `http://localhost/api/hooks/knowledge/${path.split('/')[4]}/sync` };
    if (path === '/admin/knowledge/embedding') return { settings: null, presets: {} };
    return method === 'GET' ? [] : {};
  });
}

let dom: ReturnType<typeof mount>;
beforeEach(() => { setLang('de'); api.mockReset(); dom = mount(); vi.stubGlobal('confirm', () => true); });
afterEach(() => { dom.unmount(); vi.unstubAllGlobals(); });

/** The "add source" form: the one with the source type selector (embedding and collection forms look alike). */
const sourceForm = () => dom.$$<HTMLFormElement>('form.grid-form').find((f) => f.querySelector('option[value=filesystem]'))!;
/** The input/select/textarea inside the <label> of the source form whose text starts with `label`. */
const field = <T extends HTMLElement>(label: string) => {
  const l = [...sourceForm().querySelectorAll('label')].find((x) => x.textContent?.trim().startsWith(label));
  if (!l) throw new Error(`no field "${label}"`);
  return l.querySelector<T>('input, select, textarea')!;
};
const openForm = async () => { await click(dom.$$<HTMLButtonElement>('button').find((b) => b.textContent === 'Quelle hinzufügen')!); };
const sourceCall = () => api.mock.calls.find(([p, i]) => p === '/admin/knowledge/sources' && i?.body)![1].body;

describe('Knowledge sources', () => {
  it('shows what a web, a Confluence page-tree and a Confluence space source import', async () => {
    backend([collection([
      source({ id: 'w', name: 'Wiki', config: { startUrls: ['https://wiki.acme.example/it/', 'https://wiki.acme.example/ops/'] } }),
      source({ id: 'c', type: 'confluence', name: 'Conf', config: { baseUrl: 'https://wiki.acme.example', spaceKeys: ['IT'], rootPageIds: ['123', '456'] } }),
    ])]);
    await dom.render(<Knowledge />);
    const text = dom.el.textContent!;
    expect(text).toContain('https://wiki.acme.example/it/, https://wiki.acme.example/ops/');
    expect(text).toContain('https://wiki.acme.example · IT, #123, #456');
    expect(text).toContain('Webseiten (HTTP)');
  });

  it('creates a web source: start URLs, subpage settings and a masked header, then syncs', async () => {
    backend([collection([])]);
    await dom.render(<Knowledge />);
    await openForm();
    await type(field<HTMLSelectElement>('Typ'), 'http');
    await type(field('Name'), 'IT-Wiki');
    await type(field<HTMLTextAreaElement>('Start-URLs'), 'https://wiki.acme.example/it/\n\n https://wiki.acme.example/ops/ ');
    await click(field<HTMLInputElement>('Unterseiten (Links) folgen')); // default on -> off
    await type(field('Max. Linktiefe'), '2');
    await type(field('Max. Seiten'), '50');
    await type(field('Pfad-Präfix'), '/it/');
    await type(field('Ausschließen'), '/login, ?print=1');
    await type(field('Header-Wert'), 'Bearer wiki-token');
    expect(field<HTMLInputElement>('Header-Wert').type).toBe('password');
    await submit(sourceForm());
    expect(sourceCall()).toMatchObject({
      collectionId: 'c1', type: 'http', name: 'IT-Wiki', secret: { Authorization: 'Bearer wiki-token' },
      config: { startUrls: ['https://wiki.acme.example/it/', 'https://wiki.acme.example/ops/'], includeSubpages: false, maxDepth: 2, maxPages: 50, pathPrefix: '/it/', exclude: ['/login', '?print=1'] },
    });
    expect(api).toHaveBeenCalledWith('/admin/knowledge/sources/new/sync', { method: 'POST' });
  });

  it('web source defaults: follow links, depth 3, 200 pages, no secret without a header value', async () => {
    backend([collection([])]);
    await dom.render(<Knowledge />);
    await openForm();
    await type(field<HTMLSelectElement>('Typ'), 'http');
    await type(field('Name'), 'Docs');
    await type(field<HTMLTextAreaElement>('Start-URLs'), 'https://docs.acme.example/');
    await submit(sourceForm());
    const body = sourceCall();
    expect(body.config).toMatchObject({ includeSubpages: true, maxDepth: 3, maxPages: 200 });
    expect(body.secret).toBeUndefined();
  });

  it('creates a Confluence page tree with subpage settings (space keys optional when page IDs are given)', async () => {
    backend([collection([])]);
    await dom.render(<Knowledge />);
    await openForm();
    await type(field<HTMLSelectElement>('Typ'), 'confluence');
    await type(field('Name'), 'Handbuch');
    await type(field('Basis-URL'), 'https://acme.atlassian.net/wiki');
    expect(field<HTMLInputElement>('Space-Keys').required).toBe(true);
    await type(field('Seiten-IDs'), '123, 456');
    expect(field<HTMLInputElement>('Space-Keys').required).toBe(false);
    await type(field('Max. Tiefe'), '2');
    await type(field('E-Mail'), 'svc@acme.example');
    await type(field('API-Token'), 'tok');
    await submit(sourceForm());
    expect(sourceCall()).toMatchObject({
      type: 'confluence', secret: { email: 'svc@acme.example', apiToken: 'tok' },
      config: { baseUrl: 'https://acme.atlassian.net/wiki', deployment: 'cloud', spaceKeys: [], rootPageIds: ['123', '456'], includeSubpages: true, maxDepth: 2 },
    });
  });

  it('Confluence without subpages (checkbox off) for a whole space', async () => {
    backend([collection([])]);
    await dom.render(<Knowledge />);
    await openForm();
    await type(field<HTMLSelectElement>('Typ'), 'confluence');
    await type(field('Name'), 'Space');
    await type(field('Basis-URL'), 'https://acme.atlassian.net/wiki');
    await type(field('Space-Keys'), 'IT, OPS');
    await click(field<HTMLInputElement>('Unterseiten importieren'));
    await type(field('E-Mail'), 'a@b.example');
    await type(field('API-Token'), 't');
    await submit(sourceForm());
    expect(sourceCall().config).toMatchObject({ spaceKeys: ['IT', 'OPS'], includeSubpages: false, maxDepth: 0 });
    expect(sourceCall().config.rootPageIds).toBeUndefined();
  });

  it('shows the server error when creating a source fails', async () => {
    backend([collection([])]);
    await dom.render(<Knowledge />);
    api.mockImplementation(async (path: string, init: { method?: string } = {}) => {
      if (path === '/admin/knowledge/sources') throw new Error('Nur http(s)-URLs');
      return (init.method ?? 'GET') === 'GET' ? (path === '/admin/knowledge/collections' ? [collection([])] : []) : {};
    });
    await openForm();
    await type(field<HTMLSelectElement>('Typ'), 'http');
    await type(field('Name'), 'x');
    await type(field<HTMLTextAreaElement>('Start-URLs'), 'ftp://x/y');
    await submit(sourceForm());
    expect(dom.el.textContent).toContain('Nur http(s)-URLs');
  });
});

describe('Knowledge sources: how they are updated', () => {
  const calls = (path: string, method?: string) => api.mock.calls.filter(([p, i]) => p === path && (method ? (i?.method ?? 'GET') === method : true));
  const button = (label: string) => dom.$$<HTMLButtonElement>('button').find((b) => b.textContent === label)!;
  const panel = () => dom.$$('.card-box').find((x) => x.querySelector('h4')?.textContent?.startsWith('Einstellungen von'))!;
  const panelField = <T extends HTMLElement>(label: string) => [...panel().querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(label))!.querySelector<T>('input, select')!;

  it('lists how each source is updated: automatic, manual, external, and whether it replaces completely', async () => {
    backend([collection([
      source({ id: 'a', name: 'Auto', syncIntervalMinutes: 60 }),
      source({ id: 'm', name: 'Manual', syncIntervalMinutes: 0 }),
      source({ id: 'e', name: 'External', syncIntervalMinutes: 0, hasTrigger: true }),
      source({ id: 'r', name: 'Replace', syncIntervalMinutes: 15, replaceOnSync: true }),
    ])]);
    await dom.render(<Knowledge />);
    const rows = dom.$$('tbody tr').filter((r) => r.querySelector('.mono'));
    const label = (name: string) => rows.find((r) => r.textContent!.startsWith(name))!.textContent!;
    expect(label('Auto')).toContain('60 min');
    expect(label('Manual')).toContain('manuell');
    expect(label('External')).toContain('extern ausgelöst');
    expect(label('Replace')).toContain('15 min · ersetzt vollständig');
  });

  it('a new source defaults to hourly, incremental updates', async () => {
    backend([collection([])]);
    await dom.render(<Knowledge />);
    await openForm();
    await type(field<HTMLSelectElement>('Typ'), 'http');
    await type(field('Name'), 'Docs');
    await type(field<HTMLTextAreaElement>('Start-URLs'), 'https://docs.acme.example/');
    await submit(sourceForm());
    expect(sourceCall()).toMatchObject({ syncIntervalMinutes: 60, replaceOnSync: false });
    expect(calls('/admin/knowledge/sources/new/trigger-token')).toHaveLength(0);
  });

  it('a new source with the manual option and a full replace', async () => {
    backend([collection([])]);
    await dom.render(<Knowledge />);
    await openForm();
    await type(field<HTMLSelectElement>('Typ'), 'http');
    await type(field('Name'), 'Docs');
    await type(field<HTMLTextAreaElement>('Start-URLs'), 'https://docs.acme.example/');
    await type(field<HTMLSelectElement>('Aktualisierung'), '0');
    await click(field<HTMLInputElement>('Gespeicherten Inhalt'));
    await submit(sourceForm());
    expect(sourceCall()).toMatchObject({ syncIntervalMinutes: 0, replaceOnSync: true });
  });

  it('a new externally triggered source gets its webhook: token masked until revealed, ready-made call, then done', async () => {
    backend([collection([])]);
    await dom.render(<Knowledge />);
    await openForm();
    await type(field<HTMLSelectElement>('Typ'), 'http');
    await type(field('Name'), 'Docs');
    await type(field<HTMLTextAreaElement>('Start-URLs'), 'https://docs.acme.example/');
    await type(field<HTMLSelectElement>('Aktualisierung'), 'external');
    await submit(sourceForm());
    expect(sourceCall()).toMatchObject({ syncIntervalMinutes: 0, replaceOnSync: false });
    expect(calls('/admin/knowledge/sources/new/trigger-token', 'POST')).toHaveLength(1);

    const info = dom.$$('.card-box').find((x) => x.textContent!.includes('Aufruf-URL'))!;
    expect(info.textContent).toContain('POST http://localhost/api/hooks/knowledge/new/sync');
    expect(info.textContent).toContain('••••');
    expect(info.textContent).not.toContain(TOKEN); // masked, also in the curl example
    await click([...info.querySelectorAll('button')].find((b) => b.textContent === 'Anzeigen')!);
    expect(info.textContent).toContain(TOKEN);
    expect(info.querySelector('pre')!.textContent).toBe(`curl -X POST -H "Authorization: Bearer ${TOKEN}" http://localhost/api/hooks/knowledge/new/sync`);
    await click([...info.querySelectorAll('button')].find((b) => b.textContent === 'Verbergen')!);
    expect(info.textContent).not.toContain(TOKEN);

    const collections = calls('/admin/knowledge/collections', 'GET').length;
    await click(button('Fertig'));
    expect(calls('/admin/knowledge/collections', 'GET').length).toBeGreaterThan(collections); // the list reloads
    expect(dom.el.textContent).not.toContain('Aufruf-URL');
  });

  it('"Vollständig ersetzen" (in the update panel) asks first, then starts an update with replace; the plain button keeps the setting', async () => {
    backend([collection([source({ id: 's1', name: 'Wiki' }), source({ id: 'u1', type: 'upload', name: 'Uploads' })])]);
    await dom.render(<Knowledge />);
    expect(dom.$$('button').filter((b) => b.textContent === 'Einstellungen')).toHaveLength(1); // uploads have no update panel
    expect(dom.$$('button').filter((b) => b.textContent === 'Vollständig ersetzen')).toHaveLength(0); // not crowding the table row
    await click(button('Einstellungen'));
    expect(dom.$$('button').filter((b) => b.textContent === 'Vollständig ersetzen')).toHaveLength(1);

    vi.stubGlobal('confirm', () => false);
    await click(button('Vollständig ersetzen'));
    expect(calls('/admin/knowledge/sources/s1/sync')).toHaveLength(0);
    vi.stubGlobal('confirm', () => true);
    await click(button('Vollständig ersetzen'));
    expect(api).toHaveBeenCalledWith('/admin/knowledge/sources/s1/sync', { method: 'POST', body: { replace: true } });
    // the plain button of the row keeps the source's own setting
    await click(button('Synchronisieren'));
    expect(api).toHaveBeenCalledWith('/admin/knowledge/sources/s1/sync', { method: 'POST' });
  });

  it('settings panel: interval, replace option, and switching between automatic, manual and external', async () => {
    backend([collection([source({ id: 's1', name: 'Wiki', syncIntervalMinutes: 60 })])]);
    await dom.render(<Knowledge />);
    expect(dom.$$('button').filter((b) => b.textContent === 'Einstellungen')).toHaveLength(1); // not for uploads
    await click(button('Einstellungen'));
    expect(panel().querySelector('h4')!.textContent).toContain('Wiki');
    expect(panel().textContent).toContain('nur neue und geänderte Dokumente');
    expect(panel().textContent).not.toContain('Aufruf-URL');

    await type(panelField<HTMLSelectElement>('Intervall'), '1440');
    expect(api).toHaveBeenCalledWith('/admin/knowledge/sources/s1', { method: 'PATCH', body: { syncIntervalMinutes: 1440 } });
    await click(panelField<HTMLInputElement>('Gespeicherten Inhalt'));
    expect(api).toHaveBeenCalledWith('/admin/knowledge/sources/s1', { method: 'PATCH', body: { replaceOnSync: true } });

    await type(panelField<HTMLSelectElement>('Aktualisierung'), 'manual');
    expect(api).toHaveBeenCalledWith('/admin/knowledge/sources/s1', { method: 'PATCH', body: { syncIntervalMinutes: 0 } });
    expect(calls('/admin/knowledge/sources/s1/trigger-token', 'DELETE')).toHaveLength(0); // no token to revoke

    await type(panelField<HTMLSelectElement>('Aktualisierung'), 'external');
    expect(calls('/admin/knowledge/sources/s1', 'PATCH').at(-1)![1].body).toEqual({ syncIntervalMinutes: 0 });
    expect(calls('/admin/knowledge/sources/s1/trigger-token', 'POST')).toHaveLength(1);
    expect(panel().textContent).toContain('POST http://localhost/api/hooks/knowledge/s1/sync');
    expect(panel().textContent).not.toContain(TOKEN); // masked until revealed
  });

  it('settings panel of an external source: rotate (after a warning) and revoke the token; switching to manual revokes it', async () => {
    backend([collection([source({ id: 's1', name: 'Wiki', syncIntervalMinutes: 0, hasTrigger: true, replaceOnSync: true, hookUrl: 'https://ai.acme.example/api/hooks/knowledge/s1/sync' })])]);
    await dom.render(<Knowledge />);
    await click(button('Einstellungen'));
    expect(panelField<HTMLSelectElement>('Aktualisierung').value).toBe('external');
    expect(panel().textContent).toContain('Aufruf-URL');
    expect(panel().textContent).toContain('POST https://ai.acme.example/api/hooks/knowledge/s1/sync'); // the public address from the server, not the browser's
    expect(panel().textContent).not.toContain('localhost');
    expect(panel().textContent).toContain('überschreibt den gespeicherten Inhalt'); // explains the full replace
    expect(panelField<HTMLInputElement>('Gespeicherten Inhalt').checked).toBe(true);

    vi.stubGlobal('confirm', () => false);
    await click([...panel().querySelectorAll('button')].find((b) => b.textContent === 'Token neu erzeugen')!);
    expect(calls('/admin/knowledge/sources/s1/trigger-token', 'POST')).toHaveLength(0);
    vi.stubGlobal('confirm', () => true);
    await click([...panel().querySelectorAll('button')].find((b) => b.textContent === 'Token neu erzeugen')!);
    expect(calls('/admin/knowledge/sources/s1/trigger-token', 'POST')).toHaveLength(1);
    expect(panel().textContent).toContain('Neues Token');

    await click([...panel().querySelectorAll('button')].find((b) => b.textContent === 'Token widerrufen')!);
    expect(calls('/admin/knowledge/sources/s1/trigger-token', 'DELETE')).toHaveLength(1);

    await type(panelField<HTMLSelectElement>('Aktualisierung'), 'manual');
    expect(calls('/admin/knowledge/sources/s1/trigger-token', 'DELETE')).toHaveLength(2); // the source still has a token in this mock
  });

  it('shows server errors in the settings panel', async () => {
    backend([collection([source({ id: 's1', name: 'Wiki' })])]);
    await dom.render(<Knowledge />);
    await click(button('Einstellungen'));
    api.mockImplementation(async (path: string, init: { method?: string } = {}) => {
      if (init.method === 'PATCH') throw new Error('Ungültige Eingabe');
      return path === '/admin/knowledge/collections' ? [collection([source({ id: 's1', name: 'Wiki' })])] : (init.method ?? 'GET') === 'GET' ? [] : {};
    });
    await click(panelField<HTMLInputElement>('Gespeicherten Inhalt'));
    expect(panel().textContent).toContain('Ungültige Eingabe');
  });
});

describe('Knowledge: notes (comment column)', () => {
  const enter = async (el: Element) => { const { act } = await import('react'); await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }); };
  const write = async (cell: HTMLElement, text: string) => {
    await click(cell.querySelector<HTMLButtonElement>('button.comment')!);
    const input = cell.querySelector<HTMLInputElement>('input[aria-label=Kommentar]')!;
    await type(input, text);
    await enter(input);
  };

  it('collection and source notes are shown and saved with the entry PATCH', async () => {
    backend([{ ...collection([source({ id: 's1', name: 'Wiki', comment: 'Token läuft Ende 2026 ab' })]), comment: 'Verantwortlich: IT-Betrieb' }]);
    await dom.render(<Knowledge />);
    expect(dom.$$('thead th').map((h) => h.textContent)).toContain('Kommentar');
    const cells = dom.$$('button.comment');
    expect(cells.map((c) => c.textContent)).toEqual(['Verantwortlich: IT-Betrieb', 'Token läuft Ende 2026 ab']);

    await write(cells[0].parentElement!, 'Neu: Team Wissen');
    expect(api).toHaveBeenCalledWith('/admin/knowledge/collections/c1', { method: 'PATCH', body: { comment: 'Neu: Team Wissen' } });
    await write(dom.$$('button.comment')[1].parentElement!, 'Token erneuert');
    expect(api).toHaveBeenCalledWith('/admin/knowledge/sources/s1', { method: 'PATCH', body: { comment: 'Token erneuert' } });
  });

  it('without a note the hint is shown and an empty input does not save', async () => {
    backend([collection([source({ id: 's1', name: 'Wiki' })])]);
    await dom.render(<Knowledge />);
    expect(dom.$$('button.comment').map((c) => c.textContent)).toEqual(['+ Notiz', '+ Notiz']);
    await click(dom.$$<HTMLButtonElement>('button.comment')[0]);
    await enter(dom.$<HTMLInputElement>('input[aria-label=Kommentar]'));
    expect(api.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(false);
  });
});

describe('Knowledge sources: on/off switch and credentials', () => {
  const calls = (path: string, method?: string) => api.mock.calls.filter(([p, i]) => p === path && (method ? (i?.method ?? 'GET') === method : true));
  const button = (label: string) => dom.$$<HTMLButtonElement>('button').find((b) => b.textContent === label)!;
  const panel = () => dom.$$('.card-box').find((x) => x.querySelector('h4')?.textContent?.startsWith('Einstellungen von'))!;
  const label = (root: Element, text: string) => [...root.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(text))!.querySelector<HTMLInputElement>('input, select')!;
  const credForm = () => panel().querySelector<HTMLFormElement>('form.grid-form')!;
  const open = async (src: object) => { backend([collection([src])]); await dom.render(<Knowledge />); await click(button('Einstellungen')); };

  it('a disabled source is marked in the table and the panel switches it on and off', async () => {
    backend([collection([source({ id: 'a', name: 'Active' }), source({ id: 'd', name: 'Disabled', enabled: false })])]);
    await dom.render(<Knowledge />);
    const rows = dom.$$('tbody tr').filter((r) => r.querySelector('.mono'));
    const row = (name: string) => rows.find((r) => r.textContent!.startsWith(name))!;
    expect(row('Active').className).toBe('');
    expect(row('Active').textContent).not.toContain('deaktiviert');
    expect(row('Disabled').className).toBe('disabled');
    expect(row('Disabled').textContent).toContain('deaktiviert');

    await click([...row('Disabled').querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Einstellungen')!);
    const toggle = label(panel(), 'Quelle aktiv');
    expect(toggle.checked).toBe(false);
    expect(panel().textContent).toContain('weder automatisch noch extern');
    await click(toggle);
    expect(api).toHaveBeenCalledWith('/admin/knowledge/sources/d', { method: 'PATCH', body: { enabled: true } });
  });

  it('an active source is switched off from the panel', async () => {
    await open(source({ id: 's1', name: 'Wiki' }));
    const toggle = label(panel(), 'Quelle aktiv');
    expect(toggle.checked).toBe(true);
    await click(toggle);
    expect(api).toHaveBeenCalledWith('/admin/knowledge/sources/s1', { method: 'PATCH', body: { enabled: false } });
  });

  it('each source type asks for its own credentials; file shares have none; the stored ones are never shown', async () => {
    const fieldsOf = async (src: object) => {
      await dom.render(<></>);
      backend([collection([src])]);
      await dom.render(<Knowledge />);
      await click(button('Einstellungen'));
      return [...panel().querySelectorAll('form.grid-form label')].map((l) => l.textContent!.trim());
    };
    expect(await fieldsOf(source({ id: 'c', type: 'confluence', config: { deployment: 'cloud' }, hasSecret: true }))).toEqual(['E-Mail (Service-Konto)', 'API-Token']);
    expect(panel().textContent).toContain('Gespeichert (wird nicht angezeigt)');
    expect(await fieldsOf(source({ id: 'c2', type: 'confluence', config: { deployment: 'server' } }))).toEqual(['Personal Access Token']);
    expect(panel().textContent).toContain('Keine hinterlegt');
    expect(await fieldsOf(source({ id: 'sp', type: 'sharepoint', hasSecret: true }))).toEqual(['Client-Secret']);
    expect(await fieldsOf(source({ id: 'w', type: 'http' }))).toEqual(['Header-Name', 'Header-Wert']);
    await dom.render(<></>);
    backend([collection([source({ id: 'f', type: 'filesystem', config: { path: 'x' } })])]);
    await dom.render(<Knowledge />);
    await click(button('Einstellungen'));
    expect(panel().textContent).not.toContain('Zugangsdaten'); // nothing to enter for a share
  });

  it('credentials are entered in masked fields, sent as one complete set, then forgotten', async () => {
    await open(source({ id: 'c', type: 'confluence', config: { deployment: 'cloud' }, hasSecret: true }));
    const form = credForm();
    expect(label(form, 'API-Token').type).toBe('password');
    expect(label(form, 'API-Token').autocomplete).toBe('new-password');
    await type(label(form, 'E-Mail'), 'svc@acme.example');
    await type(label(form, 'API-Token'), 'tok-secret-123');
    const collections = calls('/admin/knowledge/collections', 'GET').length;
    await submit(form);
    expect(api).toHaveBeenCalledWith('/admin/knowledge/sources/c', { method: 'PATCH', body: { secret: { email: 'svc@acme.example', apiToken: 'tok-secret-123' } } });
    expect(panel().textContent).toContain('Die nächste Aktualisierung verwendet die neuen Zugangsdaten');
    expect(label(credForm(), 'API-Token').value).toBe('');
    expect(label(credForm(), 'E-Mail').value).toBe('');
    expect(document.body.innerHTML).not.toContain('tok-secret-123');
    expect(calls('/admin/knowledge/collections', 'GET').length).toBeGreaterThan(collections);
    expect(calls('/admin/knowledge/sources/c/sync')).toHaveLength(0); // saving alone does not sync
  });

  it('"Ersetzen & synchronisieren" saves first, then starts an update; an incomplete form does nothing', async () => {
    await open(source({ id: 'sp', type: 'sharepoint' }));
    await click(button('Ersetzen & synchronisieren'));
    expect(calls('/admin/knowledge/sources/sp', 'PATCH')).toHaveLength(0); // the required field is empty

    await type(label(credForm(), 'Client-Secret'), 'new-secret-456');
    await click(button('Ersetzen & synchronisieren'));
    const order = api.mock.calls.map(([p, i]) => `${i?.method ?? 'GET'} ${p}`).filter((x) => x.includes('/sources/sp'));
    expect(order).toEqual(['PATCH /admin/knowledge/sources/sp', 'POST /admin/knowledge/sources/sp/sync']);
    expect(calls('/admin/knowledge/sources/sp', 'PATCH')[0][1].body).toEqual({ secret: { clientSecret: 'new-secret-456' } });
  });

  it('web source: header name and value, a custom header name, removal after a confirmation', async () => {
    await open(source({ id: 'w', type: 'http', hasSecret: true }));
    const form = credForm();
    expect(label(form, 'Header-Name').value).toBe('Authorization');
    expect(label(form, 'Header-Wert').type).toBe('password');
    await type(label(form, 'Header-Name'), 'X-Api-Key');
    await type(label(form, 'Header-Wert'), 'key-789');
    await submit(form);
    expect(api).toHaveBeenCalledWith('/admin/knowledge/sources/w', { method: 'PATCH', body: { secret: { 'X-Api-Key': 'key-789' } } });
    expect(label(credForm(), 'Header-Name').value).toBe('Authorization'); // the form starts over

    vi.stubGlobal('confirm', () => false);
    await click(button('Zugangsdaten entfernen'));
    expect(calls('/admin/knowledge/sources/w', 'PATCH')).toHaveLength(1);
    vi.stubGlobal('confirm', () => true);
    await click(button('Zugangsdaten entfernen'));
    expect(calls('/admin/knowledge/sources/w', 'PATCH').at(-1)![1].body).toEqual({ secret: {} });
  });

  it('removal is offered only for a web source that has credentials', async () => {
    await open(source({ id: 'w', type: 'http', hasSecret: false }));
    expect(dom.$$('button').some((b) => b.textContent === 'Zugangsdaten entfernen')).toBe(false);
    await dom.render(<></>);
    await open(source({ id: 'c', type: 'confluence', config: { deployment: 'server' }, hasSecret: true }));
    expect(dom.$$('button').some((b) => b.textContent === 'Zugangsdaten entfernen')).toBe(false);
  });

  it('a rejected set shows the server message and keeps what was typed', async () => {
    backend([collection([source({ id: 'c', type: 'confluence', config: { deployment: 'server' } })])]);
    await dom.render(<Knowledge />);
    await click(button('Einstellungen'));
    api.mockImplementation(async (path: string, init: { method?: string } = {}) => {
      if (init.method === 'PATCH') throw new Error('Personal Access Token erforderlich');
      return path === '/admin/knowledge/collections' ? [collection([source({ id: 'c', type: 'confluence', config: { deployment: 'server' } })])] : (init.method ?? 'GET') === 'GET' ? [] : {};
    });
    await type(label(credForm(), 'Personal Access Token'), 'abc');
    await submit(credForm());
    expect(panel().textContent).toContain('Personal Access Token erforderlich');
    expect(label(credForm(), 'Personal Access Token').value).toBe('abc');
  });
});
