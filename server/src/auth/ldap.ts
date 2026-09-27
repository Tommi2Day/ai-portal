import { Client } from 'ldapts';
import { config } from '../config.js';
import type { User } from '../db/schema.js';
import { LoginError, upsertExternalUser } from './provision.js';

/** RFC 4515 filter value escaping. */
export const escapeFilter = (s: string) => s.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));

function client() {
  return new Client({
    url: config.LDAP_URL!,
    timeout: 10_000,
    connectTimeout: 10_000,
    // ldapts switches to TLS whenever tlsOptions is set -> only for ldaps://
    ...(config.LDAP_URL!.startsWith('ldaps://') ? { tlsOptions: { rejectUnauthorized: config.LDAP_TLS_REJECT_UNAUTHORIZED } } : {}),
  });
}

async function isMember(c: Client, groupDn: string, userDn: string): Promise<boolean> {
  // Works for groupOfNames (OpenLDAP) and AD groups; for AD nested groups use member:1.2.840.113556.1.4.1941:
  const { searchEntries } = await c.search(groupDn, { scope: 'base', filter: `(member=${escapeFilter(userDn)})`, attributes: ['dn'] });
  return searchEntries.length > 0;
}

/** "CN=KI-Team,OU=Gruppen,DC=firma" -> "KI-Team" */
export const cnOf = (dn: string) => /^cn=((?:\\.|[^,\\])+)/i.exec(dn)?.[1]?.replace(/\\(.)/g, '$1') ?? dn;

async function userGroups(c: Client, userDn: string, memberOf: unknown): Promise<string[]> {
  const direct = ([] as unknown[]).concat(memberOf ?? []).map(String);
  if (direct.length || !config.LDAP_GROUP_SEARCH_BASE) return direct.map(cnOf);
  const { searchEntries } = await c.search(config.LDAP_GROUP_SEARCH_BASE, {
    scope: 'sub', filter: `(|(member=${escapeFilter(userDn)})(uniqueMember=${escapeFilter(userDn)}))`, attributes: ['cn'], sizeLimit: 1000,
  });
  return searchEntries.map((e) => cnOf(e.dn));
}

export async function ldapLogin(username: string, password: string): Promise<User> {
  if (!password) throw new LoginError('Passwort fehlt'); // prevent unauthenticated bind
  const svc = client();
  try {
    await svc.bind(config.LDAP_BIND_DN!, config.LDAP_BIND_PASSWORD!);
    const filter = config.LDAP_SEARCH_FILTER.replaceAll('{{username}}', escapeFilter(username));
    const { searchEntries } = await svc.search(config.LDAP_SEARCH_BASE!, {
      scope: 'sub', filter, sizeLimit: 2,
      attributes: ['dn', config.LDAP_ATTR_DISPLAYNAME, config.LDAP_ATTR_EMAIL, 'memberOf'],
    });
    if (searchEntries.length !== 1) throw new LoginError('Benutzername oder Passwort falsch');
    const entry = searchEntries[0];

    const userClient = client();
    try {
      await userClient.bind(entry.dn, password);
    } catch {
      throw new LoginError('Benutzername oder Passwort falsch');
    } finally {
      await userClient.unbind().catch(() => {});
    }

    if (config.LDAP_USER_GROUP_DN && !(await isMember(svc, config.LDAP_USER_GROUP_DN, entry.dn))) {
      throw new LoginError('Keine Berechtigung für das AI Portal');
    }
    const admin = config.LDAP_ADMIN_GROUP_DN ? await isMember(svc, config.LDAP_ADMIN_GROUP_DN, entry.dn) : null;
    const attr = (name: string) => {
      const key = Object.keys(entry).find((k) => k.toLowerCase() === name.toLowerCase());
      const v = key ? entry[key] : null;
      const s = Array.isArray(v) ? v[0] : v;
      return s ? String(s) : null;
    };
    const groups = await userGroups(svc, entry.dn, entry.memberOf ?? entry.memberof);
    return upsertExternalUser({
      groups,
      source: 'ldap',
      externalId: entry.dn,
      username,
      displayName: attr(config.LDAP_ATTR_DISPLAYNAME),
      email: attr(config.LDAP_ATTR_EMAIL),
      roleFromIdp: admin === null ? null : admin ? 'admin' : 'user',
    });
  } finally {
    await svc.unbind().catch(() => {});
  }
}
