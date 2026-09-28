/** Starts the real Express app (createApp) on a random port; API client with session cookie and CSRF header. */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

export async function startApp() {
  const { createApp } = await import('../../src/app.js');
  const app = createApp({ name: 'AI Portal' });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) { super(`HTTP ${status}: ${JSON.stringify(body)}`); }
}

export class Client {
  cookie = '';
  constructor(readonly base: string, readonly lang: 'de' | 'en' = 'de') {}

  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const isForm = body instanceof FormData;
    const res = await fetch(this.base + path, {
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
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : undefined; } catch { /* plain text */ }
    if (!res.ok) throw new HttpError(res.status, data);
    return data as T;
  }
  get<T = any>(path: string) { return this.call<T>('GET', path); }
  post<T = any>(path: string, body?: unknown) { return this.call<T>('POST', path, body ?? {}); }
  patch<T = any>(path: string, body: unknown) { return this.call<T>('PATCH', path, body); }
  put<T = any>(path: string, body: unknown) { return this.call<T>('PUT', path, body); }
  del(path: string) { return this.call('DELETE', path); }

  login(username: string, password: string) { return this.post('/api/auth/login', { username, password, method: 'local' }); }

  /** Sends a chat message and returns the parsed NDJSON events. */
  async chat(chatId: string, body: object) {
    const res = await this.raw('POST', `/api/chats/${chatId}/messages`, body);
    if (!res.ok) throw new HttpError(res.status, await res.text());
    return (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  }
}

/** Status of a failed call, for expect(...).rejects checks. */
export const statusOf = (p: Promise<unknown>) => p.then(() => 200, (e: HttpError) => e.status);
