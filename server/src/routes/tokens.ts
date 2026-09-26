import { Router } from 'express';
import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { apiTokens } from '../db/schema.js';
import { audit } from '../audit.js';

/** Personal access tokens: used by external MCP clients (LibreChat, Claude Desktop, IDEs) to act as this user. */
export const tokensRouter = Router();

export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

tokensRouter.get('/', async (req, res) => {
  res.json(await db.select({
    id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.prefix, expiresAt: apiTokens.expiresAt,
    lastUsedAt: apiTokens.lastUsedAt, createdAt: apiTokens.createdAt,
  }).from(apiTokens).where(eq(apiTokens.userId, req.user!.id)).orderBy(desc(apiTokens.createdAt)));
});

tokensRouter.post('/', async (req, res) => {
  const p = z.object({ name: z.string().min(1).max(80), expiresInDays: z.number().int().min(1).max(365).default(90) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Ungültige Eingabe' });
  const token = 'ap_' + crypto.randomBytes(32).toString('base64url');
  const [row] = await db.insert(apiTokens).values({
    userId: req.user!.id, name: p.data.name, tokenHash: hashToken(token), prefix: token.slice(0, 10),
    expiresAt: new Date(Date.now() + p.data.expiresInDays * 86_400_000),
  }).returning({ id: apiTokens.id, expiresAt: apiTokens.expiresAt });
  await audit(req, { action: 'token.create', targetType: 'api_token', targetId: row.id, details: { name: p.data.name, expiresAt: row.expiresAt } });
  res.status(201).json({ ...row, token }); // shown exactly once
});

tokensRouter.delete('/:id', async (req, res) => {
  const [row] = await db.delete(apiTokens).where(and(eq(apiTokens.id, req.params.id), eq(apiTokens.userId, req.user!.id))).returning();
  if (!row) return res.status(404).end();
  await audit(req, { action: 'token.delete', targetType: 'api_token', targetId: row.id, details: { name: row.name } });
  res.status(204).end();
});
