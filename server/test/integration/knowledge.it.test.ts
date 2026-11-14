/**
 * Knowledge base on real PostgreSQL/pgvector with deterministic mock embeddings:
 * upload, file-share sync, hybrid search, group permissions, the chat tool and the
 * portal's own MCP endpoint (/mcp) with personal access tokens.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import { MockLlm, toolResults } from './mockLlm.js';
import { adminApi, Api, ApiError, mcpClient, mcpText, mockProvider, newUser, portalUrl, until } from './helpers.js';

const llm = new MockLlm();
let admin: Api;
let itUser: Api; // member of group IT-Ops
let hrUser: Api; // no group
let modelId: string;
let itCollection: string;
let publicCollection: string;
let embeddingCalls: MockLlm['requests'] = [];

const upload = async (collectionId: string, files: Record<string, string>) => {
  const form = new FormData();
  for (const [name, text] of Object.entries(files)) form.append('files', new Blob([text], { type: 'text/plain' }), name);
  return admin.call('POST', `/api/admin/knowledge/collections/${collectionId}/upload`, form);
};
const search = async (api: Api, q: string) => (await api.get(`/api/knowledge/search?q=${encodeURIComponent(q)}`)) as { title: string; collection: string; content: string }[];

beforeAll(async () => {
  await llm.start();
  admin = await adminApi();
  const p = await mockProvider(admin, llm.url, 'Mock Knowledge');
  modelId = p.modelId;
  itUser = (await newUser(admin, 'user', ['IT-Ops'])).api;
  hrUser = (await newUser(admin)).api;

  const emb = await admin.put('/api/admin/knowledge/embedding', { providerId: p.providerId, modelId: 'mock-embedding', dimensions: 64 });
  expect(emb.ok).toBe(true);
  embeddingCalls = llm.requests.filter((r) => r.path === '/v1/embeddings');

  itCollection = (await admin.post('/api/admin/knowledge/collections', { name: 'IT operations', description: 'Runbooks', allowedGroups: ['IT-Ops'] })).id;
  publicCollection = (await admin.post('/api/admin/knowledge/collections', { name: 'Handbook', description: 'Policies', public: true })).id;

  const r1 = await upload(itCollection, {
    'rman-runbook.md': '# RMAN backup runbook\n\nIf the nightly RMAN backup fails with ORA-19809 the fast recovery area is full. Delete obsolete backups.',
    'vpn.md': '# VPN\n\nThe VPN client for remote access is configured with the company profile.',
  });
  expect(r1.map((r: any) => r.result)).toEqual(['added', 'added']);
  await upload(publicCollection, { 'travel-policy.md': '# Travel policy\n\nTrain travel is preferred for trips under 500 km.' });
});
afterAll(() => llm.stop());
beforeEach(() => llm.reset());

describe('embedding model', () => {
  it('is tested on save and embeds through the provider', async () => {
    const calls = embeddingCalls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].body).toMatchObject({ model: 'mock-embedding', dimensions: 64 });
    expect(calls[0].headers.authorization).toBe('Bearer mock-key');
  });

  it('refuses Anthropic as embedding provider', async () => {
    const anthropic = await admin.post('/api/admin/providers', { name: 'Anthropic (no embeddings)', type: 'anthropic', secret: { apiKey: 'x' } });
    await expect(admin.put('/api/admin/knowledge/embedding', { providerId: anthropic.id, modelId: 'x' }))
      .rejects.toMatchObject({ status: 400, body: { error: 'Anthropic does not offer embeddings' } });
  });
});

describe('search and permissions', () => {
  it('finds documents by exact terms (full text) and by meaning (vector)', async () => {
    const byCode = await search(itUser, 'ORA-19809');
    expect(byCode[0]).toMatchObject({ title: 'rman-runbook.md', collection: 'IT operations' });
    const byWords = await search(itUser, 'nightly backup fails');
    expect(byWords[0].title).toBe('rman-runbook.md');
  });

  it('shows group collections only to members, public ones to everybody', async () => {
    expect((await search(hrUser, 'ORA-19809')).some((h) => h.collection === 'IT operations')).toBe(false);
    expect((await search(hrUser, 'train travel'))[0]).toMatchObject({ title: 'travel-policy.md' });
    const cols = await hrUser.get('/api/knowledge/collections');
    expect(cols.collections.map((c: any) => c.name)).toEqual(['Handbook']);
  });

  it('re-uploading a file replaces the document instead of adding a second one', async () => {
    const [r] = await upload(publicCollection, { 'travel-policy.md': '# Travel policy\n\nFlights need approval for trips under 500 km.' });
    expect(r.result).toBe('updated');
    const hits = (await search(hrUser, 'travel policy')).filter((h) => h.title === 'travel-policy.md');
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('Flights need approval');
  });
});

describe('file-share source', () => {
  const dir = () => path.join(inject('fsRoot'), 'it-share');
  let sourceId: string;
  const docs = async () => (await admin.get(`/api/admin/knowledge/sources/${sourceId}/documents`)) as { title: string; status: string; chunkCount: number }[];
  const source = async () => (await admin.get('/api/admin/knowledge/collections')).flatMap((c: any) => c.sources).find((s: any) => s.id === sourceId);
  const sync = async () => {
    const before = (await source())?.lastSyncAt;
    await admin.post(`/api/admin/knowledge/sources/${sourceId}/sync`);
    return until(async () => { const s = await source(); return s.lastSyncAt !== before && s.lastStatus !== 'running' && s; });
  };

  beforeAll(async () => {
    fs.mkdirSync(path.join(dir(), 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir(), 'patching.md'), '# Patching\n\nLinux servers are patched every second Tuesday.');
    fs.writeFileSync(path.join(dir(), 'sub', 'dns.txt'), 'Internal DNS servers: ns1 and ns2.');
    fs.writeFileSync(path.join(dir(), 'binary.exe'), Buffer.from([0, 1, 2]));
    sourceId = (await admin.post('/api/admin/knowledge/sources', {
      collectionId: itCollection, type: 'filesystem', name: 'IT share', config: { path: 'it-share', recursive: true, urlPrefix: 'file://fs01/it-share' }, syncIntervalMinutes: 0,
    })).id;
  });

  it('indexes supported files recursively and links them to the share', async () => {
    const s = await sync();
    expect(s.lastStatus).toBe('ok');
    // title = path relative to the source folder (backslash on Windows hosts)
    expect((await docs()).map((d) => d.title.replace(/\\/g, '/')).sort()).toEqual(['patching.md', 'sub/dns.txt']);
    const [hit] = await search(itUser, 'second Tuesday patched');
    expect(hit).toMatchObject({ title: 'patching.md', url: 'file://fs01/it-share/patching.md' });
  });

  it('skips unchanged files on the next sync', async () => {
    const s = await sync();
    expect(s.lastStats).toMatchObject({ unchanged: 2, added: 0, updated: 0, removed: 0 });
  });

  it('picks up changes and removes deleted files on the next sync', async () => {
    fs.writeFileSync(path.join(dir(), 'patching.md'), '# Patching\n\nLinux servers are patched every first Monday.');
    fs.rmSync(path.join(dir(), 'sub', 'dns.txt'));
    await sync();
    expect((await docs()).map((d) => d.title)).toEqual(['patching.md']);
    const [hit] = await search(itUser, 'first Monday');
    expect(hit.content).toContain('first Monday');
  });

  it('rejects paths outside KNOWLEDGE_FS_ROOT', async () => {
    await expect(admin.post('/api/admin/knowledge/sources', { collectionId: itCollection, type: 'filesystem', name: 'evil', config: { path: '../../etc' } }))
      .rejects.toBeInstanceOf(ApiError);
  });
});

describe('web source (http): subpages from a real web server', () => {
  // a small wiki served by a real HTTP server in the test process; /wiki/ needs a bearer token
  const pages: Record<string, string> = {
    '/wiki/': '<title>Wiki home</title><h1>Wiki home</h1><p>Welcome.</p><a href="network.html">Network</a> <a href="/public/off.html">outside</a>',
    '/wiki/network.html': '<title>Network</title><nav>NAVIGATION-NOISE</nav><p>The core switches run firmware 9.4.</p><a href="vlans.html">VLANs</a>',
    '/wiki/vlans.html': '<title>VLANs</title><p>Management VLAN is 110.</p>',
    '/public/off.html': '<title>Outside</title><p>Zebra-unique outside the start path.</p>',
  };
  let server: http.Server;
  let base: string;
  let sourceId: string;
  const requests: { path: string; auth?: string }[] = [];
  const source = async () => (await admin.get('/api/admin/knowledge/collections')).flatMap((c: any) => c.sources).find((s: any) => s.id === sourceId);
  const titles = async () => ((await admin.get(`/api/admin/knowledge/sources/${sourceId}/documents`)) as { title: string }[]).map((d) => d.title).sort();
  const sync = async () => {
    const before = (await source())?.lastSyncAt;
    await admin.post(`/api/admin/knowledge/sources/${sourceId}/sync`);
    return until(async () => { const s = await source(); return s.lastSyncAt !== before && s.lastStatus !== 'running' && s; });
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      requests.push({ path, auth: req.headers.authorization });
      if (path.startsWith('/wiki/') && req.headers.authorization !== 'Bearer wiki-token') { res.writeHead(401).end('login required'); return; }
      if (!(path in pages)) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: `"${pages[path].length}"` }).end(`<html><body>${pages[path]}</body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('rejects invalid configurations and header names', async () => {
    const create = (config: object, secret?: object) => admin.post('/api/admin/knowledge/sources', { collectionId: itCollection, type: 'http', name: 'bad', config, secret });
    await expect(create({ startUrls: [] })).rejects.toMatchObject({ status: 400 });
    await expect(create({ startUrls: ['ftp://x/y'] })).rejects.toMatchObject({ status: 400 });
    await expect(create({ startUrls: [`${base}/wiki/`], maxPages: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(create({ startUrls: [`${base}/wiki/`] }, { 'bad header': 'x' })).rejects.toMatchObject({ status: 400 });
  });

  it('a wrong token fails the sync with a clear status', async () => {
    sourceId = (await admin.post('/api/admin/knowledge/sources', {
      collectionId: itCollection, type: 'http', name: 'IT wiki', syncIntervalMinutes: 0,
      config: { startUrls: [`${base}/wiki/`], includeSubpages: true, maxDepth: 3 }, secret: { Authorization: 'Bearer wrong' },
    })).id;
    const s = await sync();
    expect(s.lastStatus).toBe('error');
    expect(s.lastError).toContain('HTTP 401');
  });

  it('imports the start page and its subpages with the configured header, stays inside the start path', async () => {
    await admin.patch(`/api/admin/knowledge/sources/${sourceId}`, { secret: { Authorization: 'Bearer wiki-token' } });
    const s = await sync();
    expect(s.lastStatus).toBe('ok');
    expect(await titles()).toEqual(['Network', 'VLANs', 'Wiki home']);
    expect(requests.some((r) => r.path === '/public/off.html')).toBe(false);
    const [hit] = await search(itUser, 'core switches firmware');
    expect(hit).toMatchObject({ title: 'Network' });
    expect(hit.content).not.toContain('NAVIGATION-NOISE');
    expect((await search(itUser, 'Management VLAN 110')).some((h) => h.title === 'VLANs')).toBe(true);
    expect((await search(itUser, 'Zebra-unique')).some((h) => h.title === 'Outside')).toBe(false);
  });

  it('skips unchanged pages, picks up changes and removes pages that vanished', async () => {
    expect((await sync()).lastStats).toMatchObject({ unchanged: 3, added: 0, updated: 0, removed: 0 });
    pages['/wiki/vlans.html'] = '<title>VLANs</title><p>Management VLAN is now 220.</p>';
    delete pages['/wiki/network.html']; // also cuts the link chain to vlans.html
    const s = await sync();
    expect(await titles()).toEqual(['Wiki home']);
    expect(s.lastStats).toMatchObject({ removed: 2 });
  });

  it('includeSubpages=false imports only the start page; maxDepth limits link depth', async () => {
    pages['/wiki/network.html'] = '<title>Network</title><p>The core switches run firmware 9.4.</p><a href="vlans.html">VLANs</a>';
    await admin.patch(`/api/admin/knowledge/sources/${sourceId}`, { config: { startUrls: [`${base}/wiki/`], includeSubpages: false } });
    await sync();
    expect(await titles()).toEqual(['Wiki home']);
    await admin.patch(`/api/admin/knowledge/sources/${sourceId}`, { config: { startUrls: [`${base}/wiki/`], includeSubpages: true, maxDepth: 1 } });
    await sync();
    expect(await titles()).toEqual(['Network', 'Wiki home']);
    await admin.patch(`/api/admin/knowledge/sources/${sourceId}`, { config: { startUrls: [`${base}/wiki/`], includeSubpages: true, maxDepth: 0 } });
    await sync();
    expect(await titles()).toEqual(['Network', 'VLANs', 'Wiki home']);
  });

  describe('updates: incremental, full replace, external trigger', () => {
    /** Stored text of a document as a member of the collection reads it: the knowledge MCP tool, like an external client. */
    let reader: Awaited<ReturnType<typeof mcpClient>> | undefined;
    afterAll(async () => { await reader?.close(); });
    const textOf = async (title: string) => {
      reader ??= await mcpClient(`${portalUrl()}/mcp`, ((await itUser.post('/api/tokens', { name: 'update-reader', expiresInDays: 30 })) as { token: string }).token);
      const d = ((await admin.get(`/api/admin/knowledge/sources/${sourceId}/documents`)) as { id: string; title: string }[]).find((x) => x.title === title)!;
      return mcpText(await reader.callTool({ name: 'dokument_lesen', arguments: { dokument_id: d.id } }));
    };
    const hookUrl = () => `${portalUrl()}/api/hooks/knowledge/${sourceId}/sync`;
    const callHook = (token: string, body?: object) => fetch(hookUrl(), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const waitAfter = async (before: string | null) => until(async () => { const x = await source(); return x.lastSyncAt !== before && x.lastStatus !== 'running' && x; });

    it('an incremental update keeps what the server reports as unchanged; a full replace re-imports every page, subpages included', async () => {
      // same length -> same ETag -> "unchanged" for an incremental update
      pages['/wiki/vlans.html'] = '<title>VLANs</title><p>Management VLAN is now 330.</p>';
      expect((await sync()).lastStats).toMatchObject({ unchanged: 3, updated: 0 });
      expect(await textOf('VLANs')).toContain('now 220');

      await admin.patch(`/api/admin/knowledge/sources/${sourceId}`, { replaceOnSync: true });
      expect((await sync()).lastStats).toMatchObject({ updated: 3, unchanged: 0, removed: 0 });
      expect(await textOf('VLANs')).toContain('now 330');
      expect(await textOf('VLANs')).not.toContain('now 220');

      // a subpage disappears: the replaced import removes it, the others are re-imported
      delete pages['/wiki/vlans.html'];
      expect((await sync()).lastStats).toMatchObject({ updated: 2, removed: 1 });
      expect(await titles()).toEqual(['Network', 'Wiki home']);
    });

    it('a source that cannot be read keeps the stored content', async () => {
      const home = pages['/wiki/'];
      delete pages['/wiki/'];
      const failed = await sync();
      expect(failed.lastStatus).toBe('error');
      expect(failed.lastError).toContain('HTTP 404');
      expect(await titles()).toEqual(['Network', 'Wiki home']); // nothing was removed or replaced
      pages['/wiki/'] = home;
    });

    it('an external system triggers the update with the source token; a full replace can be requested per call', async () => {
      await admin.patch(`/api/admin/knowledge/sources/${sourceId}`, { replaceOnSync: false, syncIntervalMinutes: 0 });
      const { token, url } = (await admin.post(`/api/admin/knowledge/sources/${sourceId}/trigger-token`)) as { token: string; url: string };
      expect(url).toBe(hookUrl());
      expect((await callHook('kt_' + 'x'.repeat(43))).status).toBe(401);
      expect((await fetch(hookUrl(), { method: 'POST' })).status).toBe(401);

      // the page changes behind an unchanged ETag; the plain call is incremental, the next one replaces
      pages['/wiki/network.html'] = '<title>Network</title><p>The core switches run firmware 9.5.</p><a href="vlans.html">VLANs</a>';
      const before = (await source()).lastSyncAt;
      const r1 = await callHook(token);
      expect(r1.status).toBe(202);
      expect(await r1.json()).toEqual({ started: true, replace: false });
      expect((await waitAfter(before)).lastStats).toMatchObject({ updated: 0 });
      expect(await textOf('Network')).toContain('9.4');

      const before2 = (await source()).lastSyncAt;
      const r2 = await callHook(token, { replace: true });
      expect(await r2.json()).toEqual({ started: true, replace: true });
      expect((await waitAfter(before2)).lastStats).toMatchObject({ updated: 2 });
      expect(await textOf('Network')).toContain('9.5');

      const audited = (await admin.get('/api/admin/audit?action=knowledge.sync&limit=3')) as { username: string; details: { trigger: string; replace: boolean } }[];
      expect(audited[0]).toMatchObject({ username: 'external-trigger', details: { trigger: 'external', replace: true } });

      await admin.del(`/api/admin/knowledge/sources/${sourceId}/trigger-token`);
      expect((await callHook(token)).status).toBe(401);
    });
  });
});

describe('knowledge tool in the chat', () => {
  it('searches the collections of the user and returns numbered hits', async () => {
    llm.script = (r) => toolResults(r).length
      ? { text: `According to [1]: ${toolResults(r)[0].slice(0, 400)}` }
      : { toolCalls: [{ name: 'wissensdatenbank_suchen', args: { query: 'RMAN ORA-19809' } }] };
    const chat = (await itUser.post('/api/chats', { modelId })).id;
    const r = await itUser.chat(chat, { content: 'Why does RMAN fail?', modelId });
    expect(r.errors).toEqual([]);
    const tool = llm.chatRequests()[0].tools!.find((t) => t.function.name === 'wissensdatenbank_suchen')!;
    expect(tool.function.description).toContain('IT operations');
    expect(JSON.parse(r.toolResults[0].output).treffer[0]).toMatchObject({ nr: 1, titel: 'rman-runbook.md', sammlung: 'IT operations', quelle: 'Textfassung' });
    const sys = llm.chatRequests()[0].messages[0];
    expect(JSON.stringify(sys)).toContain('wissensdatenbank_suchen');

    const [entry] = await admin.get('/api/admin/audit?action=knowledge.search&limit=1');
    expect(entry.details).toMatchObject({ via: 'chat', hits: expect.any(Number), collections: expect.arrayContaining(['IT operations']) });
  });

  it('offers only accessible collections', async () => {
    await hrUser.chat((await hrUser.post('/api/chats', { modelId })).id, { content: 'hi', modelId });
    const tool = llm.chatRequests()[0].tools!.find((t) => t.function.name === 'wissensdatenbank_suchen')!;
    expect(tool.function.description).toContain('Handbook');
    expect(tool.function.description).not.toContain('IT operations');
  });
});

describe('knowledge base as MCP server (/mcp)', () => {
  it('works with a personal access token and the user\'s permissions', async () => {
    const t = await itUser.post('/api/tokens', { name: 'IT test client', expiresInDays: 30 });
    expect(t.token).toMatch(/^ap_/);
    const client = await mcpClient(`${portalUrl()}/mcp`, t.token);
    try {
      const names = (await client.listTools()).tools.map((x) => x.name).sort();
      expect(names).toEqual(['dokument_lesen', 'sammlungen_auflisten', 'wissensdatenbank_suchen']);
      const cols = mcpText(await client.callTool({ name: 'sammlungen_auflisten', arguments: {} }));
      expect(cols).toContain('IT operations');
      const hits = mcpText(await client.callTool({ name: 'wissensdatenbank_suchen', arguments: { query: 'ORA-19809' } }));
      expect(hits).toContain('rman-runbook.md');
    } finally {
      await client.close();
    }

    await itUser.del(`/api/tokens/${t.id}`);
    await expect(mcpClient(`${portalUrl()}/mcp`, t.token)).rejects.toThrow(/401|Unauthorized|token/i);
  });

  it('rejects requests without a valid token', async () => {
    const res = await fetch(`${portalUrl()}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ap_invalid' }, body: '{}' });
    expect(res.status).toBe(401);
    const [entry] = await admin.get('/api/admin/audit?action=token.auth_failed&limit=1');
    expect(entry.success).toBe(false);
  });
});
