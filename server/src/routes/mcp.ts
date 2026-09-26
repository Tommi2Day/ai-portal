import { Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { mcpServers } from '../db/schema.js';
import { audit } from '../audit.js';
import { encryptJson, decryptJson } from '../crypto.js';
import { assertAllowedUrl, connectMcp } from '../ai/mcp.js';

export const mcpRouter = Router();

const body = z.object({
  name: z.string().min(1).max(60),
  url: z.string().url(),
  transport: z.enum(['streamable-http', 'sse']).default('streamable-http'),
  /** Write-only; omit to keep. e.g. { "Authorization": "Bearer ..." } */
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

const view = (s: typeof mcpServers.$inferSelect) => ({
  id: s.id, name: s.name, url: s.url, transport: s.transport, enabled: s.enabled,
  headerNames: Object.keys(decryptJson<Record<string, string>>(s.headersEnc, {})),
  lastStatus: s.lastStatus, lastError: s.lastError, toolCount: s.toolCount, createdAt: s.createdAt,
});

const own = (userId: string, id: string) => and(eq(mcpServers.userId, userId), eq(mcpServers.id, id));

mcpRouter.get('/', async (req, res) => {
  const rows = await db.select().from(mcpServers).where(eq(mcpServers.userId, req.user!.id)).orderBy(asc(mcpServers.name));
  res.json(rows.map(view));
});

mcpRouter.post('/', async (req, res) => {
  const p = body.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Ungültige Eingabe', issues: p.error.issues });
  try { await assertAllowedUrl(p.data.url); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
  const { headers, ...d } = p.data;
  const [row] = await db.insert(mcpServers).values({ ...d, userId: req.user!.id, headersEnc: headers ? encryptJson(headers) : null }).returning();
  await audit(req, { action: 'mcp.create', targetType: 'mcp_server', targetId: row.id, details: { name: row.name, url: row.url } });
  res.status(201).json(view(row));
});

mcpRouter.patch('/:id', async (req, res) => {
  const p = body.partial().safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Ungültige Eingabe', issues: p.error.issues });
  if (p.data.url) { try { await assertAllowedUrl(p.data.url); } catch (e) { return res.status(400).json({ error: (e as Error).message }); } }
  const { headers, ...d } = p.data;
  const [row] = await db.update(mcpServers).set({ ...d, ...(headers ? { headersEnc: encryptJson(headers) } : {}) })
    .where(own(req.user!.id, req.params.id)).returning();
  if (!row) return res.status(404).end();
  await audit(req, { action: 'mcp.update', targetType: 'mcp_server', targetId: row.id, details: { ...d, headersChanged: !!headers } });
  res.json(view(row));
});

mcpRouter.delete('/:id', async (req, res) => {
  const [row] = await db.delete(mcpServers).where(own(req.user!.id, req.params.id)).returning();
  if (!row) return res.status(404).end();
  await audit(req, { action: 'mcp.delete', targetType: 'mcp_server', targetId: row.id, details: { name: row.name } });
  res.status(204).end();
});

/** Connects, lists tools, stores the status. */
mcpRouter.post('/:id/test', async (req, res) => {
  const [s] = await db.select().from(mcpServers).where(own(req.user!.id, req.params.id));
  if (!s) return res.status(404).end();
  let result: { ok: boolean; tools?: { name: string; description?: string }[]; error?: string };
  try {
    const client = await connectMcp(s);
    const { tools } = await client.listTools();
    await client.close();
    result = { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description })) };
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await db.update(mcpServers).set({
    lastStatus: result.ok ? 'ok' : 'error', lastError: result.error ?? null, toolCount: result.tools?.length ?? null,
  }).where(eq(mcpServers.id, s.id));
  await audit(req, { action: 'mcp.test', targetType: 'mcp_server', targetId: s.id, success: result.ok, details: { tools: result.tools?.length, error: result.error } });
  res.json(result);
});
