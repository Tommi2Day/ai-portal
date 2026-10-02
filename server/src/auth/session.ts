import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { users, type User } from '../db/schema.js';

export const SESSION_COOKIE = 'ap_session';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: 'admin' | 'user';
  authSource: 'local' | 'ldap' | 'oidc';
  groups: string[];
  profileCompleted: boolean;
}

export const toSessionUser = (u: User): SessionUser => ({
  id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role, authSource: u.authSource, groups: u.groups,
  profileCompleted: u.profileCompleted,
});

const cookieOpts = () => ({
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: 'lax' as const,
  path: '/',
});

export function issueSession(res: Response, u: User) {
  const token = jwt.sign({ sub: u.id }, config.SESSION_SECRET, { expiresIn: `${config.SESSION_TTL_HOURS}h` });
  res.cookie(SESSION_COOKIE, token, { ...cookieOpts(), maxAge: config.SESSION_TTL_HOURS * 3600_000 });
}

export function clearSession(res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieOpts());
}

/** Resolves the session cookie to a fresh DB user (role/active changes take effect immediately). */
export async function sessionMiddleware(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    try {
      const { sub } = jwt.verify(token, config.SESSION_SECRET) as { sub: string };
      const [u] = await db.select().from(users).where(eq(users.id, sub));
      if (u?.active) req.user = toSessionUser(u);
    } catch { /* invalid/expired -> anonymous */ }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}

/**
 * CSRF defence: state-changing API requests must carry a custom header,
 * which browsers never send cross-site without a CORS preflight (and we allow no CORS).
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/api/auth/oidc/')) return next();
  if (req.get('x-requested-with') !== 'ai-portal') return res.status(403).json({ error: 'csrf' });
  next();
}
