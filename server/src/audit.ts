import type { Request } from 'express';
import { db } from './db/index.js';
import { auditLog } from './db/schema.js';
import { logger } from './logger.js';
import { tr } from './i18n.js';

/** Audit entries are always written in English, independent of the UI language. */
const TEXT_FIELDS = ['reason', 'error', 'warning'];
export function englishDetails(d?: Record<string, unknown> | null) {
  if (!d) return d ?? undefined;
  const out: Record<string, unknown> = { ...d };
  for (const k of TEXT_FIELDS) if (typeof out[k] === 'string') out[k] = tr(out[k] as string, 'en');
  return out;
}

export type AuditAction =
  | 'auth.login' | 'auth.logout' | 'auth.login_failed'
  | 'user.create' | 'user.update' | 'user.delete'
  | 'provider.create' | 'provider.update' | 'provider.delete'
  | 'model.create' | 'model.update' | 'model.delete'
  | 'mcp.create' | 'mcp.update' | 'mcp.delete' | 'mcp.test' | 'mcp.tool_call'
  | 'chat.create' | 'chat.delete' | 'chat.prompt' | 'chat.completion' | 'chat.error'
  | 'file.upload' | 'file.download' | 'file.delete'
  | 'audit.export'
  | 'knowledge.settings' | 'knowledge.collection.create' | 'knowledge.collection.update' | 'knowledge.collection.delete'
  | 'knowledge.source.create' | 'knowledge.source.update' | 'knowledge.source.delete'
  | 'knowledge.sync' | 'knowledge.upload' | 'knowledge.document.delete' | 'knowledge.document.open' | 'knowledge.search' | 'knowledge.document.read'
  | 'token.create' | 'token.delete' | 'token.auth_failed';

export interface AuditEntry {
  action: AuditAction;
  userId?: string | null;
  username?: string | null;
  targetType?: string;
  targetId?: string;
  success?: boolean;
  details?: Record<string, unknown>;
}

/**
 * Writes one audit record to PostgreSQL AND emits it as JSON on stdout (audit=true).
 * Never throws: an audit failure is logged as error but does not break the request.
 */
export async function audit(req: Request | null, e: AuditEntry) {
  const user = req?.user;
  const row = {
    userId: e.userId ?? user?.id ?? null,
    username: e.username ?? user?.username ?? null,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    success: e.success ?? true,
    ip: req ? (req.ip ?? null) : null,
    userAgent: req?.get('user-agent')?.slice(0, 300) ?? null,
    details: englishDetails(e.details),
  };
  logger.info({ audit: true, ...row }, `audit ${e.action}`);
  try {
    await db.insert(auditLog).values(row);
  } catch (err) {
    logger.error({ err, audit: true }, 'audit write failed');
  }
}

/**
 * One-time conversion of entries written before audit logging was switched to English.
 * Idempotent; guarded by the settings key `audit_english_v1`.
 */
export async function convertLegacyAuditToEnglish() {
  const { pool } = await import('./db/index.js');
  const done = await pool.query(`SELECT 1 FROM settings WHERE key = 'audit_english_v1'`);
  if (done.rowCount) return;
  const { rows } = await pool.query<{ id: number; details: Record<string, unknown> }>(
    `SELECT id, details FROM audit_log WHERE details ?| array['reason','error','warning']`,
  );
  let changed = 0;
  for (const r of rows) {
    const next = englishDetails(r.details);
    if (JSON.stringify(next) !== JSON.stringify(r.details)) {
      await pool.query('UPDATE audit_log SET details = $2 WHERE id = $1', [r.id, next]);
      changed++;
    }
  }
  await pool.query(`INSERT INTO settings (key, value) VALUES ('audit_english_v1', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ changed, at: new Date().toISOString() })]);
  logger.info({ changed }, 'legacy audit entries converted to English');
}
