import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import { config } from '../config.js';
import { decryptJson } from '../crypto.js';
import type { McpServer } from '../db/schema.js';
import { logger } from '../logger.js';
import { maskString, safeErrorText } from '../redact.js';

const CONNECT_TIMEOUT = 10_000;
const CALL_TIMEOUT = 60_000;

function isPrivate(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
}

/** Basic SSRF guard for user-supplied MCP URLs. */
export async function assertAllowedUrl(raw: string) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Nur http(s)-URLs sind erlaubt');
  if (config.MCP_ALLOW_PRIVATE_NETWORKS) return;
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivate(a.address))) throw new Error('Private Netzadressen sind für MCP-Server nicht erlaubt');
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what}: Timeout nach ${ms / 1000}s`)), ms))]);

export interface McpOAuth { tokenUrl: string; clientId: string; clientSecret: string; scope?: string }

const tokenCache = new Map<string, { token: string; expires: number }>();
const TOKEN_RESPONSE_MAX = 64 * 1024;
const TOKEN_MAX_LIFETIME = 24 * 3600;

/** JSON body of a token response, read with a size cap (the token URL is user-supplied). */
async function readTokenResponse(res: Response): Promise<{ access_token?: string; expires_in?: unknown; error_description?: string; error?: string }> {
  const reader = res.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > TOKEN_RESPONSE_MAX) { await reader.cancel(); throw new Error('OAuth-Token: Antwort zu groß'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/** OAuth 2.0 client-credentials grant; tokens are cached until shortly before they expire. */
export async function fetchOAuthToken(o: McpOAuth): Promise<string> {
  const key = crypto.createHash('sha256').update(JSON.stringify([o.tokenUrl, o.clientId, o.clientSecret, o.scope ?? ''])).digest('hex');
  const hit = tokenCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.token;
  await assertAllowedUrl(o.tokenUrl);
  const res = await fetch(o.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: o.clientId, client_secret: o.clientSecret, ...(o.scope ? { scope: o.scope } : {}) }),
    signal: AbortSignal.timeout(CONNECT_TIMEOUT),
    redirect: 'manual', // a redirect would bypass the URL allowlist
  });
  if (res.status >= 300 && res.status < 400) throw new Error('OAuth-Token: Redirects nicht erlaubt');
  const data = await readTokenResponse(res);
  if (!res.ok || !data.access_token) throw new Error(`OAuth-Token: ${data.error_description ?? data.error ?? `HTTP ${res.status}`}`);
  const lifetime = Math.min(Number(data.expires_in) || 300, TOKEN_MAX_LIFETIME); // untrusted: never cache longer than a day
  for (const [k, v] of tokenCache) if (v.expires <= Date.now()) tokenCache.delete(k);
  tokenCache.set(key, { token: data.access_token, expires: Date.now() + Math.max(30, lifetime - 60) * 1000 });
  return data.access_token;
}

export async function connectMcp(s: McpServer): Promise<Client> {
  await assertAllowedUrl(s.url);
  const headers = decryptJson<Record<string, string>>(s.headersEnc, {});
  const oauth = decryptJson<McpOAuth | null>(s.oauthEnc, null);
  if (oauth) {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
    headers.Authorization = `Bearer ${await fetchOAuthToken(oauth)}`;
  }
  const url = new URL(s.url);
  const transport =
    s.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) } })
      : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  const client = new Client({ name: 'ai-portal', version: '1.0.0' });
  await withTimeout(client.connect(transport), CONNECT_TIMEOUT, `MCP ${s.name}`);
  return client;
}

export const slug = (s: string) => s.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/(^_)|(_$)/g, '').slice(0, 20) || 'mcp';

export interface McpSession {
  tools: ToolSet;
  status: { serverId: string; name: string; ok: boolean; tools: number; error?: string }[];
  close: () => Promise<void>;
}

/**
 * Connects to all enabled MCP servers of a user and exposes their tools as AI SDK tools.
 * Tool names are prefixed with the server name to avoid collisions: "<server>__<tool>".
 */
export async function openMcpSession(
  servers: McpServer[],
  onToolCall: (info: { server: McpServer; tool: string; ok: boolean; ms: number; error?: string }) => void,
): Promise<McpSession> {
  const clients: Client[] = [];
  const tools: ToolSet = {};
  const status: McpSession['status'] = [];

  await Promise.all(
    servers.map(async (s) => {
      try {
        const client = await connectMcp(s);
        clients.push(client);
        const { tools: list } = await withTimeout(client.listTools(), CONNECT_TIMEOUT, `MCP ${s.name} listTools`);
        for (const t of list) {
          const name = `${slug(s.name)}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
          tools[name] = dynamicTool({
            description: `[${s.name}] ${t.description ?? t.name}`,
            inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
            execute: async (input) => {
              const start = Date.now();
              try {
                const r = await withTimeout(
                  client.callTool({ name: t.name, arguments: input as Record<string, unknown> }),
                  CALL_TIMEOUT, `Tool ${t.name}`,
                );
                onToolCall({ server: s, tool: t.name, ok: !r.isError, ms: Date.now() - start });
                return r.structuredContent ?? r.content;
              } catch (e) {
                onToolCall({ server: s, tool: t.name, ok: false, ms: Date.now() - start, error: maskString(String(e)) });
                throw e;
              }
            },
          });
        }
        status.push({ serverId: s.id, name: s.name, ok: true, tools: list.length });
      } catch (e) {
        logger.warn({ err: e, mcp: s.name }, 'mcp connect failed');
        status.push({ serverId: s.id, name: s.name, ok: false, tools: 0, error: safeErrorText(e) });
      }
    }),
  );

  return { tools, status, close: async () => { await Promise.allSettled(clients.map((c) => c.close())); } };
}
