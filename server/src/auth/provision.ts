import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, type User } from '../db/schema.js';

export class LoginError extends Error {}

/**
 * Just-in-time provisioning for LDAP/OIDC users.
 * roleFromIdp === null  -> keep the role stored in the portal (managed by admins in the UI)
 */
export async function upsertExternalUser(p: {
  source: 'ldap' | 'oidc';
  externalId: string;
  username: string;
  displayName?: string | null;
  email?: string | null;
  roleFromIdp: 'admin' | 'user' | null;
  groups?: string[];
}): Promise<User> {
  const username = p.username.toLowerCase();
  const [byExt] = await db.select().from(users).where(and(eq(users.authSource, p.source), eq(users.externalId, p.externalId)));
  const [byName] = byExt ? [byExt] : await db.select().from(users).where(eq(users.username, username));

  if (byName && byName.authSource !== p.source) {
    throw new LoginError(`Benutzername ${username} ist bereits einer anderen Anmeldequelle zugeordnet`);
  }
  const values = {
    displayName: p.displayName ?? null,
    email: p.email ?? null,
    externalId: p.externalId,
    lastLoginAt: new Date(),
    ...(p.groups ? { groups: [...new Set(p.groups)].sort() } : {}),
    ...(p.roleFromIdp ? { role: p.roleFromIdp } : {}),
  };
  if (byName) {
    if (!byName.active) throw new LoginError('Benutzer ist deaktiviert');
    const [u] = await db.update(users).set(values).where(eq(users.id, byName.id)).returning();
    return u;
  }
  const [u] = await db.insert(users).values({ username, authSource: p.source, role: p.roleFromIdp ?? 'user', ...values }).returning();
  return u;
}
