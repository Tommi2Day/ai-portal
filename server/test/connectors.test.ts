import { afterEach, describe, expect, it, vi } from 'vitest';
import { confluenceConnector } from '../src/knowledge/connectors/confluence.js';
import { sharepointConnector } from '../src/knowledge/connectors/sharepoint.js';
import { extractLinks, httpConnector, normalizeUrl } from '../src/knowledge/connectors/http.js';
import { httpFetch, type DocRef } from '../src/knowledge/connectors/types.js';
import { config } from '../src/config.js';

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

describe('confluenceConnector: page trees and subpages', () => {
  const sp = (id: string, title: string) => ({ id, title, version: { number: 1 }, _links: { webui: `/pages/${id}` } });
  const serverRoutes = () => ({
    '/rest/api/content/100?expand=version': sp('100', 'Root'),
    '/rest/api/content/100/child/page': { results: [sp('101', 'Kind')], size: 1, limit: 100 },
    '/rest/api/content/101/child/page': { results: [sp('102', 'Enkel')], size: 1, limit: 100 },
    '/rest/api/content/102/child/page': { results: [], size: 0, limit: 100 },
  });
  const server = (extra: object) => confluenceConnector({ baseUrl: 'https://wiki.acme.example', deployment: 'server', spaceKeys: [], rootPageIds: ['100'], ...extra }, { token: 'pat' });

  it('Server/DC: root page and all descendants, breadth first', async () => {
    mockFetch(serverRoutes());
    expect((await all(server({}).list())).map((d) => d.title)).toEqual(['Root', 'Kind', 'Enkel']);
  });

  it('maxDepth limits the tree; includeSubpages=false imports only the root page', async () => {
    mockFetch(serverRoutes());
    expect((await all(server({ maxDepth: 1 }).list())).map((d) => d.title)).toEqual(['Root', 'Kind']);
    expect((await all(server({ includeSubpages: false }).list())).map((d) => d.title)).toEqual(['Root']);
  });

  it('Cloud: tree via v2 children (version read per child)', async () => {
    mockFetch({
      '/api/v2/pages/100/children': { results: [{ id: '101' }] },
      '/api/v2/pages/101/children': { results: [] },
      '/api/v2/pages/100': sp('100', 'Root'),
      '/api/v2/pages/101': sp('101', 'Kind'),
    });
    const c = confluenceConnector({ baseUrl: 'https://acme.atlassian.net/wiki', deployment: 'cloud', spaceKeys: [], rootPageIds: ['100'] }, { email: 'a@acme.example', apiToken: 't' });
    expect((await all(c.list())).map((d) => [d.externalId, d.title, d.url])).toEqual([
      ['100', 'Root', 'https://acme.atlassian.net/wiki/pages/100'], ['101', 'Kind', 'https://acme.atlassian.net/wiki/pages/101'],
    ]);
  });

  it('without subpages a space imports only its top-level pages (depth=root), Server and Cloud', async () => {
    const calls = mockFetch({
      'spaceKey=IT': { results: [sp('1', 'Start')], size: 1, limit: 100 },
      '/api/v2/spaces?keys=IT': { results: [{ id: '42' }] },
      '/api/v2/spaces/42/pages': { results: [sp('7', 'Start')] },
    });
    await all(confluenceConnector({ baseUrl: 'https://wiki.acme.example', deployment: 'server', spaceKeys: ['IT'], includeSubpages: false }, { token: 'x' }).list());
    await all(confluenceConnector({ baseUrl: 'https://acme.atlassian.net/wiki', deployment: 'cloud', spaceKeys: ['IT'], includeSubpages: false }, {}).list());
    expect(calls.filter((c) => c.url.includes('depth=root')).length).toBe(2);
  });

  it('Cloud: load() returns the storage text and resolves the editor name once', async () => {
    const calls = mockFetch({
      '/api/v2/spaces?keys=IT': { results: [{ id: '42' }] },
      '/api/v2/spaces/42/pages': { results: [
        { id: '7', title: 'A', version: { number: 1, createdAt: '2026-01-02T00:00:00Z', authorId: 'acc-1' }, _links: { webui: '/a' } },
        { id: '8', title: 'B', version: { number: 1, authorId: 'acc-1' }, _links: { webui: '/b' } },
      ] },
      '/api/v2/pages/7?body-format=storage': { body: { storage: { value: '<p>Hallo Welt</p>' } } },
      '/api/v2/pages/8?body-format=storage': { body: { storage: { value: '<p>B</p>' } } },
      '/rest/api/user?accountId=acc-1': { displayName: 'Erika Muster' },
    });
    const c = confluenceConnector({ baseUrl: 'https://acme.atlassian.net/wiki', deployment: 'cloud', spaceKeys: ['IT'] }, { email: 'a@acme.example', apiToken: 't' });
    const docs = await all(c.list());
    expect(docs[0].modifiedAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    const first = await docs[0].load();
    expect(first.text).toContain('Hallo Welt');
    expect(first.author).toBe('Erika Muster');
    expect((await docs[1].load()).author).toBe('Erika Muster');
    expect(calls.filter((x) => x.url.includes('/rest/api/user')).length).toBe(1); // cached per account
  });

  it('Cloud: a failing user lookup does not break loading (author unknown)', async () => {
    mockFetch({
      '/api/v2/pages/9/children': { results: [] },
      '/api/v2/pages/9?body-format=storage': { body: { storage: { value: '<p>x</p>' } } },
      '/rest/api/user?accountId=gone': () => new Response('nope', { status: 403 }),
      '/api/v2/pages/9': { id: '9', title: 'X', version: { number: 1, authorId: 'gone' }, _links: { webui: '/x' } },
    });
    const c = confluenceConnector({ baseUrl: 'https://acme.atlassian.net/wiki', deployment: 'cloud', spaceKeys: [], rootPageIds: ['9'] }, {});
    const [doc] = await all(c.list());
    expect((await doc.load()).author).toBeNull();
  });

  it('a page in a space and in a tree is listed once', async () => {
    mockFetch({ ...serverRoutes(), 'spaceKey=IT': { results: [sp('100', 'Root'), sp('200', 'Anderer')], size: 2, limit: 100 } });
    const c = confluenceConnector({ baseUrl: 'https://wiki.acme.example', deployment: 'server', spaceKeys: ['IT'], rootPageIds: ['100'] }, { token: 'x' });
    expect((await all(c.list())).map((d) => d.externalId)).toEqual(['100', '200', '101', '102']);
  });
});

describe('httpConnector', () => {
  const html = (body: string, head = '') => new Response(`<html><head><title>T</title>${head}</head><body>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"e1"' } });
  const site = (pages: Record<string, () => Response>) => {
    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return pages[String(input)]?.() ?? new Response('nope', { status: 404 });
    });
    return calls;
  };
  const W = 'https://wiki.acme.example';
  const tree = () => ({
    [`${W}/docs/`]: () => html('<a href="a.html">A</a> <a href="/docs/b.html#x">B</a> <a href="/other/x.html">X</a> <a href="https://evil.example/docs/e.html">E</a> <a href="/docs/logo.png">L</a> <a href="mailto:x@y">M</a>'),
    [`${W}/docs/a.html`]: () => html('<h1>Seite A</h1><nav>MENÜ</nav><p>Inhalt A</p><a href="c.html">C</a>'),
    [`${W}/docs/b.html`]: () => html('<p>Inhalt B</p>'),
    [`${W}/docs/c.html`]: () => html('<p>Inhalt C</p><a href="d.html">D</a>'),
    [`${W}/docs/d.html`]: () => html('<p>Inhalt D</p>'),
    [`${W}/other/x.html`]: () => html('<p>draußen</p>'),
  });
  const run = (cfg: object, headers = {}) => all(httpConnector({ startUrls: [`${W}/docs/`], ...cfg }, headers).list());

  it('follows links to subpages within the start path, same host only, up to the default depth', async () => {
    const calls = site(tree());
    const docs = await run({});
    expect(docs.map((d) => d.url)).toEqual([`${W}/docs/`, `${W}/docs/a.html`, `${W}/docs/b.html`, `${W}/docs/c.html`, `${W}/docs/d.html`]);
    expect(calls.map((c) => c.url)).not.toContain(`${W}/other/x.html`);
    expect(calls.some((c) => c.url.includes('evil.example') || c.url.endsWith('.png'))).toBe(false);
    const a = docs[1];
    expect(a.title).toBe('T');
    const text = (await a.load()).text!;
    expect(text).toContain('Inhalt A');
    expect(text).not.toContain('MENÜ'); // navigation is skipped
    expect(a.version).toBe('"e1"');
  });

  it('maxDepth, includeSubpages=false and maxPages limit the crawl', async () => {
    site(tree());
    expect((await run({ maxDepth: 1 })).map((d) => d.url!.replace(W, ''))).toEqual(['/docs/', '/docs/a.html', '/docs/b.html']);
    expect((await run({ includeSubpages: false })).map((d) => d.url!.replace(W, ''))).toEqual(['/docs/']);
    expect((await run({ maxPages: 2 })).length).toBe(2);
    expect((await run({ maxDepth: 0 })).length).toBe(5); // unlimited depth
  });

  it('exclude and pathPrefix narrow the scope; a broader prefix reaches sibling paths', async () => {
    site(tree());
    expect((await run({ exclude: ['b.html'] })).map((d) => d.url)).not.toContain(`${W}/docs/b.html`);
    const wide = await all(httpConnector({ startUrls: [`${W}/docs/`], pathPrefix: '/' }, {}).list());
    expect(wide.map((d) => d.url)).toContain(`${W}/other/x.html`);
  });

  it('honours meta robots (noindex: not indexed, nofollow: links not followed)', async () => {
    site({
      [`${W}/docs/`]: () => html('<a href="a.html">A</a><a href="b.html">B</a>'),
      [`${W}/docs/a.html`]: () => html('<p>geheim</p><a href="c.html">C</a>', '<meta name="robots" content="noindex">'),
      [`${W}/docs/b.html`]: () => html('<p>B</p><a href="d.html">D</a>', '<meta name="robots" content="nofollow">'),
      [`${W}/docs/c.html`]: () => html('<p>C</p>'),
      [`${W}/docs/d.html`]: () => html('<p>D</p>'),
    });
    expect((await run({})).map((d) => d.url!.replace(W, ''))).toEqual(['/docs/', '/docs/b.html', '/docs/c.html']);
  });

  it('sends the configured headers; follows in-scope redirects, rejects redirects out of scope', async () => {
    const calls = site({
      [`${W}/docs/`]: () => new Response(null, { status: 302, headers: { location: '/docs/home.html' } }),
      [`${W}/docs/home.html`]: () => html('<p>Start</p>'),
    });
    const docs = await run({}, { Authorization: 'Bearer secret' });
    expect(docs.map((d) => d.url)).toEqual([`${W}/docs/home.html`]);
    expect(calls.every((c) => c.headers.get('authorization') === 'Bearer secret')).toBe(true);

    site({ [`${W}/docs/`]: () => new Response(null, { status: 302, headers: { location: 'https://login.example/sso' } }) });
    await expect(run({})).rejects.toThrow('außerhalb des erlaubten Bereichs');
  });

  it('start page errors surface, broken subpages are skipped; other content types become documents or are skipped', async () => {
    site({ [`${W}/docs/`]: () => new Response('boom', { status: 500 }) });
    await expect(run({})).rejects.toThrow('HTTP 500');

    site({
      [`${W}/docs/`]: () => html('<a href="gone.html">G</a><a href="notes.txt">N</a><a href="data.bin">B</a><a href="api">J</a>'),
      [`${W}/docs/notes.txt`]: () => new Response('Notiz Text', { headers: { 'content-type': 'text/plain' } }),
      [`${W}/docs/data.bin`]: () => new Response('xx', { headers: { 'content-type': 'application/octet-stream' } }),
      [`${W}/docs/api`]: () => Response.json({ a: 1 }),
    });
    const docs = await run({});
    expect(docs.map((d) => d.url!.replace(W, ''))).toEqual(['/docs/', '/docs/notes.txt']);
    expect((await docs[1].load()).text).toBe('Notiz Text');
  });

  it('retries a busy page (503 with Retry-After); redirect loops and invalid redirects fail the start page', async () => {
    let n = 0;
    site({ [`${W}/docs/`]: () => (++n === 1 ? new Response('busy', { status: 503, headers: { 'retry-after': '0.001' } }) : html('<p>ok</p>')) });
    expect((await run({})).length).toBe(1);
    expect(n).toBe(2);

    site({ [`${W}/docs/`]: () => new Response(null, { status: 302, headers: { location: '/docs/' } }) });
    await expect(run({})).rejects.toThrow('zu viele Weiterleitungen');
    site({ [`${W}/docs/`]: () => new Response(null, { status: 302, headers: { location: 'http://' } }) });
    await expect(run({})).rejects.toThrow('ungültige Weiterleitung');
  });

  it('a redirect of a subpage to another host is skipped, files above KNOWLEDGE_MAX_FILE_MB are skipped', async () => {
    site({
      [`${W}/docs/`]: () => html('<a href="away.html">A</a><a href="big.html">B</a><a href="small.html">S</a>'),
      [`${W}/docs/away.html`]: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } }),
      [`${W}/docs/big.html`]: () => html(`<p>${'x'.repeat(5000)}</p>`),
      [`${W}/docs/small.html`]: () => html('<p>s</p>'),
    });
    const saved = config.KNOWLEDGE_MAX_FILE_MB;
    config.KNOWLEDGE_MAX_FILE_MB = 0.0007; // ~700 bytes
    try {
      expect((await run({})).map((d) => d.url!.replace(W, ''))).toEqual(['/docs/', '/docs/small.html']);
    } finally { config.KNOWLEDGE_MAX_FILE_MB = saved; }
  });

  it('rejects a configuration without a usable start URL', async () => {
    site({});
    await expect(all(httpConnector({ startUrls: ['not a url'] }, {}).list())).rejects.toThrow('Keine gültige Start-URL');
  });

  it('helpers: link extraction and URL normalization', () => {
    expect(extractLinks(`<a class="x" href="/a?x=1&amp;y=2">1</a><A HREF='b'>2</A><a href=c>3</a>`)).toEqual(['/a?x=1&y=2', 'b', 'c']);
    expect(normalizeUrl('../x.html#top', 'https://h.example/a/b/')).toBe('https://h.example/a/x.html');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
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
