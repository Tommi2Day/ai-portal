import { afterEach, describe, expect, it, vi } from 'vitest';
import { confluenceConnector } from '../src/knowledge/connectors/confluence.js';
import { sharepointConnector } from '../src/knowledge/connectors/sharepoint.js';
import { httpFetch, type DocRef } from '../src/knowledge/connectors/types.js';

/** fetch mock: routes by URL (without origin for relative matching), records requests. */
function mockFetch(routes: Record<string, unknown | ((url: string) => Response)>) {
  const calls: { url: string; headers: Headers }[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(`no route for ${url}`, { status: 404 });
    const r = routes[key];
    if (typeof r === 'function') return r(url);
    return r instanceof Buffer ? new Response(r) : Response.json(r);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

async function all(it: AsyncIterable<DocRef>) {
  const out: DocRef[] = [];
  for await (const d of it) out.push(d);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe('httpFetch', () => {
  it('retries on 503 and fails with the status and body on other errors', async () => {
    let n = 0;
    mockFetch({
      '/flaky': () => (++n === 1 ? new Response('busy', { status: 503, headers: { 'retry-after': '0.001' } }) : Response.json({ ok: true })),
      '/broken': () => new Response('denied', { status: 403 }),
    });
    expect(await (await httpFetch('https://x/flaky')).json()).toEqual({ ok: true });
    expect(n).toBe(2);
    await expect(httpFetch('https://x/broken?token=secret')).rejects.toThrow('GET https://x/broken: HTTP 403 denied');
  });
});

describe('confluenceConnector', () => {
  const page = (id: string, title: string) => ({ id, title, version: { number: 3 }, _links: { webui: `/pages/${id}` } });

  it('Server/DC: pages of all spaces with Bearer token, paging and storage body as text', async () => {
    const calls = mockFetch({
      'spaceKey=IT&type=page&status=current&expand=version&limit=100&start=0': { results: [page('1', 'Runbook')], size: 1, limit: 1 },
      'spaceKey=IT&type=page&status=current&expand=version&limit=100&start=1': { results: [page('2', 'Backup')], size: 1, limit: 100 },
      'spaceKey=OPS': { results: [], size: 0, limit: 100 },
      '/rest/api/content/1?expand=body.storage': { body: { storage: { value: '<p>Schritt <b>eins</b></p>' } } },
    });
    const c = confluenceConnector({ baseUrl: 'https://wiki.acme.example/', deployment: 'server', spaceKeys: ['IT', 'OPS'] }, { token: 'pat' });
    const docs = await all(c.list());
    expect(docs.map((d) => [d.externalId, d.title, d.version, d.url])).toEqual([
      ['1', 'Runbook', '3', 'https://wiki.acme.example/pages/1'],
      ['2', 'Backup', '3', 'https://wiki.acme.example/pages/2'],
    ]);
    expect(calls[0].headers.get('authorization')).toBe('Bearer pat');
    const text = (await docs[0].load()).text!;
    expect(text.startsWith('# Runbook\n\n')).toBe(true);
    expect(text).toContain('Schritt');
  });

  it('Cloud: space lookup, cursor pagination and Basic auth', async () => {
    const calls = mockFetch({
      '/api/v2/spaces?keys=IT': { results: [{ id: '42' }] },
      '/api/v2/spaces/42/pages?limit=100&status=current': { results: [page('7', 'Start')], _links: { next: '/wiki/api/v2/spaces/42/pages?cursor=abc' } },
      'cursor=abc': { results: [page('8', 'Weiter')] },
    });
    const c = confluenceConnector({ baseUrl: 'https://acme.atlassian.net/wiki', deployment: 'cloud', spaceKeys: ['IT'] }, { email: 'a@acme.example', apiToken: 't' });
    expect((await all(c.list())).map((d) => d.title)).toEqual(['Start', 'Weiter']);
    expect(calls[0].headers.get('authorization')).toBe('Basic ' + Buffer.from('a@acme.example:t').toString('base64'));
    expect(calls.at(-1)!.url).toBe('https://acme.atlassian.net/wiki/api/v2/spaces/42/pages?cursor=abc');
  });

  it('Cloud: unknown space', async () => {
    mockFetch({ '/api/v2/spaces?keys=NOPE': { results: [] } });
    const c = confluenceConnector({ baseUrl: 'https://acme.atlassian.net/wiki', deployment: 'cloud', spaceKeys: ['NOPE'] }, {});
    await expect(all(c.list())).rejects.toThrow('Space NOPE nicht gefunden');
  });
});

describe('sharepointConnector', () => {
  const cfg = { tenantId: 'tid', clientId: 'cid', siteUrl: 'https://acme.sharepoint.com/sites/IT/', folderPath: 'Handbücher' };
  const file = (id: string, name: string, size = 10) => ({ id, name, webUrl: `https://acme.sharepoint.com/${name}`, cTag: `c${id}`, size, file: { mimeType: 'application/pdf' } });

  it('lists supported files recursively with app-only token, skips unsupported and oversized files', async () => {
    const calls = mockFetch({
      '/oauth2/v2.0/token': { access_token: 'tok', expires_in: 3600 },
      '/sites/acme.sharepoint.com:/sites/IT': { id: 'site1' },
      '/sites/site1/drives': { value: [{ id: 'd1', name: 'Dokumente' }] },
      '/drives/d1/root:/Handb%C3%BCcher:/children': {
        value: [file('f1', 'Betrieb.pdf'), file('f2', 'bild.png'), file('f3', 'riesig.pdf', 999 * 1024 * 1024), { id: 'dir', name: 'Alt', webUrl: '', folder: { childCount: 1 } }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page',
      },
      '/next-page': { value: [file('f4', 'Notizen.md')] },
      '/drives/d1/items/dir/children': { value: [file('f5', 'Archiv.docx')] },
      '/drives/d1/items/f1/content': Buffer.from('%PDF'),
    });
    const docs = await all(sharepointConnector(cfg, { clientSecret: 's' }).list());
    expect(docs.map((d) => [d.externalId, d.title, d.version])).toEqual([
      ['f1', 'Handbücher/Betrieb.pdf', 'cf1'],
      ['f5', 'Handbücher/Alt/Archiv.docx', 'cf5'],
      ['f4', 'Handbücher/Notizen.md', 'cf4'],
    ]);
    expect((await docs[0].load()).data!.toString()).toBe('%PDF');
    // one token request, reused for all Graph calls
    expect(calls.filter((c) => c.url.includes('/oauth2/')).length).toBe(1);
    expect(calls.find((c) => c.url.includes('/sites/site1/drives'))!.headers.get('authorization')).toBe('Bearer tok');
  });

  it('OneDrive of a user, and a missing library', async () => {
    mockFetch({
      '/oauth2/v2.0/token': { access_token: 'tok', expires_in: 3600 },
      '/users/max%40acme.example/drive': { id: 'od' },
      '/drives/od/root/children': { value: [file('x', 'a.txt')] },
      '/sites/acme.sharepoint.com:/sites/IT': { id: 'site1' },
      '/sites/site1/drives': { value: [{ id: 'd1', name: 'Dokumente' }] },
    });
    const od = await all(sharepointConnector({ tenantId: 't', clientId: 'c', userPrincipalName: 'max@acme.example' }, { clientSecret: 's' }).list());
    expect(od.map((d) => d.title)).toEqual(['a.txt']);
    await expect(all(sharepointConnector({ ...cfg, driveName: 'Fehlt' }, { clientSecret: 's' }).list())).rejects.toThrow('Bibliothek Fehlt nicht gefunden (vorhanden: Dokumente)');
    await expect(all(sharepointConnector({ tenantId: 't', clientId: 'c' }, { clientSecret: 's' }).list())).rejects.toThrow('siteUrl oder userPrincipalName erforderlich');
  });
});
