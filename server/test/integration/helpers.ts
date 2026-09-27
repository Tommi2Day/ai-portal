import { inject } from 'vitest';

export const portalUrl = () => inject('portalUrl');

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: any) { super(`HTTP ${status}: ${JSON.stringify(body)}`); }
}

/** API client with its own session cookie; sends the CSRF header like the web UI. */
export class Api {
  cookie = '';
  constructor(readonly lang: 'de' | 'en' = 'en') {}

  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const isForm = body instanceof FormData;
    const res = await fetch(portalUrl() + path, {
      method,
      headers: {
        'x-requested-with': 'ai-portal', 'x-ui-lang': this.lang, cookie: this.cookie,
        ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}), ...headers,
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    const set = res.headers.getSetCookie();
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
    return res;
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
    if (!res.ok) throw new ApiError(res.status, data);
    return data as T;
  }
  get<T = any>(path: string) { return this.call<T>('GET', path); }
  post<T = any>(path: string, body?: unknown) { return this.call<T>('POST', path, body ?? {}); }
  patch<T = any>(path: string, body: unknown) { return this.call<T>('PATCH', path, body); }
  put<T = any>(path: string, body: unknown) { return this.call<T>('PUT', path, body); }
  del<T = any>(path: string) { return this.call<T>('DELETE', path); }

  async login(username: string, password: string) {
    await this.post('/api/auth/login', { username, password, method: 'local' });
    return this;
  }

  /** Sends a chat message and collects the NDJSON stream. */
  async chat(chatId: string, body: { content: string; modelId: string; useMcp?: boolean; useKnowledge?: boolean; attachmentIds?: string[] }) {
    const res = await this.raw('POST', `/api/chats/${chatId}/messages`, body);
    if (!res.ok) throw new ApiError(res.status, await res.text());
    const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string; [k: string]: any });
    return {
      events,
      text: events.filter((e) => e.t === 'text').map((e) => e.d).join(''),
      toolCalls: events.filter((e) => e.t === 'tool-call'),
      toolResults: events.filter((e) => e.t === 'tool-result'),
      toolErrors: events.filter((e) => e.t === 'tool-error'),
      errors: events.filter((e) => e.t === 'error'),
      mcp: events.find((e) => e.t === 'mcp')?.status as { name: string; ok: boolean; tools: number; error?: string }[] | undefined,
      done: events.find((e) => e.t === 'done'),
    };
  }
}

export const adminApi = () => new Api().login('admin', inject('adminPassword'));

let n = 0;
/** Creates a local user (as admin) and returns a logged-in client for it. */
export async function newUser(admin: Api, role: 'admin' | 'user' = 'user', groups: string[] = []) {
  const username = `it-user-${Date.now()}-${++n}`;
  const password = 'it-password-123456';
  const u = await admin.post('/api/admin/users', { username, password, role, displayName: username });
  if (groups.length) await admin.patch(`/api/admin/users/${u.id}`, { groups });
  return { id: u.id as string, username, api: await new Api().login(username, password) };
}

/** OpenAI-compatible provider pointing at the mock LLM, plus one approved model. */
export async function mockProvider(admin: Api, llmUrl: string, name = `Mock ${++n}`) {
  const p = await admin.post('/api/admin/providers', { name, type: 'openai_compatible', baseUrl: llmUrl, secret: { apiKey: 'mock-key' } });
  const m = await admin.post('/api/admin/models', { providerId: p.id, modelId: 'mock-model', displayName: `${name} model`, supportsImages: true });
  return { providerId: p.id as string, modelId: m.id as string };
}

export async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Direct MCP client (test setup and the portal's own /mcp endpoint). */
export async function mcpClient(url: string, token: string) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'ai-portal-it', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

export const mcpText = (r: unknown) =>
  (((r as { content?: unknown }).content ?? []) as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');

export const PG_MCP = { url: process.env.IT_PG_MCP_URL ?? 'http://127.0.0.1:3101/mcp', token: 'it-pg-token' };
export const ORACLE_MCP = { url: process.env.IT_ORACLE_MCP_URL ?? 'http://127.0.0.1:3102/mcp', token: 'it-oracle-token' };
export const skipOracle = process.env.IT_SKIP_ORACLE === '1';
