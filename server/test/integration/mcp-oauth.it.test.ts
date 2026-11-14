/**
 * pg-mcp-server with and without OAuth, against real components (no mocks): Keycloak issues the tokens, the portal
 * fetches them (OAuth client credentials per MCP server) and calls pg-mcp-server → PostgreSQL. Also the portal's own
 * /mcp endpoint with a Keycloak access token.
 *
 *   pg-mcp          static bearer token only (covered by mcp.it.test.ts)
 *   pg-mcp-oauth    Keycloak access tokens, group grp-pg; AUTH_TOKEN as break-glass
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { MockLlm, toolResults } from './mockLlm.js';
import {
  adminApi, Api, KEYCLOAK, keycloakToken, mcpClient, mcpText, mockProvider, newUser, PG_MCP, PG_MCP_OAUTH, portalUrl,
} from './helpers.js';

const llm = new MockLlm();
let admin: Api;
let user: Api;
let modelId: string;

const oauth = (c: { clientId: string; clientSecret: string }, scope = 'openid') => ({ tokenUrl: KEYCLOAK.tokenUrl, clientId: c.clientId, clientSecret: c.clientSecret, scope });
const addServer = async (name: string, body: Record<string, unknown>) =>
  (await user.post('/api/mcp-servers', { name, url: PG_MCP_OAUTH.url, ...body })).id as string;
const test = async (id: string) => (await user.post(`/api/mcp-servers/${id}/test`)) as { ok: boolean; tools?: { name: string }[]; error?: string };

beforeAll(async () => {
  await llm.start();
  admin = await adminApi();
  ({ modelId } = await mockProvider(admin, llm.url, 'Mock OAuth'));
  user = (await newUser(admin)).api;
  const db = await mcpClient(PG_MCP.url, PG_MCP.token);
  const r = await db.callTool({ name: 'execute', arguments: { sql:
    `DROP TABLE IF EXISTS oauth_hosts;
     CREATE TABLE oauth_hosts (host text PRIMARY KEY, owner text);
     INSERT INTO oauth_hosts VALUES ('db01', 'dba-team'), ('app01', 'app-team');` } });
  expect(r.isError).toBeFalsy();
  await db.close();
});

afterAll(() => llm.stop());
beforeEach(() => llm.reset());

describe('real Keycloak and pg-mcp-server with OAuth', () => {
  it('Keycloak issues tokens with the groups and audience pg-mcp-server expects', async () => {
    const [, payload] = (await keycloakToken(KEYCLOAK.allowed)).split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims.iss).toBe(KEYCLOAK.issuer);
    expect(claims.aud).toEqual(expect.arrayContaining(['api://pg-mcp', 'api://ai-portal']));
    expect(claims.groups).toEqual(['grp-pg']);
    expect(claims.sub).toBe(KEYCLOAK.allowed.subject);
  });

  it('the OAuth server rejects anonymous clients and points them at the protected resource metadata', async () => {
    const res = await fetch(PG_MCP_OAUTH.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata');
    const meta = await (await fetch(new URL('/.well-known/oauth-protected-resource', PG_MCP_OAUTH.url))).json();
    expect(meta.authorization_servers).toContain(KEYCLOAK.issuer);
  });

  it('without OAuth: the plain pg-mcp-server does not know OAuth tokens', async () => {
    await expect(mcpClient(PG_MCP.url, await keycloakToken(KEYCLOAK.allowed))).rejects.toThrow();
  });
});

describe('portal → pg-mcp-server with OAuth client credentials', () => {
  it('connects with a token the portal fetched itself; secret is write-only', async () => {
    const id = await addServer('PG OAuth', { oauth: oauth(KEYCLOAK.allowed) });
    const r = await test(id);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(['query', 'execute']));
    const view = (await user.get('/api/mcp-servers')).find((s: any) => s.id === id);
    expect(view.oauth).toEqual({ tokenUrl: KEYCLOAK.tokenUrl, clientId: 'portal-it', scope: 'openid' });
    expect(JSON.stringify(view)).not.toContain('portal-it-secret');
    expect(((await admin.get('/api/admin/audit?action=mcp.create&limit=50')) as any[]).some((a) => a.details?.oauth === true)).toBe(true);
  });

  it('runs a query through the tool loop: portal → model → MCP tool → pg-mcp-oauth → PostgreSQL', async () => {
    const chatId = (await user.post('/api/chats', { modelId })).id as string;
    llm.script = (r) => toolResults(r).length
      ? { text: `Result: ${toolResults(r).join(' || ')}` }
      : { toolCalls: [{ name: 'pg_oauth__query', args: { sql: "select owner from oauth_hosts where host = 'db01'" } }] };
    const r = await user.chat(chatId, { content: 'Who owns db01?', modelId, useMcp: true });
    expect(r.mcp?.find((s) => s.name === 'PG OAuth')).toMatchObject({ ok: true });
    expect(r.toolCalls[0]).toMatchObject({ name: 'pg_oauth__query' });
    expect(r.toolErrors).toEqual([]);
    expect(r.text).toContain('dba-team');
  });

  it('a static Authorization header (break-glass AUTH_TOKEN) works next to OAuth', async () => {
    const id = await addServer('PG break-glass', { headers: { Authorization: `Bearer ${PG_MCP_OAUTH.adminToken}` } });
    expect((await test(id)).ok).toBe(true);
  });

  it('OAuth replaces a static Authorization header', async () => {
    const id = await addServer('PG both', { headers: { Authorization: 'Bearer wrong' }, oauth: oauth(KEYCLOAK.allowed) });
    expect((await test(id)).ok).toBe(true);
  });

  it('fails without credentials, with a wrong secret, and for a client outside the allowed group', async () => {
    expect((await test(await addServer('PG none', {}))).ok).toBe(false);

    const wrong = await test(await addServer('PG wrong secret', { oauth: oauth({ clientId: 'portal-it', clientSecret: 'nope' }) }));
    expect(wrong).toMatchObject({ ok: false, error: expect.stringContaining('OAuth-Token') });

    const denied = await test(await addServer('PG denied', { oauth: oauth(KEYCLOAK.denied) }));
    expect(denied.ok).toBe(false); // valid token, but grp-other is not assigned (deny by default)
    expect((await user.get('/api/mcp-servers')).find((s: any) => s.name === 'PG denied')).toMatchObject({ lastStatus: 'error' });
  });

  it('the plain pg-mcp-server keeps working with its static token (without OAuth)', async () => {
    const id = await addServer('PG plain', { url: PG_MCP.url, headers: { Authorization: `Bearer ${PG_MCP.token}` } });
    expect((await test(id)).ok).toBe(true);
  });
});

describe('portal /mcp with a Keycloak access token', () => {
  let adminDb: pg.Client;
  beforeAll(async () => {
    adminDb = new pg.Client({ connectionString: inject('portalDbUrl') });
    await adminDb.connect();
  });
  afterAll(() => adminDb.end());

  it('advertises its protected resource metadata and challenges anonymous clients', async () => {
    const meta = await (await fetch(`${portalUrl()}/.well-known/oauth-protected-resource`)).json();
    expect(meta).toMatchObject({ resource: `${portalUrl()}/mcp`, authorization_servers: [KEYCLOAK.issuer] });
    const res = await fetch(`${portalUrl()}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata');
  });

  it('accepts the token of a known SSO user, denies unknown subjects, audits the denial', async () => {
    const token = await keycloakToken(KEYCLOAK.allowed);
    // not signed in to the portal yet → deny by default
    await expect(mcpClient(`${portalUrl()}/mcp`, token)).rejects.toThrow();

    // the SSO user as the OIDC login would have provisioned it (externalId = Keycloak subject)
    await adminDb.query(
      "INSERT INTO users (username, auth_source, external_id, role, profile_completed, groups) VALUES ('portal-it', 'oidc', $1, 'user', true, '[]')",
      [KEYCLOAK.allowed.subject]);
    const client = await mcpClient(`${portalUrl()}/mcp`, token);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['sammlungen_auflisten', 'wissensdatenbank_suchen']));
    expect(mcpText(await client.callTool({ name: 'sammlungen_auflisten', arguments: {} }))).toBeTypeOf('string');
    await client.close();

    await expect(mcpClient(`${portalUrl()}/mcp`, await keycloakToken(KEYCLOAK.denied))).rejects.toThrow();
    const failed = (await admin.get('/api/admin/audit?action=token.auth_failed&limit=50')) as any[];
    expect(failed.some((a) => String(a.details?.reason).startsWith('oauth:'))).toBe(true);
  });

  it('refuses a deactivated user', async () => {
    await adminDb.query("UPDATE users SET active = false WHERE username = 'portal-it'");
    await expect(mcpClient(`${portalUrl()}/mcp`, await keycloakToken(KEYCLOAK.allowed))).rejects.toThrow();
    await adminDb.query("UPDATE users SET active = true WHERE username = 'portal-it'");
  });
});
