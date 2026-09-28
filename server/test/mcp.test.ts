import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  transports: [] as { kind: string; url: string; opts: { requestInit?: { headers?: Record<string, string> } } }[],
  servers: {} as Record<string, { tools: { name: string; description?: string; inputSchema: object }[]; call?: (name: string, args: unknown) => object; fail?: string }>,
  closed: 0,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class { constructor(url: URL, opts: never) { sdk.transports.push({ kind: 'http', url: String(url), opts }); } },
}));
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class { constructor(url: URL, opts: never) { sdk.transports.push({ kind: 'sse', url: String(url), opts }); } },
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    private url = '';
    async connect() {
      this.url = sdk.transports.at(-1)!.url;
      if (sdk.servers[this.url].fail) throw new Error(sdk.servers[this.url].fail);
    }
    async listTools() { return { tools: sdk.servers[this.url].tools }; }
    async callTool({ name, arguments: args }: { name: string; arguments: unknown }) { return sdk.servers[this.url].call!(name, args); }
    async close() { sdk.closed++; }
  },
}));

const { openMcpSession, slug } = await import('../src/ai/mcp.js');
const { encryptJson } = await import('../src/crypto.js');
type Server = Parameters<typeof openMcpSession>[0][number];
const opts = { toolCallId: 'c', messages: [], context: {} } as unknown as Parameters<NonNullable<Awaited<ReturnType<typeof openMcpSession>>['tools'][string]['execute']>>[1];

const server = (o: Partial<Server>): Server => ({
  id: 'id', userId: 'u', name: 'srv', url: 'https://mcp.acme.example/a', transport: 'streamable-http', headersEnc: null,
  enabled: true, lastStatus: null, lastError: null, toolCount: null, createdAt: new Date(), ...o,
}) as Server;

beforeEach(() => { sdk.transports = []; sdk.servers = {}; sdk.closed = 0; });

describe('slug', () => {
  it('makes tool-name prefixes from server names', () => {
    expect(slug('Jira (Prod)!')).toBe('jira_prod');
    expect(slug('___')).toBe('mcp');
    expect(slug('a'.repeat(30))).toHaveLength(20);
  });
});

describe('openMcpSession', () => {
  it('prefixes tools with the server name, passes headers, runs calls and reports them', async () => {
    sdk.servers['https://mcp.acme.example/jira'] = {
      tools: [{ name: 'search', description: 'Find issues', inputSchema: { type: 'object' } }],
      call: (name, args) => ({ structuredContent: { name, args } }),
    };
    sdk.servers['https://mcp.acme.example/wiki'] = { tools: [], fail: 'connection refused' };
    const calls: object[] = [];
    const s = await openMcpSession([
      server({ id: 'j', name: 'Jira Prod', url: 'https://mcp.acme.example/jira', headersEnc: encryptJson({ Authorization: 'Bearer pat' }) }),
      server({ id: 'w', name: 'Wiki', url: 'https://mcp.acme.example/wiki', transport: 'sse' }),
    ], (i) => calls.push({ tool: i.tool, ok: i.ok }));

    expect(Object.keys(s.tools)).toEqual(['jira_prod__search']);
    expect(s.tools.jira_prod__search.description).toBe('[Jira Prod] Find issues');
    expect(sdk.transports[0].opts.requestInit?.headers).toEqual({ Authorization: 'Bearer pat' });
    expect(sdk.transports[1].kind).toBe('sse');
    expect(s.status).toEqual(expect.arrayContaining([
      { serverId: 'j', name: 'Jira Prod', ok: true, tools: 1 },
      { serverId: 'w', name: 'Wiki', ok: false, tools: 0, error: 'connection refused' },
    ]));

    const out = await s.tools.jira_prod__search.execute!({ q: 'x' }, opts);
    expect(out).toEqual({ name: 'search', args: { q: 'x' } });
    expect(calls).toEqual([{ tool: 'search', ok: true }]);
    await s.close();
    expect(sdk.closed).toBe(1);
  });

  it('reports failing tool calls and rethrows', async () => {
    sdk.servers['https://mcp.acme.example/a'] = {
      tools: [{ name: 'boom', inputSchema: { type: 'object' } }],
      call: () => { throw new Error('tool failed'); },
    };
    const calls: { ok: boolean; error?: string }[] = [];
    const s = await openMcpSession([server({})], (i) => calls.push(i));
    await expect(s.tools.srv__boom.execute!({}, opts)).rejects.toThrow('tool failed');
    expect(calls[0]).toMatchObject({ ok: false, error: 'Error: tool failed' });
  });
});
