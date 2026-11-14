/**
 * OIDC sign-in end to end through the real app (start -> callback -> session), against PGlite. Only the identity
 * provider client (openid-client) is replaced: it returns the claims a provider would put into the ID token.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startApp } from './support/app.js';

const idp = vi.hoisted(() => ({ claims: {} as Record<string, unknown>, checks: [] as unknown[], authParams: {} as Record<string, string> }));
vi.mock('../src/db/index.js', async () => (await import('./support/pgdb.js')).testDb());
vi.mock('openid-client', () => ({
  generators: { codeVerifier: () => 'verifier-1', state: () => 'state-1', nonce: () => 'nonce-1', codeChallenge: (v: string) => `challenge-of-${v}` },
  Issuer: {
    discover: async () => ({
      Client: class {
        authorizationUrl(p: Record<string, string>) { idp.authParams = p; return `https://idp.example/auth?${new URLSearchParams(p)}`; }
        callbackParams() { return { code: 'code-1', state: 'state-1' }; }
        async callback(_redirect: string, _params: unknown, checks: unknown) { idp.checks.push(checks); return { claims: () => idp.claims }; }
      },
    }),
  },
}));
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

process.env.OIDC_ENABLED = 'true';
process.env.OIDC_ISSUER = 'https://idp.example';
process.env.OIDC_CLIENT_ID = 'portal';
process.env.OIDC_ADMIN_GROUPS = 'grp-admin';
process.env.PUBLIC_URL = 'https://portal.example';

const { db } = await import('../src/db/index.js');
const { auditLog, users } = await import('../src/db/schema.js');
const { saveAssignments } = await import('../src/auth/oidcAssignments.js');
const { eq } = await import('drizzle-orm');

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

/** Browser round trip: /oidc/start, then the provider redirects back to /oidc/callback. */
async function signIn(claims: Record<string, unknown>, opts: { dropFlowCookie?: boolean } = {}) {
  idp.claims = claims;
  const start = await fetch(`${app.base}/api/auth/oidc/start`, { redirect: 'manual' });
  expect(start.status).toBe(302);
  const flow = opts.dropFlowCookie ? '' : cookiesOf(start);
  const cb = await fetch(`${app.base}/api/auth/oidc/callback?code=code-1&state=state-1`, { redirect: 'manual', headers: { cookie: flow } });
  const location = cb.headers.get('location') ?? '';
  const session = cookiesOf(cb);
  const me = session && location === '/' ? await (await fetch(`${app.base}/api/auth/me`, { headers: { cookie: session } })).json() : null;
  return { start, location, session, me };
}

const alice = { sub: 'sub-alice', oid: 'oid-alice', preferred_username: 'Alice@Example.com', name: 'Alice Example', email: 'alice@example.com', groups: ['grp-users'] };

describe('OIDC sign-in', () => {
  it('start: PKCE challenge, state and nonce in a signed HttpOnly flow cookie, redirect to the provider', async () => {
    const r = await signIn(alice);
    expect(r.start.headers.get('location')).toMatch(/^https:\/\/idp\.example\/auth\?/);
    expect(idp.authParams).toMatchObject({ scope: 'openid profile email', code_challenge: 'challenge-of-verifier-1', code_challenge_method: 'S256', state: 'state-1', nonce: 'nonce-1' });
    const flowCookie = r.start.headers.getSetCookie().find((c) => c.startsWith('ap_oidc='))!;
    expect(flowCookie).toMatch(/HttpOnly/i);
    expect(flowCookie).toMatch(/Path=\/api\/auth\/oidc/);
    // the callback hands verifier, state and nonce from the flow cookie to the client
    expect(idp.checks.at(-1)).toMatchObject({ code_verifier: 'verifier-1', state: 'state-1', nonce: 'nonce-1' });
  });

  it('callback provisions the user from the claims and issues a session', async () => {
    const r = await signIn(alice);
    expect(r.location).toBe('/');
    expect(r.me).toMatchObject({ username: 'alice@example.com', displayName: 'Alice Example', authSource: 'oidc', role: 'user', groups: ['grp-users'] });
    const [row] = await db.select().from(users).where(eq(users.username, 'alice@example.com'));
    expect(row).toMatchObject({ externalId: 'oid-alice', email: 'alice@example.com' });
    const logins = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.login'));
    expect(logins.some((l) => (l.details as { method?: string })?.method === 'oidc' && l.username === 'alice@example.com')).toBe(true);
  });

  it('admin by group, and the role follows the identity provider on every sign-in', async () => {
    expect((await signIn({ ...alice, groups: ['grp-users', 'GRP-ADMIN'] })).me).toMatchObject({ role: 'admin' });
    expect((await signIn(alice)).me).toMatchObject({ role: 'user', groups: ['grp-users'] }); // removed from the admin group -> demoted
  });

  it('a missing or expired flow cookie ends in the login page with a message', async () => {
    const r = await signIn(alice, { dropFlowCookie: true });
    expect(r.location).toMatch(/^\/login\?error=/);
    expect(r.session).toBe('');
  });

  it('once an allow list exists only matching users (and admins) may sign in; denials are audited', async () => {
    await saveAssignments([{ type: 'group', value: 'grp-ok', admin: false }]);
    const denied = await signIn({ sub: 'sub-eve', preferred_username: 'eve@example.com', email: 'eve@example.com', groups: ['grp-other'] });
    expect(denied.location).toMatch(/^\/login\?error=/);
    expect(denied.me).toBeNull();
    expect(await db.select().from(users).where(eq(users.username, 'eve@example.com'))).toEqual([]); // no account for denied users
    expect((await signIn({ ...alice, groups: ['grp-ok'] })).me).toMatchObject({ username: 'alice@example.com' });
    expect((await signIn({ sub: 'sub-root', preferred_username: 'root@example.com', groups: ['grp-admin'] })).me).toMatchObject({ role: 'admin' }); // admins always pass
    const failed = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.login_failed'));
    expect(failed.some((f) => (f.details as { method?: string })?.method === 'oidc')).toBe(true);
    await saveAssignments([]);
  });

  it('a username already used by another sign-in source is refused (no account takeover)', async () => {
    await db.insert(users).values({ username: 'admin@example.com', authSource: 'local', role: 'admin', passwordHash: 'x', profileCompleted: true });
    const r = await signIn({ sub: 'sub-evil', preferred_username: 'admin@example.com', email: 'admin@example.com', groups: [] });
    expect(r.location).toMatch(/^\/login\?error=/);
    expect(r.me).toBeNull();
    const [local] = await db.select().from(users).where(eq(users.username, 'admin@example.com'));
    expect(local).toMatchObject({ authSource: 'local', role: 'admin' });
  });
});
