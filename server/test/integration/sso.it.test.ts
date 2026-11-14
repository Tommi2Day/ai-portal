/**
 * SSO sign-in against a real Keycloak: the complete browser round trip (portal /oidc/start -> Keycloak login form ->
 * portal /oidc/callback) with authorization code + PKCE, ID token validation, groups claim, admin by group and the
 * allow list managed in the admin UI. Nothing in the chain is mocked.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, Api, KEYCLOAK, portalUrl } from './helpers.js';

/** Keycloak announces its in-network name (so containers can use it); the host reaches it on 127.0.0.1. */
const kcOrigin = new URL(KEYCLOAK.base).origin;
const rewrite = (url: string) => { const u = new URL(url, kcOrigin); return u.hostname === 'keycloak' ? `${kcOrigin}${u.pathname}${u.search}` : u.href; };

/** Minimal cookie jar per origin (enough for the Keycloak login and the portal flow cookie). */
class Jar {
  private cookies = new Map<string, Map<string, string>>();
  store(url: string, res: Response) {
    const origin = new URL(url).origin;
    const jar = this.cookies.get(origin) ?? new Map<string, string>();
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c)) jar.delete(pair.slice(0, i)); else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    this.cookies.set(origin, jar);
  }
  header(url: string) { return [...(this.cookies.get(new URL(url).origin) ?? [])].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function get(jar: Jar, url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers as object), cookie: jar.header(url) } });
  jar.store(url, res);
  return res;
}

/** Signs in through Keycloak like a browser; returns where the portal sent the browser and the portal session. */
async function ssoLogin(username: string, password: string) {
  const jar = new Jar();
  const start = await get(jar, `${portalUrl()}/api/auth/oidc/start`);
  expect(start.status).toBe(302);
  const authUrl = rewrite(start.headers.get('location')!);

  let page = await get(jar, authUrl);
  for (let i = 0; i < 3 && page.status === 302; i++) page = await get(jar, rewrite(page.headers.get('location')!));
  expect(page.status).toBe(200);
  const html = await page.text();
  const form = /<form\b[^>]*\bid="kc-form-login"[^>]*>/.exec(html)?.[0];
  if (!form) throw new Error(`no Keycloak login form in: ${html.slice(0, 400)}`);
  const action = rewrite(/\baction="([^"]+)"/.exec(form)![1].replaceAll('&amp;', '&'));

  const post = await get(jar, action, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, credentialId: '' }),
  });
  if (post.status !== 302) throw new Error(`Keycloak login did not redirect (HTTP ${post.status}): ${(await post.text()).slice(0, 300)}`);
  const callback = post.headers.get('location')!;
  expect(callback.startsWith(`${portalUrl()}/api/auth/oidc/callback`)).toBe(true);

  const done = await get(jar, callback);
  const location = done.headers.get('location') ?? '';
  const session = done.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
  const me = session && location === '/' ? await (await fetch(`${portalUrl()}/api/auth/me`, { headers: { cookie: session } })).json() : null;
  return { location, session, me };
}

let admin: Api;
beforeAll(async () => { admin = await adminApi(); });
afterEach(async () => { await admin.put('/api/admin/sso/assignments', { assignments: [] }); });

describe('SSO sign-in with Keycloak', () => {
  it('the sign-in page offers SSO with the configured label', async () => {
    const cfg = await (await fetch(`${portalUrl()}/api/auth/config`)).json();
    expect(cfg.oidc).toEqual({ name: 'SSO' });
  });

  it('signs a user in and provisions the account from the ID token (groups claim, e-mail, name)', async () => {
    const r = await ssoLogin('alice', 'alice');
    expect(r.location).toBe('/');
    expect(r.me).toMatchObject({ username: 'alice', displayName: 'Alice Test', email: 'alice@example.com', authSource: 'oidc', role: 'user', groups: ['grp-pg'] });
    const listed = (await admin.get('/api/admin/users')) as { username: string; authSource: string }[];
    expect(listed.find((u) => u.username === 'alice')).toMatchObject({ authSource: 'oidc' });
    // the session works like any other
    const api = new Api(); api.cookie = r.session;
    expect(((await api.get('/api/auth/me')) as { username: string }).username).toBe('alice');
  });

  it('admin by group: members of grp-admin become admins and can use the admin API', async () => {
    const r = await ssoLogin('root', 'root');
    expect(r.me).toMatchObject({ username: 'root', role: 'admin', groups: ['grp-admin'] });
    const api = new Api(); api.cookie = r.session;
    expect(Array.isArray(await api.get('/api/admin/users'))).toBe(true);
    // a plain user is not admin
    const bob = await ssoLogin('bob', 'bob');
    const bobApi = new Api(); bobApi.cookie = bob.session;
    await expect(bobApi.get('/api/admin/users')).rejects.toMatchObject({ status: 403 });
  });

  it('an allow list from the admin UI denies everyone else; admins always pass', async () => {
    await admin.put('/api/admin/sso/assignments', { assignments: [{ type: 'group', value: 'grp-pg', admin: false }] });
    const bob = await ssoLogin('bob', 'bob');
    expect(bob.location).toMatch(/^\/login\?error=/);
    expect(bob.session).toBe('');
    expect((await ssoLogin('alice', 'alice')).me).toMatchObject({ username: 'alice' });
    expect((await ssoLogin('root', 'root')).me).toMatchObject({ role: 'admin' });
    const failed = (await admin.get('/api/admin/audit?action=auth.login_failed&limit=50')) as { details?: { method?: string } }[];
    expect(failed.some((a) => a.details?.method === 'oidc')).toBe(true);
  });

  it('admin assignment in the admin UI by e-mail grants the admin role at the next sign-in', async () => {
    await admin.put('/api/admin/sso/assignments', { assignments: [{ type: 'user', value: 'alice@example.com', admin: true }] });
    expect((await ssoLogin('alice', 'alice')).me).toMatchObject({ username: 'alice', role: 'admin' });
    await admin.put('/api/admin/sso/assignments', { assignments: [] });
    expect((await ssoLogin('alice', 'alice')).me).toMatchObject({ role: 'user' }); // the role follows the identity provider: demoted again
  });

  it('a wrong password at Keycloak never reaches the portal', async () => {
    await expect(ssoLogin('alice', 'wrong')).rejects.toThrow(/did not redirect|no Keycloak login form/);
  });
});
