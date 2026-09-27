/**
 * Minimal OpenAI-compatible server for the integration tests: `POST /v1/chat/completions`
 * (streaming, incl. tool calls) and `POST /v1/embeddings`. Answers are scripted per test,
 * every request is recorded so tests can check what the portal sends to a provider.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | { type: string; text?: string; image_url?: { url: string } }[] | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
export interface ChatRequest {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
  tools?: { type: 'function'; function: { name: string; description?: string; parameters: unknown } }[];
}
export type Reply =
  | { text: string }
  | { toolCalls: { name: string; args: Record<string, unknown> }[] }
  | { status: number; error: string };
export type Script = (req: ChatRequest, headers: http.IncomingHttpHeaders) => Reply;

/** Deterministic bag-of-words embedding: texts sharing words get similar vectors. */
export function fakeEmbedding(text: string, dim = 64): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let h = 2166136261;
    for (const c of w) h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
    v[(h >>> 0) % dim] += 1;
  }
  const n = Math.hypot(...v);
  return n ? v.map((x) => x / n) : v.map((_, i) => (i === 0 ? 1 : 0)); // no words: fixed unit vector
}

export const textOf = (m: ChatMessage) =>
  typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join('');
export const lastUser = (r: ChatRequest) => textOf([...r.messages].reverse().find((m) => m.role === 'user')!);
export const toolResults = (r: ChatRequest) => r.messages.filter((m) => m.role === 'tool').map(textOf);

export class MockLlm {
  readonly requests: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  script: Script = (r) => ({ text: `echo: ${lastUser(r)}` });
  private server = http.createServer((req, res) => this.handle(req, res));
  url = '';

  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
    return this;
  }
  stop() { return new Promise<void>((r) => this.server.close(() => r())); }
  chatRequests() { return this.requests.filter((r) => r.path.endsWith('/chat/completions')).map((r) => r.body as ChatRequest); }
  reset() { this.requests.length = 0; this.script = (r) => ({ text: `echo: ${lastUser(r)}` }); }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    this.requests.push({ path: req.url ?? '', headers: req.headers, body });
    const json = (status: number, o: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (req.url?.endsWith('/embeddings')) {
      const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
      return json(200, {
        object: 'list', model: body.model,
        data: input.map((t, index) => ({ object: 'embedding', index, embedding: fakeEmbedding(t, body.dimensions ?? 64) })),
        usage: { prompt_tokens: input.length, total_tokens: input.length },
      });
    }
    if (!req.url?.endsWith('/chat/completions')) return json(404, { error: { message: 'not found' } });

    const reply = this.script(body as ChatRequest, req.headers);
    if ('status' in reply) return json(reply.status, { error: { message: reply.error, type: 'invalid_request_error' } });

    const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
    const usage = { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 };
    const chunks: unknown[] = [];
    if ('text' in reply) {
      const parts = reply.text.match(/[\s\S]{1,20}/g) ?? [''];
      parts.forEach((p, i) => chunks.push({ ...base, choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: p } : { content: p }, finish_reason: null }] }));
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
    } else {
      reply.toolCalls.forEach((t, i) => chunks.push({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: i, id: `call_${i}_${Date.now()}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }] }, finish_reason: null }],
      }));
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.end('data: [DONE]\n\n');
  }
}
