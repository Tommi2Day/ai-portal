export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

import { getLang } from './i18n';

const H = { 'x-requested-with': 'ai-portal' };
/** Language header so server messages come back in the selected UI language. */
const hdr = () => ({ ...H, 'x-ui-lang': getLang() });

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: init.body instanceof FormData ? hdr() : { ...hdr(), 'content-type': 'application/json' },
    body: init.body instanceof FormData ? init.body : init.body ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

export interface Me { id: string; username: string; displayName: string | null; role: 'admin' | 'user'; authSource: string }
export interface ModelOpt { id: string; displayName: string; description: string | null; provider: string; supportsImages: boolean; isDefault: boolean }
export interface ChatSummary { id: string; title: string; updatedAt: string }
export interface Attachment { id: string; filename: string; mimeType: string; size: number; warning?: string }
export type Part =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolCallId: string; name: string; input: unknown; output?: unknown; error?: string };
export interface Message { id: string; role: 'user' | 'assistant'; content: string; parts: Part[]; attachmentIds: string[]; usage?: { inputTokens?: number; outputTokens?: number } | null }

export type StreamEvent =
  | { t: 'text'; d: string }
  | { t: 'tool-call'; id: string; name: string; input: unknown }
  | { t: 'tool-result'; id: string; output: string }
  | { t: 'tool-error'; id: string; error: string }
  | { t: 'mcp'; status: { name: string; ok: boolean; tools: number; error?: string }[] }
  | { t: 'error'; message: string }
  | { t: 'done'; messageId: string; usage?: { inputTokens?: number; outputTokens?: number }; title?: string };

export async function streamMessage(chatId: string, body: unknown, onEvent: (e: StreamEvent) => void, signal: AbortSignal) {
  const res = await fetch(`/api/chats/${chatId}/messages`, {
    method: 'POST', headers: { ...hdr(), 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (!res.ok || !res.body) {
    const d = await res.json().catch(() => ({}));
    throw new ApiError(res.status, d.error ?? res.statusText);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}
