/**
 * API tests: the real Express app against an in-process PostgreSQL (PGlite + pgvector) and the scripted
 * OpenAI-compatible mock LLM of the integration tests (chat, tool calls, embeddings). No Docker needed.
 * The tests in this file build on each other (users, provider, collections, chats) and run in order.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, statusOf, startApp } from './support/app.js';
import { MockLlm, lastUser, toolResults, type ChatRequest } from './integration/mockLlm.js';

vi.mock('../src/db/index.js', async () => (await import('./support/pgdb.js')).testDb());
// PGlite start, migrations and background syncs take longer than unit tests, especially with coverage
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const { config } = await import('../src/config.js');
const { bootstrapAdmin } = await import('../src/app.js');
const { convertLegacyAuditToEnglish } = await import('../src/audit.js');
const { db } = await import('../src/db/index.js');
const { knowledgeArticles, knowledgeDocuments, knowledgeSources, users } = await import('../src/db/schema.js');
const { getEmbedder } = await import('../src/knowledge/embeddings.js');
const { indexDocument } = await import('../src/knowledge/store.js');

const ADMIN_PW = 'admin-pass-123456';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-portal-api-'));
const shares = path.join(tmp, 'shares');
const staticDir = path.join(tmp, 'web');
const llm = new MockLlm();
let app: Awaited<ReturnType<typeof startApp>>;
let admin: Client;
let bob: Client;
const ids: Record<string, string> = {};

const until = async (cond: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`timeout: ${what}`);
};
const form = (files: [string, string, string][]) => {
  const fd = new FormData();
  for (const [name, type, content] of files) fd.append('files', new Blob([content], { type }), name);
  return fd;
};

beforeAll(async () => {
  fs.mkdirSync(path.join(shares, 'it', 'alt'), { recursive: true });
  fs.writeFileSync(path.join(shares, 'it', 'backup.md'), '# Backup\n\nDas RMAN Backup läuft nachts um 2 Uhr. Bei ORA-19809 ist die FRA voll.');
  fs.writeFileSync(path.join(shares, 'it', 'alt', 'vpn.txt'), 'VPN Client Einrichtung mit Zertifikat.');
  fs.writeFileSync(path.join(shares, 'it', 'bild.png'), 'not indexed');
  fs.mkdirSync(staticDir);
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<html><head><title>AI Portal</title></head><body><div id="root"></div></body></html>');
  Object.assign(config, { BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PW, KNOWLEDGE_FS_ROOT: shares, STATIC_DIR: staticDir });
  await llm.start();
  app = await startApp();
  config.PUBLIC_URL = app.base;
  admin = new Client(app.base);
  bob = new Client(app.base, 'en');
});

afterAll(async () => {
  await app?.close();
  await llm.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('startup', () => {
  it('creates the bootstrap admin once, also when replicas start at the same time', async () => {
    await Promise.all([bootstrapAdmin(), bootstrapAdmin()]);
    await bootstrapAdmin();
    expect((await db.select().from(users)).map((u) => u.username)).toEqual(['admin']);
    await convertLegacyAuditToEnglish();
  });

  it('health, web UI with SPA fallback, unknown API paths', async () => {
    expect(await (await fetch(app.base + '/healthz')).json()).toEqual({ ok: true });
    expect(await (await fetch(app.base + '/readyz')).json()).toEqual({ ok: true });
    const page = await fetch(app.base + '/chat/123');
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('AI Portal');
    expect(await statusOf(admin.get('/api/nope'))).toBe(404);
  });
});

describe('sign-in and sessions', () => {
  it('rejects wrong passwords, requests without CSRF header and anonymous access', async () => {
    expect(await admin.get('/api/auth/config')).toEqual({ local: true, registration: false, ldap: false, oidc: null });
    expect(await statusOf(admin.get('/api/auth/me'))).toBe(401);
    expect(await statusOf(admin.login('admin', 'wrong-password'))).toBe(401);
    const noCsrf = await fetch(app.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noCsrf.status).toBe(403);
    expect(await statusOf(admin.get('/api/chats'))).toBe(401);
  });

  it('signs in the admin', async () => {
    await admin.login('admin', ADMIN_PW);
    expect(await admin.get('/api/auth/me')).toMatchObject({ username: 'admin', role: 'admin', authSource: 'local' });
  });
});

describe('administration', () => {
  it('manages users; a user cannot open the administration', async () => {
    const u = await admin.post('/api/admin/users', { username: 'Bob', password: 'bob-password-1234', displayName: 'Bob', role: 'user' });
    ids.bob = u.id;
    expect(await statusOf(admin.post('/api/admin/users', { username: 'bob', password: 'bob-password-1234' }))).toBe(409);
    expect(await statusOf(admin.post('/api/admin/users', { username: 'x', password: 'short' }))).toBe(400);
    await admin.patch(`/api/admin/users/${ids.bob}`, { groups: ['IT-Team'], displayName: 'Bob Beispiel' });
    expect((await admin.get('/api/admin/users')).find((x: { id: string }) => x.id === ids.bob)).toMatchObject({ username: 'bob', groups: ['IT-Team'] });
    const me = await admin.get('/api/auth/me');
    expect(await statusOf(admin.patch(`/api/admin/users/${me.id}`, { role: 'user' }))).toBe(400);
    expect(await statusOf(admin.del(`/api/admin/users/${me.id}`))).toBe(400);

    await bob.login('bob', 'bob-password-1234');
    expect(await statusOf(bob.get('/api/admin/users'))).toBe(403);
  });

  it('manages providers and models; users only see enabled models', async () => {
    const p = await admin.post('/api/admin/providers', { name: 'Mock', type: 'openai_compatible', baseUrl: llm.url, secret: { apiKey: 'sk-test' } });
    ids.provider = p.id;
    const list = await admin.get('/api/admin/providers');
    expect(list[0]).toMatchObject({ name: 'Mock', hasSecret: true });
    expect(JSON.stringify(list)).not.toContain('sk-test');
    expect((await admin.get(`/api/admin/providers/${p.id}/available-models`)).source).toBe('presets');
    expect((await admin.get('/api/admin/model-presets')).bedrock.length).toBeGreaterThan(0);
    await admin.patch(`/api/admin/providers/${p.id}`, { name: 'Mock LLM' });

    const m = await admin.post('/api/admin/models', { providerId: p.id, modelId: 'mock-1', displayName: 'Mock 1', isDefault: true });
    const m2 = await admin.post('/api/admin/models', { providerId: p.id, modelId: 'mock-2', displayName: 'Mock 2' });
    ids.model = m.id;
    await admin.patch(`/api/admin/models/${m2.id}`, { enabled: false });
    expect((await bob.get('/api/models')).map((x: { displayName: string }) => x.displayName)).toEqual(['Mock 1']);
    await admin.del(`/api/admin/models/${m2.id}`);
    expect(await statusOf(admin.post('/api/admin/providers', { name: 'x', type: 'bedrock', options: { roleArn: 'nope' } }))).toBe(400);
    const tmpP = await admin.post('/api/admin/providers', { name: 'Tmp', type: 'anthropic' });
    await admin.del(`/api/admin/providers/${tmpP.id}`);
    expect(await statusOf(admin.del(`/api/admin/providers/${tmpP.id}`))).toBe(404);
  });
});

describe('knowledge base', () => {
  it('configures and probes the embedding model', async () => {
    expect((await admin.get('/api/admin/knowledge/embedding')).settings).toBeNull();
    const r = await admin.put('/api/admin/knowledge/embedding', { providerId: ids.provider, modelId: 'mock-embed' });
    expect(r).toMatchObject({ ok: true, dim: 64 });
  });

  it('indexes uploads into a public collection and finds them with hybrid search', async () => {
    const pub = await admin.post('/api/admin/knowledge/collections', { name: 'Handbuch', description: 'Für alle', public: true });
    ids.public = pub.id;
    const res = await admin.call('POST', `/api/admin/knowledge/collections/${pub.id}/upload`,
      form([['urlaub.md', 'text/markdown', '# Urlaub\n\nUrlaubsanträge stellst du im Personalportal bis zum 15. des Vormonats.']]));
    expect(res).toEqual([{ filename: 'urlaub.md', result: 'added' }]);
    const hits = await bob.get('/api/knowledge/search?q=Urlaubsantrag Personalportal');
    expect(hits[0]).toMatchObject({ title: 'urlaub.md', collection: 'Handbuch' });
    ids.uploadDoc = hits[0].documentId;
    // provenance is recorded but only returned on request
    expect(hits[0]).not.toHaveProperty('meta');
    const withMeta = await bob.get('/api/knowledge/search?q=Urlaubsantrag Personalportal&meta=1');
    expect(withMeta[0].meta).toMatchObject({ source: { name: 'Uploads', type: 'upload' }, author: 'Administrator' });
    expect(Date.now() - Date.parse(withMeta[0].meta.modifiedAt)).toBeLessThan(60_000);
    expect(await bob.get(`/api/knowledge/documents/${ids.uploadDoc}/meta`)).toMatchObject({
      title: 'urlaub.md', author: 'Administrator', source: { name: 'Uploads', type: 'upload' },
    });
    expect(await statusOf(new Client(app.base).get(`/api/knowledge/documents/${ids.uploadDoc}/meta`))).toBe(401);
    const open = await bob.raw('GET', `/api/knowledge/documents/${hits[0].documentId}/open`);
    expect(await open.text()).toContain('Personalportal');
    expect((await bob.get('/api/knowledge/collections')).collections.map((c: { name: string }) => c.name)).toEqual(['Handbuch']);
  });

  it('syncs a file-share source into a group collection', async () => {
    const it = await admin.post('/api/admin/knowledge/collections', { name: 'IT-Betrieb', allowedGroups: ['IT-Team'] });
    ids.it = it.id;
    expect(await statusOf(admin.post('/api/admin/knowledge/sources', { collectionId: it.id, type: 'filesystem', name: 'x', config: { path: '../etc' } }))).toBe(400);
    const src = await admin.post('/api/admin/knowledge/sources', {
      collectionId: it.id, type: 'filesystem', name: 'Share IT', config: { path: 'it', urlPrefix: 'file://fs/it' }, syncIntervalMinutes: 0,
    });
    ids.source = src.id;
    await admin.post(`/api/admin/knowledge/sources/${src.id}/sync`);
    const source = async () => (await admin.get('/api/admin/knowledge/collections'))
      .find((c: { id: string }) => c.id === it.id).sources.find((s: { id: string }) => s.id === src.id);
    await until(async () => (await source()).lastStatus === 'ok', 'sync');
    expect((await source()).lastStats).toMatchObject({ added: 2, errors: 0 });

    const docs = await admin.get(`/api/admin/knowledge/sources/${src.id}/documents`);
    expect(docs.map((d: { title: string }) => d.title).sort()).toEqual(['alt/vpn.txt', 'backup.md']);
    // bob is in IT-Team -> sees the collection; the hit links to the file share
    const hits = await bob.get('/api/knowledge/search?q=ORA-19809 FRA');
    expect(hits[0]).toMatchObject({ title: 'backup.md', collection: 'IT-Betrieb' });
    // file shares have no author, but the file's mtime is the last-change time
    const fileMeta = await bob.get(`/api/knowledge/documents/${hits[0].documentId}/meta`);
    expect(fileMeta).toMatchObject({ author: null, source: { name: 'Share IT', type: 'filesystem' } });
    expect(Date.parse(fileMeta.modifiedAt)).toBe(fs.statSync(path.join(shares, 'it', 'backup.md')).mtime.getTime());
    const open = await bob.raw('GET', `/api/knowledge/documents/${hits[0].documentId}/open`);
    expect(open.status).toBe(302);

    // unchanged files are skipped on the next sync; a removed file disappears
    fs.rmSync(path.join(shares, 'it', 'alt', 'vpn.txt'));
    await admin.post(`/api/admin/knowledge/sources/${src.id}/sync`);
    await until(async () => (await source()).lastStats?.removed === 1, 'second sync');
    expect((await source()).lastStats).toMatchObject({ unchanged: 1, removed: 1 });

    await admin.patch(`/api/admin/knowledge/sources/${src.id}`, { name: 'Share IT (neu)', config: { path: 'it' } });
    await admin.del(`/api/admin/knowledge/documents/${ids.uploadDoc}`);
    expect(await statusOf(bob.get(`/api/knowledge/documents/${ids.uploadDoc}/open`))).toBe(404);
    await admin.patch(`/api/admin/knowledge/collections/${it.id}`, { description: 'nur IT' });
  });
});

describe('article contributions', () => {
  it('requires authentication and collection access before accepting an article', async () => {
    const anonymous = new Client(app.base);
    expect(await statusOf(anonymous.post('/api/knowledge/articles', { collectionId: ids.public, title: 'x', body: 'x' }))).toBe(401);
    expect(await statusOf(bob.post('/api/knowledge/articles', { collectionId: ids.public, title: '', body: 'x' }))).toBe(400);
    const privateCollection = await admin.post('/api/admin/knowledge/collections', { name: 'Nur Admins' });
    expect(await statusOf(bob.post('/api/knowledge/articles', { collectionId: privateCollection.id, title: 'Secret', body: 'Not allowed' }))).toBe(404);
    expect(await statusOf(bob.get('/api/admin/knowledge/articles'))).toBe(403);
  });

  it('holds submissions for admin review and indexes only approved articles', async () => {
    const proposed = { collectionId: ids.public, title: 'VPN Anleitung', body: 'VPN Zugang über das Mitarbeiterportal beantragen.' };
    const first = await bob.post('/api/knowledge/articles', proposed);
    const second = await bob.post('/api/knowledge/articles', { ...proposed, title: 'Veraltete Anleitung' });
    expect(first.status).toBe('pending');
    expect((await bob.get('/api/knowledge/articles')).map((a: { status: string }) => a.status)).toEqual(['pending', 'pending']);
    // Even a document indexed during an interrupted review must not leak before approval.
    const [source] = await db.select().from(knowledgeSources)
      .where(and(eq(knowledgeSources.collectionId, ids.public), eq(knowledgeSources.type, 'upload')));
    expect(await indexDocument(source, {
      externalId: `article:${first.id}`, title: proposed.title, filename: 'vpn.md', text: proposed.body,
    }, (await getEmbedder())!)).toBe('added');
    const [unapproved] = await db.select().from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.sourceId, source.id), eq(knowledgeDocuments.externalId, `article:${first.id}`)));
    expect(await statusOf(bob.get(`/api/knowledge/documents/${unapproved.id}/open`))).toBe(404);
    expect((await bob.get('/api/knowledge/search?q=Mitarbeiterportal VPN')).some((h: { title: string }) => h.title === proposed.title)).toBe(false);
    expect(await statusOf(bob.post(`/api/admin/knowledge/articles/${first.id}/approve`))).toBe(403);

    const queue = await admin.get('/api/admin/knowledge/articles');
    expect(queue).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id, body: proposed.body, author: 'bob' })]));
    const approved = await admin.post(`/api/admin/knowledge/articles/${first.id}/approve`);
    expect(approved.status).toBe('approved');
    expect(await bob.get(`/api/knowledge/documents/${approved.documentId}/meta`)).toMatchObject({ author: 'Bob Beispiel' });
    expect(await statusOf(admin.post(`/api/admin/knowledge/articles/${first.id}/approve`))).toBe(409);
    expect((await bob.get('/api/knowledge/search?q=Mitarbeiterportal VPN')).some((h: { title: string }) => h.title === proposed.title)).toBe(true);
    const open = await bob.raw('GET', `/api/knowledge/documents/${approved.documentId}/open`);
    expect(await open.text()).toContain(proposed.body);

    expect((await admin.post(`/api/admin/knowledge/articles/${second.id}/reject`)).status).toBe('rejected');
    expect(await statusOf(admin.post(`/api/admin/knowledge/articles/${second.id}/approve`))).toBe(409);
    expect((await admin.get('/api/admin/knowledge/articles')).some((a: { id: string }) => a.id === second.id)).toBe(false);
    expect((await bob.get('/api/knowledge/articles')).map((a: { status: string }) => a.status)).toEqual(['rejected', 'approved']);
    expect((await bob.get('/api/knowledge/search?q=Veraltete Anleitung')).some((h: { title: string }) => h.title === 'Veraltete Anleitung')).toBe(false);
  });
});

describe('article review edge cases', () => {
  it('rejects malformed ids, lets admins reject stale reviews, and caps open submissions', async () => {
    expect(await statusOf(admin.post('/api/admin/knowledge/articles/not-a-uuid/reject'))).toBe(400);

    const stale = await bob.post('/api/knowledge/articles', { collectionId: ids.public, title: 'Hängt', body: 'Blieb im Review stecken.' });
    await db.update(knowledgeArticles).set({ status: 'reviewing', reviewedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(knowledgeArticles.id, stale.id));
    expect((await admin.get('/api/admin/knowledge/articles')).some((a: { id: string }) => a.id === stale.id)).toBe(true);
    expect((await admin.post(`/api/admin/knowledge/articles/${stale.id}/reject`)).status).toBe('rejected');

    const fresh = await bob.post('/api/knowledge/articles', { collectionId: ids.public, title: 'Läuft', body: 'Wird gerade geprüft.' });
    await db.update(knowledgeArticles).set({ status: 'reviewing', reviewedAt: new Date() }).where(eq(knowledgeArticles.id, fresh.id));
    expect(await statusOf(admin.post(`/api/admin/knowledge/articles/${fresh.id}/reject`))).toBe(409);
    await db.update(knowledgeArticles).set({ status: 'rejected' }).where(eq(knowledgeArticles.id, fresh.id));

    let created = 0;
    while (created < 20 && await statusOf(bob.post('/api/knowledge/articles', { collectionId: ids.public, title: `Spam ${created}`, body: 'x' })) === 200) created++;
    expect(created).toBe(10);
    expect(await statusOf(bob.post('/api/knowledge/articles', { collectionId: ids.public, title: 'Zu viel', body: 'x' }))).toBe(429);
  });
});

describe('registration and profile', () => {
  const reg = { displayName: 'Erika Muster', email: 'erika@example.com', username: 'Erika', password: 'erika-pass-123456' };

  it('is closed unless enabled and then requires admin approval before login', async () => {
    const anonymous = new Client(app.base);
    expect((await anonymous.get('/api/auth/config')).registration).toBe(false);
    expect(await statusOf(anonymous.post('/api/auth/register', reg))).toBe(404);

    config.REGISTRATION_ENABLED = true;
    try {
      expect((await anonymous.get('/api/auth/config')).registration).toBe(true);
      expect(await statusOf(anonymous.post('/api/auth/register', { ...reg, email: 'nope' }))).toBe(400);
      expect(await statusOf(anonymous.post('/api/auth/register', { ...reg, password: 'short' }))).toBe(400);
      await anonymous.post('/api/auth/register', reg);
      expect(await statusOf(anonymous.post('/api/auth/register', { ...reg, username: 'erika' }))).toBe(409);
    } finally { config.REGISTRATION_ENABLED = false; }

    const login = () => anonymous.post('/api/auth/login', { username: 'erika', password: reg.password, method: 'local' });
    await expect(login()).rejects.toMatchObject({ status: 401 });
    const listed = (await admin.get('/api/admin/users')).find((u: { username: string }) => u.username === 'erika');
    expect(listed).toMatchObject({ displayName: reg.displayName, email: reg.email, active: false, pendingApproval: true });

    await admin.patch(`/api/admin/users/${listed.id}`, { active: true });
    await login();
    const me = await anonymous.get('/api/auth/me');
    expect(me).toMatchObject({ username: 'erika', profileCompleted: true });
    expect((await admin.get('/api/admin/users')).find((u: { id: string }) => u.id === listed.id).pendingApproval).toBe(false);
  });

  it('asks new directory users once to confirm name and email, and the directory only fills gaps', async () => {
    const { upsertExternalUser } = await import('../src/auth/provision.js');
    const first = await upsertExternalUser({ source: 'ldap', externalId: 'cn=max', username: 'max', displayName: 'Max Mustermann', email: 'max@corp.example', roleFromIdp: null });
    expect(first).toMatchObject({ displayName: 'Max Mustermann', email: 'max@corp.example', profileCompleted: false });

    const session = new Client(app.base);
    session.cookie = `ap_session=${(await import('jsonwebtoken')).default.sign({ sub: first.id }, config.SESSION_SECRET)}`;
    expect((await session.get('/api/auth/me')).profileCompleted).toBe(false);
    expect(await statusOf(session.put('/api/auth/profile', { displayName: 'M', email: 'bad' }))).toBe(400);
    expect(await session.put('/api/auth/profile', { displayName: 'Maximilian Mustermann', email: 'max.m@corp.example' }))
      .toMatchObject({ displayName: 'Maximilian Mustermann', profileCompleted: true });
    expect(await statusOf(new Client(app.base).put('/api/auth/profile', { displayName: 'Xx', email: 'x@y.de' }))).toBe(401);

    const again = await upsertExternalUser({ source: 'ldap', externalId: 'cn=max', username: 'max', displayName: null, email: null, roleFromIdp: null });
    expect(again).toMatchObject({ displayName: 'Maximilian Mustermann', email: 'max.m@corp.example', profileCompleted: true });
    const synced = await upsertExternalUser({ source: 'ldap', externalId: 'cn=max', username: 'max', displayName: 'Max Mustermann', email: 'max@corp.example', roleFromIdp: null });
    expect(synced).toMatchObject({ displayName: 'Max Mustermann', email: 'max@corp.example' });
  });
});

describe('plugins', () => {
  it('lists deployed plugins, allows admins to disable them, and gates their API and chat tools', async () => {
    const anonymous = new Client(app.base);
    expect(await statusOf(anonymous.get('/api/plugins'))).toBe(401);
    expect(await statusOf(bob.get('/api/admin/plugins'))).toBe(403);
    expect(await statusOf(bob.patch('/api/admin/plugins/text-stats', { enabled: false }))).toBe(403);
    expect(await statusOf(admin.patch('/api/admin/plugins/text-stats', { enabled: 'false' }))).toBe(400);
    expect(await statusOf(admin.patch('/api/admin/plugins/no-such-plugin', { enabled: false }))).toBe(404);
    expect((await admin.get('/api/admin/plugins'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'text-stats', enabled: false, hasPage: true }),
    ]));
    expect(await bob.get('/api/plugins')).toEqual([]);
    expect(await statusOf(bob.post('/api/plugins/text-stats/count', { text: 'Hallo Welt!' }))).toBe(404);
    await admin.patch('/api/admin/plugins/text-stats', { enabled: true });
    expect((await bob.post('/api/plugins/text-stats/count', { text: 'Hallo Welt!' })))
      .toEqual({ words: 2, characters: 11 });
    expect(await statusOf(bob.post('/api/plugins/text-stats/count', { text: '' }))).toBe(400);
    expect(await statusOf(bob.post('/api/plugins/text-stats/count', { text: '  ' }))).toBe(400);

    llm.reset();
    llm.script = (r: ChatRequest) => toolResults(r).length
      ? { text: `Result: ${toolResults(r).join(' ')}` }
      : { toolCalls: [{ name: 'plugin_text_stats__count_text', args: { text: 'one two' } }] };
    const chat = await bob.post('/api/chats', { modelId: ids.model });
    const events = await bob.chat(chat.id, { content: 'Count the words', modelId: ids.model, useMcp: false, useKnowledge: false });
    expect(events.find((e) => e.t === 'tool-result').output).toContain('"words":2');
    expect(llm.chatRequests()[0].tools?.some((x) => x.function.name === 'plugin_text_stats__count_text')).toBe(true);

    await admin.patch('/api/admin/plugins/text-stats', { enabled: false });
    expect((await admin.get('/api/admin/plugins'))[0]).toMatchObject({ enabled: false });
    expect(await bob.get('/api/plugins')).toEqual([]);
    expect(await statusOf(bob.post('/api/plugins/text-stats/count', { text: 'hello' }))).toBe(404);
    llm.reset();
    llm.script = () => ({ text: 'No plugin tool' });
    const disabledChat = await bob.post('/api/chats', { modelId: ids.model });
    await bob.chat(disabledChat.id, { content: 'Count the words', modelId: ids.model, useMcp: false, useKnowledge: false });
    expect(llm.chatRequests()[0].tools?.some((x) => x.function.name === 'plugin_text_stats__count_text') ?? false).toBe(false);

    await admin.patch('/api/admin/plugins/text-stats', { enabled: true });
    expect((await bob.get('/api/plugins'))[0]).toMatchObject({ id: 'text-stats', enabled: true });
    expect((await bob.post('/api/plugins/text-stats/count', { text: 'back on' })).words).toBe(2);
    llm.reset();
  });
});

describe('files and chat', () => {
  it('uploads attachments and serves them only to their owner', async () => {
    const up = await bob.call('POST', '/api/files', form([['fehler.log', 'text/plain', 'ERROR ORA-19809 at 02:00'], ['bild.png', 'image/png', 'png']]));
    expect(up.map((f: { hasText: boolean; isImage: boolean }) => [f.hasText, f.isImage])).toEqual([[true, false], [false, true]]);
    ids.attachment = up[0].id;
    expect(await (await bob.raw('GET', `/api/files/${up[0].id}`)).text()).toBe('ERROR ORA-19809 at 02:00');
    expect(await statusOf(admin.get(`/api/files/${up[0].id}`))).toBe(404);
    expect(await statusOf(bob.call('POST', '/api/files', new FormData()))).toBe(400);
  });

  it('streams an answer that uses the knowledge base, and stores it', async () => {
    llm.script = (r: ChatRequest) => {
      if (r.tools?.some((t) => t.function.name === 'wissensdatenbank_suchen') && !toolResults(r).length) {
        return { toolCalls: [{ name: 'wissensdatenbank_suchen', args: { query: 'ORA-19809' } }] };
      }
      return { text: `Antwort zu: ${lastUser(r).slice(-30)} – Quellen: ${toolResults(r).length}` };
    };
    const chat = await bob.post('/api/chats', { modelId: ids.model });
    ids.chat = chat.id;
    const events = await bob.chat(chat.id, { content: 'Warum schlägt das Backup fehl?', modelId: ids.model, attachmentIds: [ids.attachment] });
    const types = events.map((e) => e.t);
    expect(types).toEqual(expect.arrayContaining(['tool-call', 'tool-result', 'text', 'done']));
    expect(events.find((e) => e.t === 'tool-result').output).toContain('backup.md');
    const done = events.at(-1);
    expect(done).toMatchObject({ t: 'done', title: 'Warum schlägt das Backup fehl?' });
    // the attachment went to the model, the system prompt mentions the knowledge base
    const req = llm.chatRequests()[0];
    expect(JSON.stringify(req.messages)).toContain('fehler.log');
    expect(JSON.stringify(req.messages[0])).toContain('wissensdatenbank_suchen');

    const stored = await bob.get(`/api/chats/${chat.id}`);
    expect(stored.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(stored.messages[1].parts[0]).toMatchObject({ type: 'tool', name: 'wissensdatenbank_suchen' });
    expect(stored.attachments[0].filename).toBe('fehler.log');
  });

  it('reports provider errors, unknown attachments and unavailable models', async () => {
    llm.reset();
    llm.script = () => ({ status: 400, error: 'context length exceeded' });
    const events = await bob.chat(ids.chat, { content: 'Noch eine Frage', modelId: ids.model, useKnowledge: false, useMcp: false });
    expect(events.find((e) => e.t === 'error').message).toContain('context length exceeded');

    // provider errors arrive in English regardless of UI language; German UIs get known phrases translated back
    const deChat = await admin.post('/api/chats', { modelId: ids.model });
    const deEvents = await admin.chat(deChat.id, { content: 'Noch eine Frage', modelId: ids.model, useKnowledge: false, useMcp: false });
    expect(deEvents.find((e) => e.t === 'error').message).toBe('Kontextlänge überschritten (zu viele Token für dieses Modell)');
    await admin.del(`/api/chats/${deChat.id}`); // keep admin's chat list empty for the later assertion
    expect(await statusOf(bob.chat(ids.chat, { content: 'x', modelId: ids.model, attachmentIds: ['00000000-0000-0000-0000-000000000000'] }))).toBe(400);
    expect(await statusOf(bob.chat(ids.chat, { content: 'x', modelId: '00000000-0000-0000-0000-000000000000' }))).toBe(400);
    expect(await statusOf(bob.chat('00000000-0000-0000-0000-000000000000', { content: 'x', modelId: ids.model }))).toBe(404);
  });

  it('renames, lists and deletes chats', async () => {
    await bob.patch(`/api/chats/${ids.chat}`, { title: 'Backup-Analyse' });
    expect((await bob.get('/api/chats'))[0].title).toBe('Backup-Analyse');
    expect(await admin.get('/api/chats')).toEqual([]);
    await bob.del(`/api/chats/${ids.chat}`);
    expect(await statusOf(bob.get(`/api/chats/${ids.chat}`))).toBe(404);
  });
});

describe('knowledge base as MCP server and user MCP servers', () => {
  it('personal access tokens protect /mcp; the portal can use its own knowledge MCP server as a tool', async () => {
    const tok = await bob.post('/api/tokens', { name: 'Test', expiresInDays: 30 });
    expect(tok.token).toMatch(/^ap_/);
    expect((await bob.get('/api/tokens'))[0]).toMatchObject({ name: 'Test', prefix: tok.token.slice(0, 10) });
    expect((await fetch(app.base + '/mcp', { method: 'POST' })).status).toBe(401);
    expect((await fetch(app.base + '/mcp', { headers: { authorization: `Bearer ${tok.token}` } })).status).toBe(405);

    const srv = await bob.post('/api/mcp-servers', { name: 'Portal KB', url: `${app.base}/mcp`, headers: { Authorization: `Bearer ${tok.token}` } });
    expect(srv.headerNames).toEqual(['Authorization']);
    const test = await bob.post(`/api/mcp-servers/${srv.id}/test`);
    expect(test.tools.map((t: { name: string }) => t.name).sort()).toEqual(['dokument_lesen', 'sammlungen_auflisten', 'wissensdatenbank_suchen']);
    expect((await bob.get('/api/mcp-servers'))[0]).toMatchObject({ lastStatus: 'ok', toolCount: 3 });

    llm.reset();
    llm.script = (r: ChatRequest) => (toolResults(r).length
      ? { text: 'Fertig.' }
      : { toolCalls: [{ name: 'portal_kb__sammlungen_auflisten', args: {} }] });
    const chat = await bob.post('/api/chats', { modelId: ids.model });
    const events = await bob.chat(chat.id, { content: 'Welche Sammlungen gibt es?', modelId: ids.model, useKnowledge: false });
    expect(events.find((e) => e.t === 'mcp').status[0]).toMatchObject({ name: 'Portal KB', ok: true, tools: 3 });
    expect(events.find((e) => e.t === 'tool-result').output).toContain('IT-Betrieb');

    await bob.patch(`/api/mcp-servers/${srv.id}`, { enabled: false });
    await bob.del(`/api/mcp-servers/${srv.id}`);
    await bob.del(`/api/tokens/${tok.id}`);
    expect(await statusOf(bob.post('/api/mcp-servers', { name: 'x', url: 'ftp://x' }))).toBe(400);
  });
});

describe('audit log', () => {
  it('filters and exports the audit log', async () => {
    const rows = await admin.get('/api/admin/audit?action=chat.&limit=50');
    expect(rows.map((r: { action: string }) => r.action)).toEqual(expect.arrayContaining(['chat.prompt', 'chat.completion', 'chat.error']));
    expect((await admin.get('/api/admin/audit?user=bob')).every((r: { username: string }) => r.username === 'bob')).toBe(true);
    const csv = await (await admin.raw('GET', '/api/admin/audit?format=csv&action=auth.')).text();
    expect(csv.split('\n')[0]).toBe('ts,username,action,target_type,target_id,success,ip,details');
    expect(csv).toContain('auth.login_failed');
  });

  it('signs out; a deactivated user loses the session immediately', async () => {
    await admin.patch(`/api/admin/users/${ids.bob}`, { active: false });
    expect(await statusOf(bob.get('/api/auth/me'))).toBe(401);
    await admin.post('/api/auth/logout');
    expect(await statusOf(admin.get('/api/auth/me'))).toBe(401);
  });
});
