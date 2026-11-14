import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { evaluateClaims } from '../src/auth/oidc.js';

const keys = ['OIDC_ALLOWED_GROUPS', 'OIDC_ALLOWED_USERS', 'OIDC_ADMIN_GROUPS', 'OIDC_ADMIN_USERS', 'OIDC_ADMIN_VALUE', 'OIDC_USER_VALUE', 'OIDC_REQUIRE_VERIFIED_EMAIL'] as const;
const set = (o: Partial<Record<(typeof keys)[number], string | boolean>>) => Object.assign(config, o);
afterEach(() => { for (const k of keys) delete (config as Record<string, unknown>)[k]; config.OIDC_REQUIRE_VERIFIED_EMAIL = false; });

const alice = { sub: 's1', oid: 'oid-1', email: 'Alice@Example.com', groups: ['Grp-Users', 'grp-dba'] };

describe('evaluateClaims', () => {
  it('without any restriction everyone is allowed, role stays managed in the portal', () => {
    expect(evaluateClaims(alice)).toMatchObject({ allowed: true, admin: false, roleFromIdp: null, email: 'Alice@Example.com' });
  });

  it('admin by group, e-mail, *@domain and object id (case-insensitive)', () => {
    set({ OIDC_ADMIN_GROUPS: 'GRP-DBA' });
    expect(evaluateClaims(alice)).toMatchObject({ admin: true, roleFromIdp: 'admin' });
    set({ OIDC_ADMIN_GROUPS: '', OIDC_ADMIN_USERS: 'alice@example.com' });
    expect(evaluateClaims(alice).admin).toBe(true);
    set({ OIDC_ADMIN_USERS: '*@example.com' });
    expect(evaluateClaims(alice).admin).toBe(true);
    set({ OIDC_ADMIN_USERS: 'OID-1' });
    expect(evaluateClaims(alice).admin).toBe(true);
    expect(evaluateClaims({ sub: 'x', email: 'bob@evil.example' })).toMatchObject({ admin: false, roleFromIdp: 'user' });
  });

  it('allowed groups/users are deny by default; admins always pass', () => {
    set({ OIDC_ALLOWED_GROUPS: 'grp-users' });
    expect(evaluateClaims(alice).allowed).toBe(true);
    expect(evaluateClaims({ sub: 'x', email: 'bob@example.com', groups: ['other'] }).allowed).toBe(false);
    set({ OIDC_ALLOWED_USERS: '*@example.com' });
    expect(evaluateClaims({ sub: 'x', email: 'bob@example.com' }).allowed).toBe(true);
    set({ OIDC_ADMIN_USERS: 'root@other.example' });
    expect(evaluateClaims({ sub: 'y', email: 'root@other.example' }).allowed).toBe(true);
  });

  it('does not trust unverified e-mails for matching', () => {
    set({ OIDC_ADMIN_USERS: '*@example.com' });
    expect(evaluateClaims({ sub: 'x', email: 'eve@example.com', email_verified: false })).toMatchObject({ admin: false, email: null });
    set({ OIDC_REQUIRE_VERIFIED_EMAIL: true });
    expect(evaluateClaims({ sub: 'x', email: 'eve@example.com' }).admin).toBe(false); // no claim, verification required
    expect(evaluateClaims({ sub: 'x', email: 'eve@example.com', email_verified: true }).admin).toBe(true);
  });

  it('keeps the role-claim values OIDC_ADMIN_VALUE / OIDC_USER_VALUE working', () => {
    set({ OIDC_ADMIN_VALUE: 'AiPortal.Admin', OIDC_USER_VALUE: 'AiPortal.User' });
    expect(evaluateClaims({ sub: 'a', roles: ['AiPortal.Admin'] })).toMatchObject({ allowed: true, admin: true });
    expect(evaluateClaims({ sub: 'u', roles: ['AiPortal.User'] })).toMatchObject({ allowed: true, admin: false });
    expect(evaluateClaims({ sub: 'n', roles: [] }).allowed).toBe(false);
  });

  it('GUI assignments: admin entries grant admin without restricting, plain entries form the allow list', () => {
    const adminOnly = [{ type: 'group' as const, value: 'GRP-DBA', admin: true }];
    expect(evaluateClaims(alice, adminOnly)).toMatchObject({ admin: true, allowed: true, roleFromIdp: 'admin' });
    expect(evaluateClaims({ sub: 'x', groups: ['other'] }, adminOnly)).toMatchObject({ admin: false, allowed: true, roleFromIdp: 'user' });
    const allow = [...adminOnly, { type: 'user' as const, value: '*@example.com', admin: false }];
    expect(evaluateClaims({ sub: 'x', email: 'bob@example.com' }, allow)).toMatchObject({ allowed: true, admin: false });
    expect(evaluateClaims({ sub: 'x', email: 'bob@evil.example' }, allow).allowed).toBe(false);
    expect(evaluateClaims(alice, allow).allowed).toBe(true);
  });
});
