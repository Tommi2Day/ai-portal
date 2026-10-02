import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { count } from 'drizzle-orm';
import { config } from './config.js';
import { db, pool } from './db/index.js';
import { users } from './db/schema.js';
import { logger } from './logger.js';
import { hashPassword } from './auth/local.js';
import { csrfGuard, requireAdmin, requireAuth, sessionMiddleware } from './auth/session.js';
import { authRouter } from './routes/auth.js';
import { i18nMiddleware } from './i18n.js';
import { adminRouter } from './routes/admin.js';
import { mcpRouter } from './routes/mcp.js';
import { filesRouter } from './routes/files.js';
import { chatsRouter, modelsRouter } from './routes/chats.js';
import { knowledgeAdminRouter, knowledgeUserRouter } from './routes/knowledge.js';
import { mcpAuth, mcpHandler } from './knowledge/mcpServer.js';
import { tokensRouter } from './routes/tokens.js';
import { pluginsAdminRouter, pluginsRouter } from './routes/plugins.js';
import rateLimit from 'express-rate-limit';
import { logoOrigin, renderIndexHtml, type Branding } from './branding.js';

/** Creates the first local admin if no user exists; safe when several replicas start at once. */
export async function bootstrapAdmin() {
  const [{ n }] = await db.select({ n: count() }).from(users);
  if (n > 0) return;
  if (!config.BOOTSTRAP_ADMIN_PASSWORD) {
    logger.warn('no users exist and BOOTSTRAP_ADMIN_PASSWORD is not set — no admin created');
    return;
  }
  await db.insert(users).values({
    username: config.BOOTSTRAP_ADMIN_USER.toLowerCase(), authSource: 'local', role: 'admin',
    displayName: 'Administrator', passwordHash: await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD),
  }).onConflictDoNothing(); // another replica may have created it in the meantime
  logger.info({ user: config.BOOTSTRAP_ADMIN_USER }, 'bootstrap admin created');
}

/** Express app with API, knowledge MCP endpoint and web UI (no listen, no scheduler). */
export function createApp(branding: Branding) {
  const logoHost = logoOrigin(branding);

  const app = express();
  app.set('trust proxy', 1); // behind ingress: real client IP for audit + rate limit
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: { 'default-src': ["'self'"], 'img-src': ["'self'", 'data:', 'blob:', ...(logoHost ? [logoHost] : [])], 'style-src': ["'self'", "'unsafe-inline'"], 'connect-src': ["'self'"] },
    },
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', async (_req, res) => {
    try { await pool.query('select 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  app.use('/api', i18nMiddleware, sessionMiddleware, csrfGuard);
  app.use('/api/auth', authRouter);
  app.use('/api/admin', requireAdmin, adminRouter);
  app.use('/api/mcp-servers', requireAuth, mcpRouter);
  app.use('/api/files', requireAuth, filesRouter);
  app.use('/api/models', requireAuth, modelsRouter);
  app.use('/api/chats', requireAuth, chatsRouter);
  app.use('/api/tokens', requireAuth, tokensRouter);
  app.use('/api/admin/plugins', requireAdmin, pluginsAdminRouter);
  app.use('/api/plugins', requireAuth, pluginsRouter);
  if (config.KNOWLEDGE_ENABLED) {
    app.use('/api/admin/knowledge', requireAdmin, knowledgeAdminRouter);
    app.use('/api/knowledge', requireAuth, knowledgeUserRouter);
    // Knowledge base as MCP server for external clients (LibreChat, Claude Desktop, IDEs)
    app.all('/mcp', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }), mcpAuth, mcpHandler);
  }
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // Web UI (SPA)
  const staticDir = path.resolve(config.STATIC_DIR);
  if (fs.existsSync(staticDir)) {
    // index.html with branding (name, logo, theme), rendered once at startup
    const indexHtml = renderIndexHtml(fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8'), branding);
    const sendIndex = (_req: express.Request, res: express.Response) => { res.set('Cache-Control', 'no-cache').type('html').send(indexHtml); };
    app.get('/index.html', sendIndex);
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api).*/, sendIndex);
  }

  app.use((err: Error & { status?: number; code?: string }, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Datei zu groß (max. ${config.UPLOAD_MAX_MB} MB)` });
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Ungültige Eingabe' });
    logger.error({ err, path: req.path }, 'unhandled error');
    if (!res.headersSent) res.status(err.status ?? 500).json({ error: 'Interner Fehler' });
  });

  return app;
}
