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

export async function connectMcp(s: McpServer): Promise<Client> {
  await assertAllowedUrl(s.url);
  const headers = decryptJson<Record<string, string>>(s.headersEnc, {});
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
                onToolCall({ server: s, tool: t.name, ok: false, ms: Date.now() - start, error: String(e) });
                throw e;
              }
            },
          });
        }
        status.push({ serverId: s.id, name: s.name, ok: true, tools: list.length });
      } catch (e) {
        logger.warn({ err: e, mcp: s.name }, 'mcp connect failed');
        status.push({ serverId: s.id, name: s.name, ok: false, tools: 0, error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  return { tools, status, close: async () => { await Promise.allSettled(clients.map((c) => c.close())); } };
}
