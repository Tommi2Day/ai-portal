import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, type User } from '../db/schema.js';
import { LoginError } from './provision.js';

const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 12);

export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);

export async function localLogin(username: string, password: string): Promise<User> {
  const [u] = await db.select().from(users).where(eq(users.username, username.toLowerCase()));
  const ok = await bcrypt.compare(password, u?.passwordHash ?? DUMMY_HASH);
  if (!u || u.authSource !== 'local' || !ok) throw new LoginError('Benutzername oder Passwort falsch');
  if (u.pendingApproval) throw new LoginError('Registrierung wartet auf Freigabe durch einen Admin');
  if (!u.active) throw new LoginError('Benutzer ist deaktiviert');
  const [updated] = await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id)).returning();
  return updated;
}
