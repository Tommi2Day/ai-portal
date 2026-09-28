import { beforeEach, describe, expect, it, vi } from 'vitest';

type Entry = Record<string, unknown> & { dn: string };
const ldap = vi.hoisted(() => ({
  users: {} as Record<string, string>,           // dn -> password
  entries: [] as { dn: string; [k: string]: unknown }[],
  groups: {} as Record<string, string[]>,        // group dn -> member dns
  groupSearch: [] as { dn: string }[],
  searches: [] as { base: string; filter: string }[],
  clients: [] as { url: string; tlsOptions?: unknown }[],
}));

vi.mock('ldapts', () => ({
  Client: class {
    constructor(opts: { url: string; tlsOptions?: unknown }) { ldap.clients.push(opts); }
    async bind(dn: string, pw: string) {
      if (dn === 'cn=svc' && pw === 'svc-pw') return;
      if (ldap.users[dn] !== pw) throw new Error('invalid credentials');
    }
    async unbind() {}
    async search(base: string, o: { filter: string; scope: string }) {
      ldap.searches.push({ base, filter: o.filter });
      if (o.scope === 'base') {
        const member = /\(member=(.*)\)/.exec(o.filter)![1];
        return { searchEntries: (ldap.groups[base] ?? []).includes(member.replaceAll('\\3d', '=')) ? [{ dn: base }] : [] };
      }
      if (base === 'ou=groups') return { searchEntries: ldap.groupSearch };
      return { searchEntries: ldap.entries };
    }
  },
}));

const upsert = vi.hoisted(() => vi.fn(async (u: object) => u));
vi.mock('../src/auth/provision.js', async (orig) => ({ ...(await orig<object>()), upsertExternalUser: upsert }));

const { config } = await import('../src/config.js');
const { ldapLogin } = await import('../src/auth/ldap.js');

const UID = 'uid=anna,ou=users';
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(ldap, { users: { [UID]: 'geheim' }, groups: {}, groupSearch: [], searches: [], clients: [] });
  ldap.entries = [{ dn: UID, displayName: ['Anna Beispiel'], MAIL: 'anna@acme.example', memberOf: ['CN=KI-Team,OU=Gruppen,DC=acme'] } as Entry];
  Object.assign(config, {
    LDAP_URL: 'ldaps://dc.acme.example:636', LDAP_BIND_DN: 'cn=svc', LDAP_BIND_PASSWORD: 'svc-pw', LDAP_SEARCH_BASE: 'ou=users',
    LDAP_SEARCH_FILTER: '(uid={{username}})', LDAP_USER_GROUP_DN: undefined, LDAP_ADMIN_GROUP_DN: undefined, LDAP_GROUP_SEARCH_BASE: undefined,
    LDAP_TLS_REJECT_UNAUTHORIZED: true,
  });
});

describe('ldapLogin', () => {
  it('binds as the user and provisions name, e-mail (case-insensitive attribute) and memberOf groups', async () => {
    await ldapLogin('anna', 'geheim');
    expect(ldap.searches[0]).toEqual({ base: 'ou=users', filter: '(uid=anna)' });
    expect(ldap.clients[0]).toMatchObject({ url: 'ldaps://dc.acme.example:636', tlsOptions: { rejectUnauthorized: true } });
    expect(upsert).toHaveBeenCalledWith({
      groups: ['KI-Team'], source: 'ldap', externalId: UID, username: 'anna',
      displayName: 'Anna Beispiel', email: 'anna@acme.example', roleFromIdp: null,
    });
  });

  it('escapes the user name in the search filter and rejects empty passwords', async () => {
    ldap.entries = [];
    await expect(ldapLogin('a*)(uid=*', 'x')).rejects.toThrow('Benutzername oder Passwort falsch');
    expect(ldap.searches[0].filter).toBe('(uid=a\\2a\\29\\28uid=\\2a)');
    await expect(ldapLogin('anna', '')).rejects.toThrow('Passwort fehlt');
  });

  it('rejects a wrong password', async () => {
    await expect(ldapLogin('anna', 'falsch')).rejects.toThrow('Benutzername oder Passwort falsch');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('checks the user group and derives the admin role from the admin group', async () => {
    config.LDAP_USER_GROUP_DN = 'cn=portal-users';
    config.LDAP_ADMIN_GROUP_DN = 'cn=portal-admins';
    await expect(ldapLogin('anna', 'geheim')).rejects.toThrow('Keine Berechtigung');
    ldap.groups = { 'cn=portal-users': [UID], 'cn=portal-admins': [UID] };
    await ldapLogin('anna', 'geheim');
    expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ roleFromIdp: 'admin' }));
    ldap.groups = { 'cn=portal-users': [UID] };
    await ldapLogin('anna', 'geheim');
    expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ roleFromIdp: 'user' }));
  });

  it('searches groups when the entry has no memberOf; plain ldap:// without TLS options', async () => {
    config.LDAP_URL = 'ldap://ldap.acme.example';
    config.LDAP_GROUP_SEARCH_BASE = 'ou=groups';
    ldap.entries = [{ dn: UID, displayName: 'Anna' }];
    ldap.groupSearch = [{ dn: 'cn=Ops,ou=groups' }, { dn: 'cn=Team\\, Nord,ou=groups' }];
    await ldapLogin('anna', 'geheim');
    expect(ldap.clients[0].tlsOptions).toBeUndefined();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ groups: ['Ops', 'Team, Nord'], email: null }));
  });
});
