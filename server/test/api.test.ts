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
const { auditLog, knowledgeArticles, knowledgeDocuments, knowledgeSources, users } = await import('../src/db/schema.js');
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

describe('secrets are masked in the UI data and the audit log', () => {
  it('MCP server URLs with credentials, audit details, errors and source configs', async () => {
    const srv = await bob.post('/api/mcp-servers', {
      name: 'Masked', url: `${app.base}/mcp?api_key=URLSECRET1&page=2`, headers: { Authorization: 'Bearer HEADERSECRET1234' },
      oauth: { tokenUrl: 'https://idp.example/token?client_secret=QSECRET2', clientId: 'cid', clientSecret: 'OAUTHSECRET3' },
    });
    const list = JSON.stringify(await bob.get('/api/mcp-servers'));
    for (const leaked of ['URLSECRET1', 'HEADERSECRET1234', 'OAUTHSECRET3']) expect(list, leaked).not.toContain(leaked);
    expect(srv.url).toContain('api_key=***');
    expect(srv.url).toContain('page=2');
    const audit = JSON.stringify(await admin.get('/api/admin/audit?action=mcp.create&limit=50'));
    for (const leaked of ['URLSECRET1', 'HEADERSECRET1234', 'OAUTHSECRET3']) expect(audit, leaked).not.toContain(leaked);
    expect(audit).toContain('api_key=***');
    await bob.del(`/api/mcp-servers/${srv.id}`);

    // knowledge source configuration as shown to admins
    const col = await admin.post('/api/admin/knowledge/collections', { name: 'Masked sources' });
    await admin.post('/api/admin/knowledge/sources', {
      collectionId: col.id, type: 'http', name: 'Wiki', syncIntervalMinutes: 0,
      config: { startUrls: ['http://user:URLPW4@127.0.0.1:9/wiki/?token=QTOKEN5'] }, secret: { Authorization: 'Bearer SRCSECRET6789' },
    });
    const shown = JSON.stringify((await admin.get('/api/admin/knowledge/collections')).find((c: { id: string }) => c.id === col.id));
    for (const leaked of ['URLPW4', 'QTOKEN5', 'SRCSECRET6789']) expect(shown, leaked).not.toContain(leaked);
    expect(shown).toContain('token=***');
    expect(JSON.stringify(await admin.get('/api/admin/audit?action=knowledge.source.create&limit=50'))).not.toContain('QTOKEN5');
    await admin.del(`/api/admin/knowledge/collections/${col.id}`);
  });
});

describe('web and Confluence source configuration', () => {
  it('validates configs, subpage settings and header names on create and update', async () => {
    const col = await admin.post('/api/admin/knowledge/collections', { name: 'Source validation' });
    const create = (type: string, config: object, secret?: object) =>
      admin.post('/api/admin/knowledge/sources', { collectionId: col.id, type, name: 'v', config, secret, syncIntervalMinutes: 0 });
    const status = (type: string, config: object, secret?: object) => statusOf(create(type, config, secret));

    expect(await status('http', { startUrls: [] })).toBe(400);
    expect(await status('http', { startUrls: ['ftp://x.example/y'] })).toBe(400);
    expect(await status('http', { startUrls: ['https://x.example/'], maxPages: 0 })).toBe(400);
    expect(await status('http', { startUrls: ['https://x.example/'], maxPages: 5001 })).toBe(400);
    expect(await status('http', { startUrls: ['https://x.example/'], maxDepth: 99 })).toBe(400);
    expect(await status('http', { startUrls: ['https://x.example/'] }, { 'bad header': 'v' })).toBe(400);
    expect(await status('confluence', { baseUrl: 'https://c.example', deployment: 'server', spaceKeys: [] })).toBe(400); // neither spaces nor pages
    expect(await status('confluence', { baseUrl: 'https://c.example', deployment: 'server', spaceKeys: [], rootPageIds: ['abc'] })).toBe(400);
    expect(await status('confluence', { baseUrl: 'https://c.example', deployment: 'server', spaceKeys: [], rootPageIds: ['123'], maxDepth: -1 })).toBe(400);

    // valid: page tree without space keys, with subpage settings
    const conf = await create('confluence', { baseUrl: 'https://c.example', deployment: 'server', rootPageIds: ['123', '456'], includeSubpages: false, maxDepth: 2 }, { token: 'pat' });
    const web = await create('http', { startUrls: ['https://wiki.example/it/'], includeSubpages: true, maxDepth: 0, maxPages: 500, pathPrefix: '/it/', exclude: ['/login'] }, { Authorization: 'Bearer one' });
    const shown = async () => (await admin.get('/api/admin/knowledge/collections')).find((c: { id: string }) => c.id === col.id).sources as { id: string; config: Record<string, unknown>; hasSecret: boolean }[];
    expect((await shown()).find((x) => x.id === conf.id)!.config).toMatchObject({ spaceKeys: [], rootPageIds: ['123', '456'], includeSubpages: false, maxDepth: 2 });
    expect((await shown()).find((x) => x.id === web.id)).toMatchObject({ hasSecret: true, config: { startUrls: ['https://wiki.example/it/'], maxPages: 500, pathPrefix: '/it/' } });

    // update: config is validated again, header names too; a valid change applies
    const patch = (id: string, body: object) => statusOf(admin.patch(`/api/admin/knowledge/sources/${id}`, body));
    expect(await patch(web.id, { config: { startUrls: ['ftp://x.example/'] } })).toBe(400);
    expect(await patch(web.id, { secret: { 'bad header': 'x' } })).toBe(400);
    expect(await patch(web.id, { config: { startUrls: ['https://wiki.example/ops/'], includeSubpages: false }, secret: { Authorization: 'Bearer two' } })).toBe(200);
    expect((await shown()).find((x) => x.id === web.id)!.config).toMatchObject({ startUrls: ['https://wiki.example/ops/'], includeSubpages: false });
    expect(await patch('00000000-0000-4000-8000-000000000000', { name: 'x' })).toBe(404);
    await admin.del(`/api/admin/knowledge/collections/${col.id}`);
  });
});

describe('knowledge source updates: automatic, manual, external, full replace', () => {
  const dir = path.join(shares, 'upd');
  const file = (name: string, text: string, mtime?: Date) => {
    const f = path.join(dir, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    if (mtime) fs.utimesSync(f, mtime, mtime);
  };
  let colId: string;
  let sourceId: string;
  type Src = { id: string; lastSyncAt: string | null; lastStatus: string | null; lastError: string | null; lastStats: Record<string, number> | null; replaceOnSync: boolean; hasTrigger: boolean; triggerTokenCreatedAt: string | null; syncIntervalMinutes: number; type: string; hookUrl: string | null };
  const sourceOf = async (id: string) => ((await admin.get('/api/admin/knowledge/collections')) as { sources: Src[] }[]).flatMap((c) => c.sources).find((x) => x.id === id)!;
  /** Waits until a run that started after `before` is finished. */
  const finished = async (id: string, before: string | null) => {
    for (let i = 0; i < 150; i++) {
      const x = await sourceOf(id);
      if (x.lastSyncAt !== before && x.lastStatus !== 'running') return x;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timeout: update did not finish');
  };
  const run = async (body?: object) => {
    const before = (await sourceOf(sourceId)).lastSyncAt;
    await admin.post(`/api/admin/knowledge/sources/${sourceId}/sync`, body);
    return finished(sourceId, before);
  };
  const posix = (t: string) => t.split(path.sep).join('/'); // document titles are paths relative to the source folder
  const docsOf = async () => (await admin.get(`/api/admin/knowledge/sources/${sourceId}/documents`)) as { id: string; title: string }[];
  const titles = async () => (await docsOf()).map((d) => posix(d.title)).sort();
  /** The stored text of a document as a user reads it (document view of the public collection). */
  const textOf = async (title: string) => {
    const d = (await docsOf()).find((x) => posix(x.title) === title)!;
    return (await bob.raw('GET', `/api/knowledge/documents/${d.id}/open`)).text();
  };
  const hook = (id: string, init: { token?: string; header?: 'bearer' | 'x'; body?: unknown } = {}) =>
    fetch(`${app.base}/api/hooks/knowledge/${id}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(init.token ? (init.header === 'x' ? { 'x-trigger-token': init.token } : { authorization: `Bearer ${init.token}` }) : {}),
      },
      body: JSON.stringify(init.body ?? {}),
    });

  beforeAll(async () => {
    const old = new Date('2024-01-01T00:00:00Z');
    file('a.md', '# A\n\nDer Spezialbegriff lautet quarzglas und kommt nur hier vor.', old);
    file('sub/b.md', '# B\n\nUnterseite mit dem Begriff palladium.', old);
    colId = (await admin.post('/api/admin/knowledge/collections', { name: 'Update modes', public: true })).id;
    sourceId = (await admin.post('/api/admin/knowledge/sources', {
      collectionId: colId, type: 'filesystem', name: 'Updates', config: { path: 'upd' }, syncIntervalMinutes: 0,
    })).id;
  });

  it('default is incremental: unchanged documents are skipped, even if their content differs behind the same version', async () => {
    expect((await run()).lastStats).toMatchObject({ added: 2, updated: 0, unchanged: 0 });
    expect(await titles()).toEqual(['a.md', 'sub/b.md']);
    expect(await textOf('a.md')).toContain('quarzglas');
    // same size, same mtime -> the source reports "no change"
    file('a.md', '# A\n\nDer Spezialbegriff lautet bleiglanz und kommt nur hier vor.', new Date('2024-01-01T00:00:00Z'));
    expect((await run()).lastStats).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    expect(await textOf('a.md')).toContain('quarzglas'); // still the old content
    expect(await textOf('a.md')).not.toContain('bleiglanz');
    expect((await sourceOf(sourceId)).replaceOnSync).toBe(false);
  });

  it('a full replace overwrites the stored content of every document in place, subpages included', async () => {
    const before = (await admin.get(`/api/admin/knowledge/sources/${sourceId}/documents`)) as { id: string }[];
    expect((await run({ replace: true })).lastStats).toMatchObject({ added: 0, updated: 2, unchanged: 0, removed: 0 });
    expect(await textOf('a.md')).toContain('bleiglanz'); // new content
    expect(await textOf('a.md')).not.toContain('quarzglas'); // old content gone
    // replaced in place: same document records, no duplicates
    const after = (await admin.get(`/api/admin/knowledge/sources/${sourceId}/documents`)) as { id: string }[];
    expect(after.map((d) => d.id).sort()).toEqual(before.map((d) => d.id).sort());
    const audited = (await admin.get('/api/admin/audit?action=knowledge.sync&limit=5')) as { details: { replace?: boolean; trigger?: string } }[];
    expect(audited[0].details).toMatchObject({ trigger: 'manual', replace: true });
  });

  it('replaceOnSync makes every update a full replace; a run can override the setting; documents that are gone are removed', async () => {
    expect((await admin.patch(`/api/admin/knowledge/sources/${sourceId}`, { replaceOnSync: true }).then(() => sourceOf(sourceId))).replaceOnSync).toBe(true);
    expect((await run()).lastStats).toMatchObject({ updated: 2, unchanged: 0 });
    expect((await run({ replace: false })).lastStats).toMatchObject({ updated: 0, unchanged: 2 }); // override: incremental
    // a subpage disappears at the source: replaced run removes it, the rest is re-imported
    fs.rmSync(path.join(dir, 'sub', 'b.md'));
    expect((await run()).lastStats).toMatchObject({ updated: 1, removed: 1 });
    expect(await titles()).toEqual(['a.md']);
    await admin.patch(`/api/admin/knowledge/sources/${sourceId}`, { replaceOnSync: false });
    expect(await statusOf(admin.post(`/api/admin/knowledge/sources/${sourceId}/sync`, { replace: 'yes' }))).toBe(400);
  });

  it('a full replace that finds nothing keeps the stored content (and reports it); an incremental update follows the source', async () => {
    fs.rmSync(path.join(dir, 'a.md'));
    const guarded = await run({ replace: true });
    expect(guarded.lastStatus).toBe('error');
    expect(guarded.lastError).toContain('bestehende Inhalt bleibt erhalten');
    expect(await titles()).toEqual(['a.md']); // nothing was wiped
    const incremental = await run({ replace: false });
    expect(incremental.lastStatus).toBe('ok');
    expect(incremental.lastStats).toMatchObject({ removed: 1 });
    expect(await titles()).toEqual([]);
  });

  describe('external trigger', () => {
    let token: string;
    let url: string;

    it('only admins create the token, it is shown once and never listed or audited', async () => {
      expect(await statusOf(bob.post(`/api/admin/knowledge/sources/${sourceId}/trigger-token`))).toBe(403);
      const r = await admin.post(`/api/admin/knowledge/sources/${sourceId}/trigger-token`);
      token = r.token;
      url = r.url;
      expect(token).toMatch(/^kt_[\w-]{40,}$/);
      expect(url.endsWith(`/api/hooks/knowledge/${sourceId}/sync`)).toBe(true);
      // the list names the webhook address (PUBLIC_URL) for every source with an external system, none for uploads
      expect((await sourceOf(sourceId)).hookUrl).toBe(url);
      expect(url.startsWith(config.PUBLIC_URL.replace(/\/$/, ''))).toBe(true);
      const uploadSource = ((await admin.get('/api/admin/knowledge/collections')) as { sources: Src[] }[]).flatMap((c) => c.sources).find((x) => x.type === 'upload')!;
      expect(uploadSource.hookUrl).toBeNull();
      const listed = JSON.stringify(await admin.get('/api/admin/knowledge/collections'));
      expect(listed).not.toContain(token);
      expect(listed).not.toContain('triggerTokenHash');
      expect(await sourceOf(sourceId)).toMatchObject({ hasTrigger: true });
      expect((await sourceOf(sourceId)).triggerTokenCreatedAt).toBeTruthy();
      expect(JSON.stringify(await admin.get('/api/admin/audit?action=knowledge.source.trigger_token&limit=10'))).not.toContain(token);
    });

    it('rejects calls without or with a wrong token, for another source or a malformed id (always 401)', async () => {
      const other = (await admin.post('/api/admin/knowledge/sources', { collectionId: colId, type: 'filesystem', name: 'Other', config: { path: 'upd' }, syncIntervalMinutes: 0 })).id;
      const otherToken = (await admin.post(`/api/admin/knowledge/sources/${other}/trigger-token`)).token;
      for (const res of [
        await hook(sourceId),
        await hook(sourceId, { token: 'kt_' + 'x'.repeat(43) }),
        await hook(sourceId, { token: otherToken }), // a token works for its own source only
        await hook('00000000-0000-4000-8000-000000000000', { token }),
        await hook('not-a-uuid', { token }),
        await hook(sourceId, { token: 'ap_' + 'x'.repeat(40) }),
      ]) {
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain('Bearer');
      }
      const failures = (await admin.get('/api/admin/audit?action=knowledge.trigger_failed&limit=50')) as { success: boolean }[];
      expect(failures.length).toBeGreaterThanOrEqual(6);
      expect(failures.every((f) => f.success === false)).toBe(true);
      await admin.del(`/api/admin/knowledge/sources/${other}`);
    });

    it('starts an update without session or CSRF header: Bearer token or X-Trigger-Token, optional full replace per call', async () => {
      file('a.md', '# A\n\nAktualisierter Text mit dem Begriff tellurit.', new Date('2024-01-01T00:00:00Z'));
      let before = (await sourceOf(sourceId)).lastSyncAt;
      const r1 = await hook(sourceId, { token });
      expect(r1.status).toBe(202);
      expect(await r1.json()).toEqual({ started: true, replace: false });
      let done = await finished(sourceId, before);
      expect(done.lastStats).toMatchObject({ added: 1 });
      expect(await textOf('a.md')).toContain('tellurit');

      // the file changes behind an unchanged version; the call asks for a full replace
      file('a.md', '# A\n\nAktualisierter Text mit dem Begriff wolframit.', new Date('2024-01-01T00:00:00Z'));
      before = done.lastSyncAt;
      const r2 = await hook(sourceId, { token, header: 'x', body: { replace: true } });
      expect(r2.status).toBe(202);
      expect(await r2.json()).toEqual({ started: true, replace: true });
      done = await finished(sourceId, before);
      expect(done.lastStats).toMatchObject({ updated: 1, unchanged: 0 });
      expect(await textOf('a.md')).toContain('wolframit');
      expect(await textOf('a.md')).not.toContain('tellurit');

      const audited = (await admin.get('/api/admin/audit?action=knowledge.sync&limit=5')) as { username: string; details: { trigger?: string; replace?: boolean } }[];
      expect(audited[0]).toMatchObject({ username: 'external-trigger', details: { trigger: 'external', replace: true } });
      expect((await hook(sourceId, { token, body: { replace: 'yes' } })).status).toBe(400);
    });

    it('refuses disabled, running and upload sources; rotating the token invalidates the old one; revoking ends the trigger', async () => {
      await admin.patch(`/api/admin/knowledge/sources/${sourceId}`, { enabled: false });
      expect((await hook(sourceId, { token })).status).toBe(409);
      await admin.patch(`/api/admin/knowledge/sources/${sourceId}`, { enabled: true });
      await db.update(knowledgeSources).set({ lastStatus: 'running' }).where(eq(knowledgeSources.id, sourceId));
      const busy = await hook(sourceId, { token });
      expect(busy.status).toBe(409);
      expect((await busy.json()).error).toContain('already running');
      await db.update(knowledgeSources).set({ lastStatus: 'ok' }).where(eq(knowledgeSources.id, sourceId));

      const rotated = (await admin.post(`/api/admin/knowledge/sources/${sourceId}/trigger-token`)).token;
      expect(rotated).not.toBe(token);
      expect((await hook(sourceId, { token })).status).toBe(401);
      const beforeRotated = (await sourceOf(sourceId)).lastSyncAt;
      expect((await hook(sourceId, { token: rotated })).status).toBe(202);
      await finished(sourceId, beforeRotated);

      // uploads have no external source
      const upload = ((await admin.get('/api/admin/knowledge/collections')) as { sources: Src[] }[]).flatMap((c) => c.sources).find((x) => x.type === 'upload')!;
      expect(await statusOf(admin.post(`/api/admin/knowledge/sources/${upload.id}/trigger-token`))).toBe(400);

      await admin.del(`/api/admin/knowledge/sources/${sourceId}/trigger-token`);
      expect(await sourceOf(sourceId)).toMatchObject({ hasTrigger: false, triggerTokenCreatedAt: null });
      expect((await hook(sourceId, { token: rotated })).status).toBe(401);
      expect(await statusOf(admin.post('/api/admin/knowledge/sources/00000000-0000-4000-8000-000000000000/trigger-token'))).toBe(404);
      const audit = JSON.stringify(await admin.get('/api/admin/audit?action=knowledge.source.trigger_token&limit=20'));
      expect(audit).toContain('created');
      expect(audit).toContain('revoked');
      expect(audit).not.toContain('kt_');
    });
  });

  it('the update modes combine: interval = automatic, no interval = manual, token = external (the scheduler only takes sources with an interval)', async () => {
    const created = await admin.post('/api/admin/knowledge/sources', { collectionId: colId, type: 'filesystem', name: 'Auto', config: { path: 'upd' }, syncIntervalMinutes: 15, replaceOnSync: true });
    expect(await sourceOf(created.id)).toMatchObject({ syncIntervalMinutes: 15, replaceOnSync: true, hasTrigger: false });
    await admin.patch(`/api/admin/knowledge/sources/${created.id}`, { syncIntervalMinutes: 0 });
    expect((await sourceOf(created.id)).syncIntervalMinutes).toBe(0);
    await admin.del(`/api/admin/knowledge/sources/${created.id}`);
    await admin.del(`/api/admin/knowledge/collections/${colId}`);
  });
});

describe('admin notes (comment column)', () => {
  const NOTE = 'Ansprechpartner: Team Betrieb, Ticket OPS-123';
  const TOO_LONG = 'x'.repeat(301);

  it('users: stored trimmed on create and update, cleared with an empty text, rejected above 300 characters', async () => {
    const created = await admin.post('/api/admin/users', { username: 'note.user', password: 'a-long-password-123', comment: `  ${NOTE}  ` });
    expect(created.comment).toBe(NOTE);
    const listed = (await admin.get('/api/admin/users')) as { username: string; comment: string | null }[];
    expect(listed.find((u) => u.username === 'note.user')!.comment).toBe(NOTE);
    expect(listed.find((u) => u.username === 'admin')!.comment).toBeNull();

    expect((await admin.patch(`/api/admin/users/${created.id}`, { displayName: 'Note User' })).comment).toBe(NOTE); // not sent -> unchanged
    expect((await admin.patch(`/api/admin/users/${created.id}`, { comment: 'neu' })).comment).toBe('neu');
    expect((await admin.patch(`/api/admin/users/${created.id}`, { comment: '   ' })).comment).toBeNull(); // empty -> cleared
    expect(await statusOf(admin.patch(`/api/admin/users/${created.id}`, { comment: TOO_LONG }))).toBe(400);
    expect((await admin.patch(`/api/admin/users/${created.id}`, { comment: 'x'.repeat(300) })).comment).toHaveLength(300);
    expect(await statusOf(admin.post('/api/admin/users', { username: 'note.two', password: 'a-long-password-123', comment: TOO_LONG }))).toBe(400);

    // the note is audited like any other change
    const audited = (await admin.get('/api/admin/audit?action=user.update&limit=10')) as { details: { comment?: string | null } }[];
    expect(audited.some((a) => a.details.comment === 'neu')).toBe(true);
    await admin.del(`/api/admin/users/${created.id}`);
  });

  it('providers and models: stored, listed to admins, never part of the user-facing model list', async () => {
    const prov = await admin.post('/api/admin/providers', { name: 'Note provider', type: 'openai_compatible', baseUrl: 'http://127.0.0.1:1', comment: NOTE });
    const provs = (await admin.get('/api/admin/providers')) as { id: string; comment: string | null }[];
    expect(provs.find((x) => x.id === prov.id)!.comment).toBe(NOTE);
    await admin.patch(`/api/admin/providers/${prov.id}`, { comment: 'Vertrag läuft bis 12/2027' });
    expect(((await admin.get('/api/admin/providers')) as { id: string; comment: string }[]).find((x) => x.id === prov.id)!.comment).toBe('Vertrag läuft bis 12/2027');
    expect(await statusOf(admin.patch(`/api/admin/providers/${prov.id}`, { comment: TOO_LONG }))).toBe(400);

    const model = await admin.post('/api/admin/models', { providerId: prov.id, modelId: 'note-model', displayName: 'Note model', comment: NOTE });
    expect(model.comment).toBe(NOTE);
    expect(((await admin.get('/api/admin/models')) as { id: string; comment: string }[]).find((m) => m.id === model.id)!.comment).toBe(NOTE);
    expect((await admin.patch(`/api/admin/models/${model.id}`, { comment: '' })).comment).toBeNull();
    await admin.patch(`/api/admin/models/${model.id}`, { comment: NOTE });

    // users see neither the note nor the provider's
    const userView = JSON.stringify(await bob.get('/api/models'));
    expect(userView).toContain('Note model');
    expect(userView).not.toContain('comment');
    expect(userView).not.toContain('Ansprechpartner');
    await admin.del(`/api/admin/providers/${prov.id}`);
  });

  it('knowledge collections and sources: stored and listed to admins only', async () => {
    const col = await admin.post('/api/admin/knowledge/collections', { name: 'Noted', public: true, comment: NOTE });
    expect(col.comment).toBe(NOTE);
    const src = await admin.post('/api/admin/knowledge/sources', {
      collectionId: col.id, type: 'filesystem', name: 'Noted share', config: { path: 'it' }, syncIntervalMinutes: 0, comment: 'Freigabe vom 01.11.',
    });
    const shown = async () => ((await admin.get('/api/admin/knowledge/collections')) as { id: string; comment: string | null; sources: { id: string; comment: string | null }[] }[]).find((c) => c.id === col.id)!;
    expect((await shown()).comment).toBe(NOTE);
    expect((await shown()).sources.find((x) => x.id === src.id)!.comment).toBe('Freigabe vom 01.11.');

    await admin.patch(`/api/admin/knowledge/collections/${col.id}`, { comment: '' });
    await admin.patch(`/api/admin/knowledge/sources/${src.id}`, { comment: 'neu' });
    expect((await shown()).comment).toBeNull();
    expect((await shown()).sources[0].comment).toBe('neu');
    expect(await statusOf(admin.patch(`/api/admin/knowledge/collections/${col.id}`, { comment: TOO_LONG }))).toBe(400);
    expect(await statusOf(admin.patch(`/api/admin/knowledge/sources/${src.id}`, { comment: TOO_LONG }))).toBe(400);

    // ordinary users see the collection, but not the note
    await admin.patch(`/api/admin/knowledge/collections/${col.id}`, { comment: NOTE });
    const userView = JSON.stringify(await bob.get('/api/knowledge/collections'));
    expect(userView).toContain('Noted');
    expect(userView).not.toContain('Ansprechpartner');
    expect(userView).not.toContain('comment');
    await admin.del(`/api/admin/knowledge/collections/${col.id}`);
  });

  it('SSO assignments: an optional note per entry (no effect on access), empty notes are dropped, 200 characters at most', async () => {
    const r = await admin.put('/api/admin/sso/assignments', { assignments: [
      { type: 'group', value: 'grp-a', admin: false, comment: '  Fachbereich Betrieb  ' },
      { type: 'user', value: '*@acme.example', admin: false, comment: '   ' },
      { type: 'group', value: 'grp-b', admin: true },
    ] });
    expect(r.assignments).toEqual([
      { type: 'group', value: 'grp-a', admin: false, comment: 'Fachbereich Betrieb' },
      { type: 'user', value: '*@acme.example', admin: false },
      { type: 'group', value: 'grp-b', admin: true },
    ]);
    expect((await admin.get('/api/admin/sso/assignments')).assignments[0].comment).toBe('Fachbereich Betrieb');
    expect(await statusOf(admin.put('/api/admin/sso/assignments', { assignments: [{ type: 'group', value: 'g', admin: false, comment: 'x'.repeat(201) }] }))).toBe(400);
    await admin.put('/api/admin/sso/assignments', { assignments: [] });
  });

  it('notes are not part of any user-facing profile', async () => {
    const me = await bob.get('/api/auth/me');
    expect(JSON.stringify(me)).not.toContain('comment');
    expect(await statusOf(bob.patch('/api/admin/users/00000000-0000-4000-8000-000000000000', { comment: 'x' }))).toBe(403);
  });
});

describe('knowledge sources: on/off switch and credentials', () => {
  let colId: string;
  const create = (type: string, config: object, secret?: object, extra: object = {}) =>
    admin.post('/api/admin/knowledge/sources', { collectionId: colId, type, name: `src-${type}`, config, secret, syncIntervalMinutes: 0, ...extra });
  type Src = { id: string; enabled: boolean; hasSecret: boolean; lastStatus: string | null; lastSyncAt: string | null };
  const sourceOf = async (id: string) => ((await admin.get('/api/admin/knowledge/collections')) as { sources: Src[] }[]).flatMap((c) => c.sources).find((x) => x.id === id)!;
  const patch = (id: string, body: object) => statusOf(admin.patch(`/api/admin/knowledge/sources/${id}`, body));

  beforeAll(async () => { colId = (await admin.post('/api/admin/knowledge/collections', { name: 'Switch and credentials' })).id; });

  it('switching a source off keeps its content searchable, stops scheduled and external updates, and still allows a manual sync', async () => {
    fs.mkdirSync(path.join(shares, 'sw'), { recursive: true });
    fs.writeFileSync(path.join(shares, 'sw', 'a.md'), '# A\n\nSchalter-Test mit dem Begriff kobaltglanz.');
    const src = await create('filesystem', { path: 'sw' });
    expect((await sourceOf(src.id)).enabled).toBe(true);

    expect(await patch(src.id, { enabled: false })).toBe(200);
    expect((await sourceOf(src.id)).enabled).toBe(false);
    // a manual update is an explicit admin decision and works for a disabled source
    const before = (await sourceOf(src.id)).lastSyncAt;
    await admin.post(`/api/admin/knowledge/sources/${src.id}/sync`);
    let done = await sourceOf(src.id);
    for (let i = 0; i < 100 && (done.lastSyncAt === before || done.lastStatus === 'running'); i++) { await new Promise((r) => setTimeout(r, 100)); done = await sourceOf(src.id); }
    expect(done).toMatchObject({ lastStatus: 'ok', enabled: false });
    expect(((await admin.get(`/api/admin/knowledge/sources/${src.id}/documents`)) as unknown[]).length).toBe(1);

    expect(await patch(src.id, { enabled: true })).toBe(200);
    expect((await sourceOf(src.id)).enabled).toBe(true);
    const audited = (await admin.get('/api/admin/audit?action=knowledge.source.update&limit=10')) as { details: { enabled?: boolean } }[];
    expect(audited.some((a) => a.details.enabled === false)).toBe(true);
  });

  it('credentials need the complete set for the source type and replace the stored ones', async () => {
    const http = await create('http', { startUrls: ['https://wiki.example/it/'] });
    expect((await sourceOf(http.id)).hasSecret).toBe(false);
    expect(await patch(http.id, { secret: { Authorization: 'Bearer new-token-1' } })).toBe(200);
    expect((await sourceOf(http.id)).hasSecret).toBe(true);
    expect(await patch(http.id, { secret: { 'bad header': 'x' } })).toBe(400);
    expect(await patch(http.id, { secret: {} })).toBe(200); // an empty set removes the headers
    expect((await sourceOf(http.id)).hasSecret).toBe(false);

    const cloud = await create('confluence', { baseUrl: 'https://acme.atlassian.net/wiki', deployment: 'cloud', spaceKeys: ['IT'] }, { email: 'a@acme.example', apiToken: 't1' });
    expect(await patch(cloud.id, { secret: { apiToken: 't2' } })).toBe(400); // the e-mail is part of the credentials
    expect(await patch(cloud.id, { secret: { email: 'a@acme.example', apiToken: '  ' } })).toBe(400);
    expect(await patch(cloud.id, { secret: { token: 'pat' } })).toBe(400); // Cloud has no personal access tokens
    expect(await patch(cloud.id, { secret: { email: 'a@acme.example', apiToken: 't2', extra: 'x' } })).toBe(400);
    expect(await patch(cloud.id, { secret: { email: 'b@acme.example', apiToken: 't2' } })).toBe(200);

    const server = await create('confluence', { baseUrl: 'https://wiki.acme.example', deployment: 'server', spaceKeys: ['IT'] }, { token: 'pat' });
    expect(await patch(server.id, { secret: { email: 'a@acme.example', apiToken: 't' } })).toBe(400);
    expect(await patch(server.id, { secret: { token: 'pat-2' } })).toBe(200);

    const sp = await create('sharepoint', { tenantId: 't', clientId: 'c', siteUrl: 'https://acme.sharepoint.com/sites/it' }, { clientSecret: 's1' });
    expect(await patch(sp.id, { secret: { clientSecret: '' } })).toBe(400);
    expect(await patch(sp.id, { secret: { token: 'x' } })).toBe(400);
    expect(await patch(sp.id, { secret: { clientSecret: 's2' } })).toBe(200);

    // creating checks the same shapes; shares and uploads have no credentials at all
    expect(await statusOf(create('confluence', { baseUrl: 'https://c.example', deployment: 'cloud', spaceKeys: ['IT'] }, { token: 'x' }))).toBe(400);
    expect(await statusOf(create('sharepoint', { tenantId: 't', clientId: 'c', siteUrl: 'https://acme.sharepoint.com/sites/it' }, {}))).toBe(400);
    const share = await create('filesystem', { path: 'sw' });
    expect(await patch(share.id, { secret: { token: 'x' } })).toBe(400);

    // the new credentials never show up: not in the list, not in the audit log
    const shown = JSON.stringify(await admin.get('/api/admin/knowledge/collections'));
    const audit = JSON.stringify(await admin.get('/api/admin/audit?action=knowledge.source.update&limit=50'));
    for (const leaked of ['new-token-1', 'pat-2', 'b@acme.example']) { expect(shown, leaked).not.toContain(leaked); expect(audit, leaked).not.toContain(leaked); }
    expect(audit).toContain('secretChanged');
    await admin.del(`/api/admin/knowledge/collections/${colId}`);
  });
});

describe('SSO assignments', () => {
  it('admins manage them; they are deduplicated, validated, audited and admin-only', async () => {
    expect((await admin.get('/api/admin/sso/assignments'))).toEqual({ enabled: false, env: [], assignments: [] });
    const r = await admin.put('/api/admin/sso/assignments', { assignments: [
      { type: 'group', value: 'Grp-Admins', admin: true }, { type: 'group', value: 'grp-admins', admin: false }, { type: 'user', value: '*@example.com', admin: false },
    ] });
    expect(r.assignments).toEqual([{ type: 'group', value: 'Grp-Admins', admin: true }, { type: 'user', value: '*@example.com', admin: false }]);
    expect((await admin.get('/api/admin/sso/assignments')).assignments).toHaveLength(2);
    expect(await statusOf(admin.put('/api/admin/sso/assignments', { assignments: [{ type: 'role', value: 'x', admin: false }] }))).toBe(400);
    expect(await statusOf(bob.get('/api/admin/sso/assignments'))).toBe(403);
    expect(await statusOf(bob.put('/api/admin/sso/assignments', { assignments: [] }))).toBe(403);
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'sso.assignments'));
    expect(entries.some((e) => (e.details as { count?: number; admins?: number }).count === 2 && (e.details as { admins?: number }).admins === 1)).toBe(true);
    await admin.put('/api/admin/sso/assignments', { assignments: [] });
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
    const o = await bob.post('/api/mcp-servers', { name: 'OA', url: `${app.base}/mcp`, oauth: { tokenUrl: 'https://idp.example/token', clientId: 'cid', clientSecret: 'topsecret', scope: 's' } });
    expect(o.oauth).toEqual({ tokenUrl: 'https://idp.example/token', clientId: 'cid', scope: 's' });
    expect(JSON.stringify(o)).not.toContain('topsecret');
    const o2 = await bob.patch(`/api/mcp-servers/${o.id}`, { oauth: { tokenUrl: 'https://idp.example/token', clientId: 'cid2' } });
    expect(o2.oauth.clientId).toBe('cid2'); // secret kept
    expect(await statusOf(bob.post('/api/mcp-servers', { name: 'nosecret', url: `${app.base}/mcp`, oauth: { tokenUrl: 'https://idp.example/token', clientId: 'c' } }))).toBe(400);
    expect((await bob.patch(`/api/mcp-servers/${o.id}`, { oauth: null })).oauth).toBeNull();
    await bob.del(`/api/mcp-servers/${o.id}`);
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
