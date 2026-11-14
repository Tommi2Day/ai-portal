/**
 * OAuth 2.0 access tokens on /mcp: the real app against PGlite, a local JWKS server and tokens signed by it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { startApp } from './support/app.js';

const ISSUER = 'https://idp.example/realm';
const AUD = 'api://ai-portal';
const jwksServer = vi.hoisted(() => ({ url: '' }));
vi.mock('../src/db/index.js', async () => (await import('./support/pgdb.js')).testDb());
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const keys = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');
const idp = http.createServer(async (_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] }));
});
await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
jwksServer.url = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/jwks`;
process.env.MCP_OAUTH_ISSUER = ISSUER;
process.env.MCP_OAUTH_AUDIENCE = AUD;
process.env.MCP_OAUTH_JWKS_URI = jwksServer.url;
process.env.PUBLIC_URL = 'https://portal.example';

const { db } = await import('../src/db/index.js');
const { users, auditLog } = await import('../src/db/schema.js');
const { eq } = await import('drizzle-orm');
const { config } = await import('../src/config.js');
const { oauthWarnings, protectedResourceMetadata, resetOauthCache, userForClaims } = await import('../src/knowledge/mcpOauth.js');
const { envAssignments, loadAssignments, saveAssignments } = await import('../src/auth/oidcAssignments.js');

const sign = (claims: Record<string, unknown>, o: { key?: CryptoKey; iss?: string; aud?: string; exp?: string } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(o.iss ?? ISSUER).setAudience(o.aud ?? AUD)
    .setIssuedAt().setExpirationTime(o.exp ?? '5m').sign(o.key ?? keys.privateKey);

let app: Awaited<ReturnType<typeof startApp>>;
const mcp = (token?: string) => fetch(app.base + '/mcp', { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });

beforeAll(async () => {
  app = await startApp();
  await db.insert(users).values([
    { username: 'alice', authSource: 'oidc', externalId: 'oid-alice', role: 'user', profileCompleted: true },
    { username: 'gone', authSource: 'oidc', externalId: 'oid-gone', role: 'user', profileCompleted: true, active: false },
  ]);
});
afterAll(async () => { await app.close(); idp.close(); });

describe('/mcp with OAuth access tokens', () => {
  it('advertises protected resource metadata and points 401s at it', async () => {
    const meta = await (await fetch(app.base + '/.well-known/oauth-protected-resource')).json();
    expect(meta).toEqual({ resource: 'https://portal.example/mcp', authorization_servers: [ISSUER], bearer_methods_supported: ['header'], scopes_supported: [`${AUD}/.default`] });
    expect((await fetch(app.base + '/.well-known/oauth-protected-resource/mcp')).status).toBe(200);
    const res = await mcp();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="https://portal.example/.well-known/oauth-protected-resource"');
  });

  it('accepts a valid token of a known OIDC user (object id preferred over sub)', async () => {
    expect((await mcp(await sign({ sub: 'other-sub', oid: 'oid-alice' }))).status).toBe(200);
  });

  it('rejects bad signature, issuer, audience, expiry, unknown and deactivated users — and audits it', async () => {
    const bad = [
      await sign({ sub: 'oid-alice' }, { key: other.privateKey }),
      await sign({ sub: 'oid-alice' }, { iss: 'https://evil.example' }),
      await sign({ sub: 'oid-alice' }, { aud: 'api://other' }),
      await sign({ sub: 'oid-alice' }, { exp: '-5m' }),
      await sign({ sub: 'nobody' }),
      await sign({ sub: 'oid-gone' }),
      'not-a-jwt',
    ];
    for (const t of bad) expect((await mcp(t)).status).toBe(401);
    const failed = await db.select().from(auditLog).where(eq(auditLog.action, 'token.auth_failed'));
    expect(failed.length).toBeGreaterThanOrEqual(bad.length);
  });

  it('accepts only asymmetric algorithms (an HS256 token is rejected)', async () => {
    const hs = await new SignJWT({ sub: 'oid-alice' }).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).setIssuer(ISSUER).setAudience(AUD)
      .setExpirationTime('5m').sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
    expect((await mcp(hs)).status).toBe(401);
    // unsigned token ("alg: none")
    const none = [{ alg: 'none' }, { sub: 'oid-alice', iss: ISSUER, aud: AUD, exp: Math.floor(Date.now() / 1000) + 300 }]
      .map((o) => Buffer.from(JSON.stringify(o)).toString('base64url')).join('.') + '.';
    expect((await mcp(none)).status).toBe(401);
  });

  it('groups come from the token only: a group dropped at the identity provider is not kept from the last sign-in', async () => {
    await db.update(users).set({ groups: ['IT-Ops', 'HR'] }).where(eq(users.username, 'alice'));
    expect((await userForClaims({ sub: 'x', oid: 'oid-alice', groups: ['IT-Ops'] })).groups).toEqual(['IT-Ops']);
    expect((await userForClaims({ sub: 'x', oid: 'oid-alice' })).groups).toEqual([]); // no groups claim -> no groups (fail closed)
  });

  it('warns about risky settings at startup', () => {
    expect(oauthWarnings()).toEqual([]); // https issuer, dedicated audience, one issuer
    const saved = { ...config };
    Object.assign(config, { MCP_OAUTH_ISSUER: 'http://idp.example/realm', MCP_OAUTH_AUDIENCE: undefined, OIDC_CLIENT_ID: 'portal', MCP_OAUTH_ALLOWED_ISSUERS: 'http://idp.example/realm https://other.example' });
    const w = oauthWarnings().join(' | ');
    Object.assign(config, saved);
    delete (config as Record<string, unknown>).MCP_OAUTH_ALLOWED_ISSUERS; // unset keys are absent, so assign() cannot restore them
    if (saved.MCP_OAUTH_AUDIENCE === undefined) delete (config as Record<string, unknown>).MCP_OAUTH_AUDIENCE;
    expect(w).toContain('not https');
    expect(w).toContain('MCP_OAUTH_AUDIENCE is not set');
    expect(w).toContain('several issuers');
  });

  it('finds the key set through the issuer discovery document; discovery failures deny access', async () => {
    const real = globalThis.fetch;
    let mode: 'ok' | 'http500' | 'nokeys' = 'ok';
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith('/.well-known/openid-configuration')) {
        if (mode === 'http500') return new Response('x', { status: 500 });
        return Response.json(mode === 'nokeys' ? {} : { jwks_uri: jwksServer.url });
      }
      return real(input, init);
    });
    const saved = config.MCP_OAUTH_JWKS_URI;
    Object.assign(config, { MCP_OAUTH_JWKS_URI: undefined });
    try {
      resetOauthCache();
      expect((await mcp(await sign({ sub: 'oid-alice' }))).status).toBe(200);
      for (const m of ['http500', 'nokeys'] as const) {
        mode = m; resetOauthCache();
        expect((await mcp(await sign({ sub: 'oid-alice' }))).status, m).toBe(401);
      }
    } finally {
      Object.assign(config, { MCP_OAUTH_JWKS_URI: saved });
      vi.unstubAllGlobals();
      resetOauthCache();
    }
  });

  it('protected resource metadata is not served when OAuth is off', () => {
    const calls: number[] = [];
    const res = { status: (c: number) => ({ end: () => { calls.push(c); } }), json: () => { calls.push(200); } };
    const saved = config.MCP_OAUTH_ISSUER;
    Object.assign(config, { MCP_OAUTH_ISSUER: undefined });
    try { protectedResourceMetadata({} as never, res as never); } finally { Object.assign(config, { MCP_OAUTH_ISSUER: saved }); }
    expect(calls).toEqual([404]);
    expect(oauthWarnings()).toEqual([]);
  });

  it('SSO assignments: stored list comes from settings, environment lists are shown read-only', async () => {
    await saveAssignments([{ type: 'group', value: 'g1', admin: true }]);
    expect(await loadAssignments()).toEqual([{ type: 'group', value: 'g1', admin: true }]);
    Object.assign(config, { OIDC_ALLOWED_GROUPS: 'a, b', OIDC_ALLOWED_USERS: '*@x.example', OIDC_ADMIN_GROUPS: 'adm', OIDC_ADMIN_USERS: 'root@x.example' });
    try {
      expect(envAssignments()).toEqual([
        { type: 'group', value: 'a', admin: false }, { type: 'group', value: 'b', admin: false }, { type: 'user', value: '*@x.example', admin: false },
        { type: 'group', value: 'adm', admin: true }, { type: 'user', value: 'root@x.example', admin: true },
      ]);
    } finally {
      for (const k of ['OIDC_ALLOWED_GROUPS', 'OIDC_ALLOWED_USERS', 'OIDC_ADMIN_GROUPS', 'OIDC_ADMIN_USERS']) delete (config as Record<string, unknown>)[k];
    }
    expect(envAssignments()).toEqual([]);
    await saveAssignments([]);
  });
});
