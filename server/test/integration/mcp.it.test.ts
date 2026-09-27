/**
 * Per-user MCP servers against real servers: pg-mcp-server (PostgreSQL) and oracle-mcp-server
 * (Oracle Free). The model is the mock LLM, which calls the MCP tools like a real model would:
 * portal → model → tool call → MCP server → database → result → model → answer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockLlm, toolResults } from './mockLlm.js';
import { adminApi, Api, mcpClient, mcpText, mockProvider, newUser, ORACLE_MCP, PG_MCP, skipOracle } from './helpers.js';

const llm = new MockLlm();
let admin: Api;
let user: Api;
let modelId: string;
let pgServerId: string;

/** Script: call the given tool once, then answer with the tool results. */
const callOnce = (name: string, args: Record<string, unknown>) => (r: Parameters<MockLlm['script']>[0]) =>
  toolResults(r).length ? { text: `Result: ${toolResults(r).join(' || ')}` } : { toolCalls: [{ name, args }] };

const audit = async (action: string) => (await admin.get(`/api/admin/audit?action=${action}&limit=50`)) as any[];

beforeAll(async () => {
  await llm.start();
  admin = await adminApi();
  ({ modelId } = await mockProvider(admin, llm.url, 'Mock MCP'));
  user = (await newUser(admin)).api;

  // test data, written directly through the MCP servers
  const pg = await mcpClient(PG_MCP.url, PG_MCP.token);
  const r = await pg.callTool({ name: 'execute', arguments: { sql:
    `DROP TABLE IF EXISTS backup_jobs;
     CREATE TABLE backup_jobs (job text PRIMARY KEY, status text, fra_used_pct numeric);
     INSERT INTO backup_jobs VALUES ('nightly_rman', 'FAILED', 99.8), ('weekly_full', 'OK', 61.0);` } });
  expect(r.isError).toBeFalsy();
  await pg.close();

  if (!skipOracle) {
    const ora = await mcpClient(ORACLE_MCP.url, ORACLE_MCP.token);
    for (const sql of [
      'DROP TABLE IF EXISTS it_hosts',
      'CREATE TABLE it_hosts (host VARCHAR2(30) PRIMARY KEY, os VARCHAR2(30))',
      "INSERT INTO it_hosts VALUES ('db01', 'Oracle Linux 9')",
      "INSERT INTO it_hosts VALUES ('app01', 'RHEL 9')",
    ]) expect((await ora.callTool({ name: 'execute', arguments: { sql } })).isError, sql).toBeFalsy();
    await ora.close();
  }

  pgServerId = (await user.post('/api/mcp-servers', { name: 'Postgres', url: PG_MCP.url, headers: { Authorization: `Bearer ${PG_MCP.token}` } })).id;
  if (!skipOracle) await user.post('/api/mcp-servers', { name: 'Oracle', url: ORACLE_MCP.url, headers: { Authorization: `Bearer ${ORACLE_MCP.token}` } });
});

afterAll(() => llm.stop());
beforeEach(() => llm.reset());

const newChat = async () => (await user.post('/api/chats', { modelId })).id as string;

describe('MCP server management', () => {
  it('stores headers encrypted and shows only their names', async () => {
    const list = await user.get('/api/mcp-servers');
    const pg = list.find((s: any) => s.name === 'Postgres');
    expect(pg.headerNames).toEqual(['Authorization']);
    expect(JSON.stringify(list)).not.toContain(PG_MCP.token);
  });

  it('"Test" connects and lists the tools of pg-mcp-server', async () => {
    const r = await user.post(`/api/mcp-servers/${pgServerId}/test`);
    expect(r.ok).toBe(true);
    expect(r.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['query', 'execute', 'list_tables', 'describe_table']));
    const [s] = (await user.get('/api/mcp-servers')).filter((x: any) => x.id === pgServerId);
    expect(s).toMatchObject({ lastStatus: 'ok', toolCount: r.tools.length });
  });

  it('"Test" reports a wrong token', async () => {
    const bad = await user.post('/api/mcp-servers', { name: 'Postgres wrong token', url: PG_MCP.url, headers: { Authorization: 'Bearer wrong' }, enabled: false });
    const r = await user.post(`/api/mcp-servers/${bad.id}/test`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401|unauthori[sz]ed|invalid/i);
  });

  it('keeps MCP servers private to their owner', async () => {
    const other = (await newUser(admin)).api;
    expect(await other.get('/api/mcp-servers')).toEqual([]);
    await expect(other.post(`/api/mcp-servers/${pgServerId}/test`)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects non-http URLs', async () => {
    await expect(user.post('/api/mcp-servers', { name: 'x', url: 'file:///etc/passwd' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('chat with pg-mcp-server', () => {
  it('offers the tools of the active servers to the model with server prefix', async () => {
    const chat = await newChat();
    const r = await user.chat(chat, { content: 'Which tools do you have?', modelId });
    expect(r.mcp?.find((s) => s.name === 'Postgres')).toMatchObject({ ok: true });
    const tools = llm.chatRequests()[0].tools!.map((t) => t.function);
    const query = tools.find((t) => t.name === 'postgres__query')!;
    expect(query.description).toMatch(/^\[Postgres\] /);
    expect(query.parameters).toMatchObject({ properties: { sql: { type: 'string' } }, required: ['sql'] });
    expect(tools.map((t) => t.name)).not.toContain('postgres_wrong_token__query'); // disabled server
  });

  it('runs a query through the tool loop and answers with the database result', async () => {
    llm.script = callOnce('postgres__query', { sql: "select job, status, fra_used_pct from backup_jobs where status = 'FAILED'" });
    const chat = await newChat();
    const r = await user.chat(chat, { content: 'Which backup job failed?', modelId });

    expect(r.errors).toEqual([]);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: 'postgres__query' });
    expect(r.toolResults[0].output).toContain('nightly_rman');
    expect(r.text).toContain('nightly_rman');
    expect(r.text).toContain('99.8');

    // second provider request contains the tool result
    const [, second] = llm.chatRequests();
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool' });

    // stored with tool part and usage
    const stored = await user.get(`/api/chats/${chat}`);
    const answer = stored.messages.at(-1);
    expect(answer.parts[0]).toMatchObject({ type: 'tool', name: 'postgres__query' });
    expect(answer.parts[0].output).toContain('nightly_rman');
    expect(answer.usage.outputTokens).toBeGreaterThan(0);

    const [call] = await audit('mcp.tool_call');
    expect(call).toMatchObject({ success: true, details: expect.objectContaining({ server: 'Postgres', tool: 'query' }) });
    const [done] = await audit('chat.completion');
    expect(done.details.toolCalls).toEqual(['postgres__query']);
  });

  it('passes MCP errors (read-only query) back to the model and audits them as failed', async () => {
    llm.script = callOnce('postgres__query', { sql: 'delete from backup_jobs' });
    const r = await user.chat(await newChat(), { content: 'Delete all jobs', modelId });
    expect(r.errors).toEqual([]);
    expect(r.text).toContain('read-only transaction');
    const [call] = await audit('mcp.tool_call');
    expect(call).toMatchObject({ success: false, details: expect.objectContaining({ tool: 'query' }) });

    const pg = await mcpClient(PG_MCP.url, PG_MCP.token);
    expect(mcpText(await pg.callTool({ name: 'query', arguments: { sql: 'select count(*) as n from backup_jobs' } }))).toMatch(/\b2\b/);
    await pg.close();
  });

  it('sends no tools when "MCP tools" is switched off', async () => {
    await user.chat(await newChat(), { content: 'No tools please', modelId, useMcp: false, useKnowledge: false });
    expect(llm.chatRequests()[0].tools).toBeUndefined();
  });

  it('reports an unreachable server and still answers', async () => {
    const dead = await user.post('/api/mcp-servers', { name: 'Dead', url: 'http://127.0.0.1:9/mcp' });
    try {
      const r = await user.chat(await newChat(), { content: 'Hello', modelId });
      expect(r.mcp?.find((s) => s.name === 'Dead')).toMatchObject({ ok: false });
      expect(r.mcp?.find((s) => s.name === 'Postgres')).toMatchObject({ ok: true });
      expect(r.text).toBe('echo: Hello');
    } finally {
      await user.del(`/api/mcp-servers/${dead.id}`);
    }
  });
});

describe.skipIf(skipOracle)('chat with oracle-mcp-server', () => {
  it('runs an Oracle query through the tool loop', async () => {
    llm.script = callOnce('oracle__query', { sql: "SELECT host, os FROM it_hosts WHERE host = 'db01'" });
    const r = await user.chat(await newChat(), { content: 'Which OS runs on db01?', modelId });
    expect(r.errors).toEqual([]);
    expect(r.toolCalls[0]).toMatchObject({ name: 'oracle__query' });
    expect(r.text).toContain('Oracle Linux 9');
  });

  it('describes a table via describe_table', async () => {
    llm.script = callOnce('oracle__describe_table', { table: 'IT_HOSTS' });
    const r = await user.chat(await newChat(), { content: 'Describe IT_HOSTS', modelId });
    expect(r.toolErrors).toEqual([]);
    expect(r.text).toMatch(/HOST/);
    expect(r.text).toMatch(/VARCHAR2/);
  });

  it('calls tools of both servers in one step', async () => {
    llm.script = (req) => toolResults(req).length
      ? { text: `Combined: ${toolResults(req).join(' || ')}` }
      : { toolCalls: [
          { name: 'postgres__query', args: { sql: "select status from backup_jobs where job = 'weekly_full'" } },
          { name: 'oracle__query', args: { sql: "SELECT os FROM it_hosts WHERE host = 'app01'" } },
        ] };
    const r = await user.chat(await newChat(), { content: 'Status of weekly_full and OS of app01?', modelId });
    expect(r.toolCalls.map((c) => c.name).sort()).toEqual(['oracle__query', 'postgres__query']);
    expect(r.text).toContain('OK');
    expect(r.text).toContain('RHEL 9');
  });
});
