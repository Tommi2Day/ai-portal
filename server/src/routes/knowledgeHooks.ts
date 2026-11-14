import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { knowledgeSources } from '../db/schema.js';
import { audit } from '../audit.js';
import { syncSource } from '../knowledge/sync.js';
import { hashToken } from './tokens.js';

/**
 * Update of a knowledge source triggered from outside (CI job after a documentation build, a Confluence / Git webhook,
 * a cron on another host):
 *
 *   POST /api/hooks/knowledge/<source id>/sync        Authorization: Bearer kt_…   (or header X-Trigger-Token)
 *   body (optional)  { "replace": true }               full replace for this run, overrides the source's setting
 *
 * The token belongs to one source (created in the admin UI, only its SHA-256 is stored) and can do nothing else.
 * No session and no CSRF header: the token is the credential; cookies are not looked at.
 */
export const knowledgeHooksRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

knowledgeHooksRouter.post('/:id/sync', limiter, async (req, res) => {
  const id = String(req.params.id);
  const supplied = /^Bearer\s+(\S+)$/.exec(req.get('authorization') ?? '')?.[1] ?? req.get('x-trigger-token') ?? '';
  // one answer for every authentication problem: nothing reveals whether a source exists
  const deny = async (reason: string) => {
    await audit(req, { action: 'knowledge.trigger_failed', success: false, details: { reason, source: UUID.test(id) ? id : undefined } });
    return res.status(401).set('www-authenticate', 'Bearer realm="ai-portal"').json({ error: 'invalid trigger token' });
  };
  if (!UUID.test(id) || !/^kt_[\w-]{20,}$/.test(supplied)) return deny('missing or malformed token');

  const [s] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, id));
  if (!s?.triggerTokenHash) return deny('unknown source or no external trigger');
  const given = Buffer.from(hashToken(supplied), 'hex');
  const stored = Buffer.from(s.triggerTokenHash, 'hex');
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return deny('wrong token');

  const body = z.object({ replace: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid body, expected {"replace": boolean}' });
  if (s.type === 'upload') return res.status(400).json({ error: 'uploads have no external source' });
  if (!s.enabled) return res.status(409).json({ error: 'source is disabled' });
  if (s.lastStatus === 'running') return res.status(409).json({ error: 'an update is already running' });

  void syncSource(s.id, 'external', undefined, { replace: body.data.replace });
  res.status(202).json({ started: true, replace: body.data.replace ?? s.replaceOnSync });
});
