import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../auth/local.js';
import { issueSession, clearSession, requireAuth } from '../auth/session.js';
import { localLogin } from '../auth/local.js';
import { ldapLogin } from '../auth/ldap.js';
import { oidcStart, oidcCallback } from '../auth/oidc.js';
import { LoginError } from '../auth/provision.js';
import { logger } from '../logger.js';
import { langOf, tr } from '../i18n.js';

export const authRouter = Router();

authRouter.get('/config', (_req, res) => {
  res.json({
    local: config.AUTH_LOCAL_ENABLED,
    registration: config.AUTH_LOCAL_ENABLED && config.REGISTRATION_ENABLED,
    ldap: config.LDAP_ENABLED,
    oidc: config.OIDC_ENABLED ? { name: config.OIDC_DISPLAY_NAME } : null,
  });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  res.json(req.user);
});

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
const loginBody = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500), method: z.enum(['local', 'ldap']) });

authRouter.post('/login', loginLimiter, async (req, res) => {
  const body = loginBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Ungültige Eingabe' });
  const { username, password, method } = body.data;
  try {
    if (method === 'local' && !config.AUTH_LOCAL_ENABLED) throw new LoginError('Lokale Anmeldung deaktiviert');
    if (method === 'ldap' && !config.LDAP_ENABLED) throw new LoginError('LDAP-Anmeldung deaktiviert');
    const user = method === 'ldap' ? await ldapLogin(username.trim(), password) : await localLogin(username.trim(), password);
    issueSession(res, user);
    await audit(req, { action: 'auth.login', userId: user.id, username: user.username, details: { method } });
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof LoginError ? e.message : 'Anmeldung fehlgeschlagen';
    if (!(e instanceof LoginError)) logger.error({ err: e }, 'login error');
    await audit(req, { action: 'auth.login_failed', username: username.toLowerCase(), success: false, details: { method, reason: msg } });
    res.status(401).json({ error: msg });
  }
});

const registerLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
const registerBody = z.object({
  displayName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(200),
  username: z.string().trim().min(2).max(100).regex(/^[a-zA-Z0-9._@-]+$/),
  password: z.string().min(12).max(200),
});

/** Self-registration creates an inactive local account; an admin has to approve it (Admin -> Users). */
authRouter.post('/register', registerLimiter, async (req, res) => {
  if (!config.AUTH_LOCAL_ENABLED || !config.REGISTRATION_ENABLED) return res.status(404).end();
  const p = registerBody.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Ungültige Eingabe', issues: p.error.issues });
  const d = p.data;
  const [u] = await db.insert(users).values({
    username: d.username.toLowerCase(), displayName: d.displayName, email: d.email, authSource: 'local',
    passwordHash: await hashPassword(d.password), active: false, pendingApproval: true,
  }).onConflictDoNothing().returning({ id: users.id, username: users.username });
  if (!u) return res.status(409).json({ error: 'Benutzername existiert bereits' });
  await audit(req, { action: 'auth.register', userId: u.id, username: u.username, targetType: 'user', targetId: u.id });
  res.status(201).json({ ok: true });
});

const profileBody = z.object({
  displayName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(200),
});

/** Confirm/correct name and email (shown once after the first SSO/LDAP login). Directory values win on the next login. */
authRouter.put('/profile', requireAuth, async (req, res) => {
  const p = profileBody.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Ungültige Eingabe', issues: p.error.issues });
  const [u] = await db.update(users).set({ ...p.data, profileCompleted: true }).where(eq(users.id, req.user!.id)).returning();
  await audit(req, { action: 'auth.profile' });
  res.json({ ...req.user, displayName: u.displayName, email: u.email, profileCompleted: true });
});

authRouter.get('/oidc/start', async (req, res) => {
  if (!config.OIDC_ENABLED) return res.status(404).end();
  await oidcStart(req, res);
});

authRouter.get('/oidc/callback', async (req, res) => {
  if (!config.OIDC_ENABLED) return res.status(404).end();
  try {
    const user = await oidcCallback(req, res);
    issueSession(res, user);
    await audit(req, { action: 'auth.login', userId: user.id, username: user.username, details: { method: 'oidc' } });
    res.redirect('/');
  } catch (e) {
    const msg = e instanceof LoginError ? e.message : 'SSO-Anmeldung fehlgeschlagen';
    logger.warn({ err: e }, 'oidc callback failed');
    await audit(req, { action: 'auth.login_failed', success: false, details: { method: 'oidc', reason: msg } });
    res.redirect(`/login?error=${encodeURIComponent(tr(msg, langOf(req)))}`);
  }
});

authRouter.post('/logout', async (req, res) => {
  if (req.user) await audit(req, { action: 'auth.logout' });
  clearSession(res);
  res.json({ ok: true });
});
