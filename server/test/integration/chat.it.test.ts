/**
 * Chat and provider connection against the mock LLM: what the portal sends to a provider,
 * key handling, errors, attachments and access control (see docs/llm-providers.md).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lastUser, MockLlm, textOf, type ChatRequest } from './mockLlm.js';
import { adminApi, Api, mockProvider, newUser } from './helpers.js';

const llm = new MockLlm();
let admin: Api;
let user: Api;
let providerId: string;
let modelId: string;

beforeAll(async () => {
  await llm.start();
  admin = await adminApi();
  ({ providerId, modelId } = await mockProvider(admin, llm.url, 'Mock Chat'));
  user = (await newUser(admin)).api;
});
afterAll(() => llm.stop());
beforeEach(() => llm.reset());

const newChat = async (api = user) => (await api.post('/api/chats', { modelId })).id as string;
const send = (content: string, chat: string, extra: object = {}) => user.chat(chat, { content, modelId, useMcp: false, useKnowledge: false, ...extra });
const upload = async (files: { name: string; type: string; data: string | Buffer }[]) => {
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([typeof f.data === 'string' ? f.data : new Uint8Array(f.data)], { type: f.type }), f.name);
  return (await user.call('POST', '/api/files', form)) as { id: string; filename: string }[];
};

describe('request to the provider', () => {
  it('streams the answer, stores it with usage and titles the chat', async () => {
    const chat = await newChat();
    const r = await send('Hello model, how are you today?', chat);
    expect(r.text).toBe('echo: Hello model, how are you today?');
    expect(r.done).toMatchObject({ usage: { inputTokens: 42, outputTokens: 7 }, title: 'Hello model, how are you today?' });
    const stored = await user.get(`/api/chats/${chat}`);
    expect(stored.title).toBe('Hello model, how are you today?');
    expect(stored.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
  });

  it('sends the model ID, streaming, the API key as Bearer token and the system prompt', async () => {
    await send('ping', await newChat());
    const [req] = llm.requests.filter((r) => r.path.endsWith('/chat/completions'));
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer mock-key');
    const body = req.body as ChatRequest;
    expect(body).toMatchObject({ model: 'mock-model', stream: true });
    expect(body.messages[0].role).toBe('system');
    expect(textOf(body.messages[0])).toContain('KI-Assistent des internen AI Portals');
    expect(textOf(body.messages[0])).toContain('answer in English'); // UI language en
  });

  it('re-sends the complete history with every message', async () => {
    const chat = await newChat();
    await send('first question', chat);
    await send('second question', chat);
    const second = llm.chatRequests()[1];
    expect(second.messages.filter((m) => m.role !== 'system').map((m) => [m.role, textOf(m)])).toEqual([
      ['user', 'first question'], ['assistant', 'echo: first question'], ['user', 'second question'],
    ]);
  });

  it('puts extracted attachment text before the question – also again in later messages', async () => {
    const [log] = await upload([{ name: 'backup.log', type: 'text/plain', data: 'ORA-19809: limit exceeded for recovery files' }]);
    const chat = await newChat();
    await send('Why does the backup fail?', chat, { attachmentIds: [log.id] });
    expect(lastUser(llm.chatRequests()[0])).toMatch(/^<datei name="backup\.log">\nORA-19809[^]*<\/datei>\n\nWhy does the backup fail\?$/);
    await send('And now?', chat);
    expect(textOf(llm.chatRequests()[1].messages.find((m) => m.role === 'user')!)).toContain('ORA-19809');
  });

  it('sends images only to models that understand images', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const [img] = await upload([{ name: 'screen.png', type: 'image/png', data: png }]);
    await send('What is on the screenshot?', await newChat(), { attachmentIds: [img.id] });
    const content = llm.chatRequests()[0].messages.at(-1)!.content as any[];
    expect(content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,'))).toBe(true);

    const textOnly = await admin.post('/api/admin/models', { providerId, modelId: 'mock-text-only', displayName: 'Text only', supportsImages: false });
    llm.reset();
    await user.chat(await newChat(), { content: 'And now?', modelId: textOnly.id, attachmentIds: [img.id], useMcp: false, useKnowledge: false });
    const plain = llm.chatRequests()[0].messages.at(-1)!.content;
    expect(JSON.stringify(plain)).not.toContain('image_url');
  });

  it('rejects attachments of other users', async () => {
    const [mine] = await upload([{ name: 'secret.txt', type: 'text/plain', data: 'secret' }]);
    const other = (await newUser(admin)).api;
    const res = await other.raw('POST', `/api/chats/${await newChat(other)}/messages`, { content: 'x', modelId, attachmentIds: [mine.id] });
    expect(res.status).toBe(400);
  });
});

describe('provider credentials', () => {
  it('never returns keys, only whether one is stored', async () => {
    const list = await admin.get('/api/admin/providers');
    const p = list.find((x: any) => x.id === providerId);
    expect(p.hasSecret).toBe(true);
    expect(JSON.stringify(list)).not.toContain('mock-key');
    expect(p).not.toHaveProperty('secretEnc');
  });

  it('uses a rotated key with the next message, without restart', async () => {
    await admin.patch(`/api/admin/providers/${providerId}`, { secret: { apiKey: 'rotated-key' } });
    try {
      await send('after rotation', await newChat());
      expect(llm.requests.at(-1)!.headers.authorization).toBe('Bearer rotated-key');
      const [entry] = await admin.get('/api/admin/audit?action=provider.update&limit=1');
      expect(entry.details).toMatchObject({ secretChanged: true });
      expect(JSON.stringify(entry)).not.toContain('rotated-key');
    } finally {
      await admin.patch(`/api/admin/providers/${providerId}`, { secret: { apiKey: 'mock-key' } });
    }
  });

  it('changes the base URL via the API', async () => {
    const other = await new MockLlm().start();
    try {
      await admin.patch(`/api/admin/providers/${providerId}`, { baseUrl: other.url });
      await send('to the other endpoint', await newChat());
      expect(other.chatRequests()).toHaveLength(1);
      expect(llm.chatRequests()).toHaveLength(0);
    } finally {
      await admin.patch(`/api/admin/providers/${providerId}`, { baseUrl: llm.url });
      await other.stop();
    }
  });
});

describe('errors and availability', () => {
  it('shows provider errors in the chat and audits chat.error', async () => {
    llm.script = () => ({ status: 401, error: 'invalid api key' });
    const chat = await newChat();
    const r = await send('fails', chat);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0].message).toMatch(/invalid api key/);
    expect(r.done).toBeDefined();
    const [entry] = await admin.get('/api/admin/audit?action=chat.error&limit=1');
    expect(entry).toMatchObject({ success: false, details: expect.objectContaining({ provider: 'Mock Chat', model: 'mock-model' }) });
    expect(entry.details.error).toMatch(/invalid api key/);
  });

  it('hides models of a disabled provider immediately', async () => {
    await admin.patch(`/api/admin/providers/${providerId}`, { enabled: false });
    try {
      const models = await user.get('/api/models');
      expect(models.some((m: any) => m.id === modelId)).toBe(false);
      await expect(user.post(`/api/chats/${await newChat()}/messages`, { content: 'x', modelId })).rejects.toMatchObject({ status: 400, body: { error: 'Model not available' } });
    } finally {
      await admin.patch(`/api/admin/providers/${providerId}`, { enabled: true });
    }
    expect((await user.get('/api/models')).some((m: any) => m.id === modelId)).toBe(true);
  });

  it('keeps exactly one default model', async () => {
    const a = await admin.post('/api/admin/models', { providerId, modelId: 'a', displayName: 'A', isDefault: true });
    const b = await admin.post('/api/admin/models', { providerId, modelId: 'b', displayName: 'B', isDefault: true });
    const defaults = (await admin.get('/api/admin/models')).filter((m: any) => m.isDefault);
    expect(defaults.map((m: any) => m.id)).toEqual([b.id]);
    expect(a.id).not.toBe(b.id);
  });
});

describe('access control', () => {
  it('requires a session and admin role', async () => {
    const anon = new Api();
    await expect(anon.get('/api/chats')).rejects.toMatchObject({ status: 401 });
    await expect(user.get('/api/admin/providers')).rejects.toMatchObject({ status: 403 });
  });

  it('rejects writes without the CSRF header', async () => {
    const res = await user.raw('POST', '/api/chats', {}, { 'x-requested-with': '' });
    expect(res.status).toBe(403);
  });

  it('keeps chats private', async () => {
    const chat = await newChat();
    const other = (await newUser(admin)).api;
    await expect(other.get(`/api/chats/${chat}`)).rejects.toMatchObject({ status: 404 });
  });

  it('logs failed sign-ins', async () => {
    await expect(new Api().login('admin', 'wrong-password')).rejects.toMatchObject({ status: 401 });
    const [entry] = await admin.get('/api/admin/audit?action=auth.login_failed&limit=1');
    expect(entry.username).toBe('admin');
  });
});
