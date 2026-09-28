import { config } from './config.js';
import { pool, runMigrations } from './db/index.js';
import { logger } from './logger.js';
import { convertLegacyAuditToEnglish } from './audit.js';
import { startScheduler } from './knowledge/sync.js';
import { loadBranding } from './branding.js';
import { bootstrapAdmin, createApp } from './app.js';

async function main() {
  await runMigrations();
  await bootstrapAdmin();
  await convertLegacyAuditToEnglish();

  const app = createApp(loadBranding());
  if (config.KNOWLEDGE_ENABLED && config.KNOWLEDGE_WORKER) startScheduler();

  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'ai-portal listening'));
  const shutdown = () => { logger.info('shutting down'); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(1), 15_000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { logger.fatal({ err: e }, 'startup failed'); process.exit(1); });
