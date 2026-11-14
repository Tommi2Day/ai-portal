import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { click, mount, submit, type } from './dom';

const api = vi.hoisted(() => vi.fn());
vi.mock('../src/api', () => ({ api }));
const { Admin } = await import('../src/Admin');
const { setLang } = await import('../src/i18n');

const me = { id: 'u0', username: 'admin', displayName: 'Admin', email: null, role: 'admin', authSource: 'local', groups: [], profileCompleted: true } as never;
const user = { id: 'u1', username: 'j.meyer', comment: 'Bereitschaft', displayName: 'Julia Meyer', email: 'j@acme.example', authSource: 'local', role: 'user', groups: [], active: true, pendingApproval: false, createdAt: '2026-01-01T00:00:00Z', lastLoginAt: null };

let providers: object[] = [];
let modelList: object[] = [];
let sso: { enabled: boolean; env: object[]; assignments: object[] };
function backend() {
  api.mockImplementation(async (path: string, init: { method?: string; body?: any } = {}) => {
    const method = init.method ?? (init.body ? 'POST' : 'GET');
    if (path === '/admin/sso/assignments' && method === 'GET') return sso;
    if (path === '/admin/sso/assignments' && method === 'PUT') { sso = { ...sso, assignments: init.body.assignments }; return sso; }
    if (path === '/admin/users' && method === 'GET') return [user];
    if (path === '/admin/providers' && method === 'GET') return providers;
    if (path === '/admin/models' && method === 'GET') return modelList;
    return method === 'GET' ? [] : {};
  });
}

let dom: ReturnType<typeof mount>;
beforeEach(() => {
  setLang('de'); api.mockReset(); providers = []; modelList = [];
  sso = { enabled: true, env: [{ type: 'group', value: 'AiPortal-Admins', admin: true }], assignments: [{ type: 'user', value: '*@acme.example', admin: false }] };
  backend();
  dom = mount();
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => { dom.unmount(); vi.unstubAllGlobals(); });

const tab = (label: string) => dom.$$<HTMLButtonElement>('.seg button').find((b) => b.textContent === label)!;

describe('Administration: Single Sign-On', () => {
  it('lists environment entries read-only and stored assignments with their role', async () => {
    await dom.render(<Admin me={me} />);
    await click(tab('Single Sign-On'));
    const rows = dom.$$('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('AiPortal-Admins');
    expect(rows[0].textContent).toContain('Admin');
    expect(rows[0].textContent).toContain('Umgebung');
    expect(rows[0].querySelector('button')).toBeNull(); // environment entries cannot be deleted here
    expect(rows[1].textContent).toContain('*@acme.example');
    expect(rows[1].textContent).toContain('Zugriff');
  });

  it('adds an assignment (group, admin) and deletes one', async () => {
    await dom.render(<Admin me={me} />);
    await click(tab('Single Sign-On'));
    const form = dom.$<HTMLFormElement>('form.grid-form');
    await type(form.querySelector('select')!, 'group');
    await type(form.querySelector('input:not([type=checkbox])')!, ' grp-dba ');
    await click(form.querySelector<HTMLInputElement>('input[type=checkbox]')!);
    await submit(form);
    expect(api).toHaveBeenCalledWith('/admin/sso/assignments', {
      method: 'PUT', body: { assignments: [{ type: 'user', value: '*@acme.example', admin: false }, { type: 'group', value: 'grp-dba', admin: true }] },
    });
    expect(dom.$$('tbody tr')).toHaveLength(3);

    await click([...dom.$$('tbody tr')[1].querySelectorAll('button')].find((b) => b.textContent === 'Löschen')!);
    expect(api).toHaveBeenLastCalledWith('/admin/sso/assignments', { method: 'PUT', body: { assignments: [{ type: 'group', value: 'grp-dba', admin: true }] } });
  });

  it('shows the server error and keeps the form value when saving fails; warns when SSO is off', async () => {
    sso.enabled = false;
    await dom.render(<Admin me={me} />);
    await click(tab('Single Sign-On'));
    expect(dom.el.textContent).toContain('SSO ist nicht aktiviert');
    api.mockImplementation(async (path: string, init: { method?: string } = {}) => {
      if (init.method === 'PUT') throw new Error('Ungültige Eingabe');
      return path === '/admin/sso/assignments' ? sso : [];
    });
    const form = dom.$<HTMLFormElement>('form.grid-form');
    const input = form.querySelector<HTMLInputElement>('input:not([type=checkbox])')!;
    await type(input, 'grp-x');
    await submit(form);
    expect(dom.el.textContent).toContain('Ungültige Eingabe');
    expect(dom.$<HTMLInputElement>('form.grid-form input:not([type=checkbox])').value).toBe('grp-x');
  });
});

describe('Administration: users', () => {
  it('sets a new password through a masked field, never window.prompt', async () => {
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    await dom.render(<Admin me={me} />);
    await click(tab('Benutzer'));
    await click(dom.$$<HTMLButtonElement>('tbody button').find((b) => b.textContent === 'Passwort')!);
    const input = dom.$<HTMLInputElement>('tbody input[type=password]');
    expect(input).not.toBeNull();
    await type(input, 'new-password-1234');
    await submit(input.closest('form')!);
    expect(api).toHaveBeenCalledWith('/admin/users/u1', { method: 'PATCH', body: { password: 'new-password-1234' } });
    expect(prompt).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain('new-password-1234');
  });
});

describe('Administration: providers', () => {
  const provider = { id: 'p1', comment: null, name: 'Claude', type: 'anthropic', baseUrl: null, region: null, options: {}, hasSecret: true, enabled: true };

  it('rotates an API key through a masked field, never window.prompt; Bedrock IAM roles have no key button', async () => {
    providers = [provider, { ...provider, id: 'p2', name: 'Bedrock', type: 'bedrock', region: 'eu-central-1', hasSecret: false }];
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    await dom.render(<Admin me={me} />);
    const rows = dom.$$('tbody tr');
    expect(rows[0].textContent).toContain('••••'); // the key itself is never shown
    expect(rows[1].textContent).toContain('IAM-Rolle');
    expect([...rows[1].querySelectorAll('button')].some((b) => b.textContent === 'Schlüssel')).toBe(false);

    await click([...rows[0].querySelectorAll('button')].find((b) => b.textContent === 'Schlüssel')!);
    const input = dom.$<HTMLInputElement>('tbody input[type=password]');
    expect(input.autocomplete).toBe('new-password');
    await type(input, 'sk-ant-new-key-123');
    await submit(input.closest('form')!);
    expect(api).toHaveBeenCalledWith('/admin/providers/p1', { method: 'PATCH', body: { secret: { apiKey: 'sk-ant-new-key-123' } } });
    expect(prompt).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain('sk-ant-new-key-123');
  });
});

const enter = (el: Element) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
/** Opens the comment cell of a row, types a note and presses Enter. */
async function writeNote(row: Element, text: string) {
  await click(row.querySelector<HTMLButtonElement>('button.comment')!);
  const input = row.querySelector<HTMLInputElement>('input[aria-label=Kommentar]')!;
  await type(input, text);
  await enter(input);
}

describe('Administration: notes (comment column)', () => {
  it('users: shows the note and saves a changed one with the user PATCH', async () => {
    await dom.render(<Admin me={me} />);
    await click(tab('Benutzer'));
    expect(dom.$$('thead th').map((h) => h.textContent)).toContain('Kommentar');
    const row = dom.$$('tbody tr')[0];
    expect(row.querySelector('button.comment')!.textContent).toBe('Bereitschaft');
    await writeNote(row, 'Urlaub bis 01.12.');
    expect(api).toHaveBeenCalledWith('/admin/users/u1', { method: 'PATCH', body: { comment: 'Urlaub bis 01.12.' } });
  });

  it('providers and models: an empty note shows the hint, saving sends only the comment', async () => {
    providers = [{ id: 'p1', comment: null, name: 'Claude', type: 'anthropic', baseUrl: null, region: null, options: {}, hasSecret: true, enabled: true }];
    modelList = [{ id: 'm1', comment: 'Pilot', providerId: 'p1', modelId: 'claude-x', displayName: 'Claude X', description: null, supportsImages: true, enabled: true, isDefault: false, sort: 0 }];
    await dom.render(<Admin me={me} />);
    const [providerRow, modelRow] = dom.$$('tbody tr');
    expect(providerRow.querySelector('button.comment')!.textContent).toBe('+ Notiz');
    expect(modelRow.querySelector('button.comment')!.textContent).toBe('Pilot');

    await writeNote(providerRow, 'Vertrag bis 12/2027');
    expect(api).toHaveBeenCalledWith('/admin/providers/p1', { method: 'PATCH', body: { comment: 'Vertrag bis 12/2027' } });
    await writeNote(modelRow, 'Produktiv');
    expect(api).toHaveBeenCalledWith('/admin/models/m1', { method: 'PATCH', body: { comment: 'Produktiv' } });
  });

  it('SSO: a note on the new assignment, editing and removing the note of a stored one, none for environment entries', async () => {
    sso.assignments = [{ type: 'user', value: '*@acme.example', admin: false, comment: 'alle Mitarbeiter' }];
    await dom.render(<Admin me={me} />);
    await click(tab('Single Sign-On'));
    const rows = dom.$$('tbody tr');
    expect(rows[0].querySelector('button.comment')).toBeNull(); // environment entry
    expect(rows[0].textContent).toContain('–');
    expect(rows[1].querySelector('button.comment')!.textContent).toBe('alle Mitarbeiter');

    await writeNote(rows[1], 'Mitarbeiter und Externe');
    expect(api).toHaveBeenLastCalledWith('/admin/sso/assignments', { method: 'PUT', body: { assignments: [{ type: 'user', value: '*@acme.example', admin: false, comment: 'Mitarbeiter und Externe' }] } });
    await writeNote(dom.$$('tbody tr')[1], '   '); // emptied -> the note is removed
    const lastBody = api.mock.calls.filter(([p, i]) => p === '/admin/sso/assignments' && i?.method === 'PUT').at(-1)![1].body;
    expect(lastBody.assignments[0].comment).toBeUndefined();

    const form = dom.$<HTMLFormElement>('form.grid-form');
    const inputs = form.querySelectorAll<HTMLInputElement>('input:not([type=checkbox])');
    await type(inputs[0], 'grp-dba');
    await type(inputs[1], '  Datenbank-Team  ');
    expect(inputs[1].maxLength).toBe(200);
    await submit(form);
    const added = api.mock.calls.filter(([p, i]) => p === '/admin/sso/assignments' && i?.method === 'PUT').at(-1)![1].body.assignments.at(-1);
    expect(added).toMatchObject({ type: 'group', value: 'grp-dba', comment: 'Datenbank-Team' });
  });
});
