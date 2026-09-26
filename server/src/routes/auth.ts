import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { issueSession, clearSession } from '../auth/session.js';
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
