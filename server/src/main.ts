import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { count } from 'drizzle-orm';
import { config } from './config.js';
import { db, pool, runMigrations } from './db/index.js';
import { users } from './db/schema.js';
import { logger } from './logger.js';
import { hashPassword } from './auth/local.js';
import { csrfGuard, requireAdmin, requireAuth, sessionMiddleware } from './auth/session.js';
import { authRouter } from './routes/auth.js';
import { i18nMiddleware } from './i18n.js';
import { convertLegacyAuditToEnglish } from './audit.js';
import { adminRouter } from './routes/admin.js';
import { mcpRouter } from './routes/mcp.js';
import { filesRouter } from './routes/files.js';
import { chatsRouter, modelsRouter } from './routes/chats.js';
import { knowledgeAdminRouter, knowledgeUserRouter } from './routes/knowledge.js';
import { startScheduler } from './knowledge/sync.js';
import { mcpAuth, mcpHandler } from './knowledge/mcpServer.js';
import { tokensRouter } from './routes/tokens.js';
import rateLimit from 'express-rate-limit';

async function bootstrapAdmin() {
  const [{ n }] = await db.select({ n: count() }).from(users);
  if (n > 0) return;
  if (!config.BOOTSTRAP_ADMIN_PASSWORD) {
    logger.warn('no users exist and BOOTSTRAP_ADMIN_PASSWORD is not set — no admin created');
    return;
  }
  await db.insert(users).values({
    username: config.BOOTSTRAP_ADMIN_USER.toLowerCase(), authSource: 'local', role: 'admin',
    displayName: 'Administrator', passwordHash: await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD),
  });
  logger.info({ user: config.BOOTSTRAP_ADMIN_USER }, 'bootstrap admin created');
}

async function main() {
  await runMigrations();
  await bootstrapAdmin();
  await convertLegacyAuditToEnglish();

  const app = express();
  app.set('trust proxy', 1); // behind ingress: real client IP for audit + rate limit
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: { 'default-src': ["'self'"], 'img-src': ["'self'", 'data:', 'blob:'], 'style-src': ["'self'", "'unsafe-inline'"], 'connect-src': ["'self'"] },
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
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  app.use((err: Error & { status?: number; code?: string }, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Datei zu groß (max. ${config.UPLOAD_MAX_MB} MB)` });
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Ungültige Eingabe' });
    logger.error({ err, path: req.path }, 'unhandled error');
    if (!res.headersSent) res.status(err.status ?? 500).json({ error: 'Interner Fehler' });
  });

  if (config.KNOWLEDGE_ENABLED && config.KNOWLEDGE_WORKER) startScheduler();

  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'ai-portal listening'));
  const shutdown = () => { logger.info('shutting down'); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(1), 15_000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { logger.fatal({ err: e }, 'startup failed'); process.exit(1); });
