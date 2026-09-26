import { Router } from 'express';
import multer from 'multer';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { knowledgeCollections, knowledgeDocuments, knowledgeSources, providers } from '../db/schema.js';
import { audit } from '../audit.js';
import { encryptJson } from '../crypto.js';
import { EMBEDDING_PRESETS, getEmbedder, getEmbeddingSettings, setEmbeddingSettings } from '../knowledge/embeddings.js';
import { collectionStats, indexDocument } from '../knowledge/store.js';
import { accessibleCollections, hybridSearch } from '../knowledge/search.js';
import { syncSource } from '../knowledge/sync.js';
import { resolveFsPath } from '../knowledge/connectors/filesystem.js';

export const knowledgeAdminRouter = Router();
export const knowledgeUserRouter = Router();

const bad = (res: import('express').Response, e: z.ZodError) => res.status(400).json({ error: 'Ungültige Eingabe', issues: e.issues });

/* ---------------- Embedding settings ---------------- */

const embBody = z.object({ providerId: z.string().uuid(), modelId: z.string().min(1).max(200), dimensions: z.number().int().positive().max(8192).optional() });

knowledgeAdminRouter.get('/embedding', async (_req, res) => {
  res.json({ settings: await getEmbeddingSettings(), presets: EMBEDDING_PRESETS });
});

knowledgeAdminRouter.put('/embedding', async (req, res) => {
  const p = embBody.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const [prov] = await db.select().from(providers).where(eq(providers.id, p.data.providerId));
  if (!prov) return res.status(400).json({ error: 'Anbieter unbekannt' });
  if (prov.type === 'anthropic') return res.status(400).json({ error: 'Anthropic bietet keine Embeddings an' });
  const before = await getEmbeddingSettings();
  await setEmbeddingSettings(p.data);
  // probe the model so misconfiguration shows up immediately
  let dim: number | undefined;
  let error: string | undefined;
  try { dim = (await (await getEmbedder())!.embed(['Verbindungstest']))[0].length; } catch (e) { error = (e as Error).message; }
  const changed = JSON.stringify(before) !== JSON.stringify(p.data);
  await audit(req, { action: 'knowledge.settings', success: !error, details: { before, after: p.data, dim, error } });
  // New model -> vectors are incompatible: re-index every source in the background.
  if (changed && !error) {
    const actor = { id: req.user!.id, username: req.user!.username };
    void (async () => {
      for (const s of await db.select({ id: knowledgeSources.id }).from(knowledgeSources)) await syncSource(s.id, 'manual', actor);
    })();
  }
  res.json({ ok: !error, dim, error, reindexStarted: changed && !error });
});

/* ---------------- Collections ---------------- */

const collBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  public: z.boolean().optional(),
  allowedGroups: z.array(z.string().min(1).max(200)).max(100).optional(),
});

knowledgeAdminRouter.get('/collections', async (_req, res) => {
  const [cols, stats, srcs] = await Promise.all([
    db.select().from(knowledgeCollections).orderBy(asc(knowledgeCollections.name)),
    collectionStats(),
    db.select({
      id: knowledgeSources.id, collectionId: knowledgeSources.collectionId, type: knowledgeSources.type, name: knowledgeSources.name,
      config: knowledgeSources.config, hasSecret: sql<boolean>`${knowledgeSources.secretEnc} is not null`,
      syncIntervalMinutes: knowledgeSources.syncIntervalMinutes, enabled: knowledgeSources.enabled,
      lastSyncAt: knowledgeSources.lastSyncAt, lastStatus: knowledgeSources.lastStatus, lastError: knowledgeSources.lastError, lastStats: knowledgeSources.lastStats,
    }).from(knowledgeSources).orderBy(asc(knowledgeSources.name)),
  ]);
  res.json(cols.map((c) => ({ ...c, ...(stats.get(c.id) ?? { documents: 0, chunks: 0 }), sources: srcs.filter((s) => s.collectionId === c.id) })));
});

knowledgeAdminRouter.post('/collections', async (req, res) => {
  const p = collBody.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const [c] = await db.insert(knowledgeCollections).values(p.data).returning();
  await audit(req, { action: 'knowledge.collection.create', targetType: 'knowledge_collection', targetId: c.id, details: p.data });
  res.status(201).json(c);
});

knowledgeAdminRouter.patch('/collections/:id', async (req, res) => {
  const p = collBody.partial().safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const [c] = await db.update(knowledgeCollections).set(p.data).where(eq(knowledgeCollections.id, req.params.id)).returning();
  if (!c) return res.status(404).end();
  await audit(req, { action: 'knowledge.collection.update', targetType: 'knowledge_collection', targetId: c.id, details: p.data });
  res.json(c);
});

knowledgeAdminRouter.delete('/collections/:id', async (req, res) => {
  const [c] = await db.delete(knowledgeCollections).where(eq(knowledgeCollections.id, req.params.id)).returning();
  if (!c) return res.status(404).end();
  await audit(req, { action: 'knowledge.collection.delete', targetType: 'knowledge_collection', targetId: c.id, details: { name: c.name } });
  res.status(204).end();
});

/* ---------------- Sources ---------------- */

const fsCfg = z.object({ path: z.string().min(1), recursive: z.boolean().optional(), urlPrefix: z.string().optional(), exclude: z.array(z.string()).optional() });
const confCfg = z.object({ baseUrl: z.string().url(), deployment: z.enum(['cloud', 'server']), spaceKeys: z.array(z.string().min(1)).min(1) });
const spCfg = z.object({
  tenantId: z.string().min(1), clientId: z.string().min(1), siteUrl: z.string().url().optional(), userPrincipalName: z.string().optional(),
  driveName: z.string().optional(), folderPath: z.string().optional(), graphBaseUrl: z.string().url().optional(), loginBaseUrl: z.string().url().optional(),
}).refine((c) => c.siteUrl || c.userPrincipalName, 'siteUrl oder userPrincipalName erforderlich');

const sourceBody = z.object({
  collectionId: z.string().uuid(),
  type: z.enum(['filesystem', 'confluence', 'sharepoint']),
  name: z.string().min(1).max(100),
  config: z.record(z.string(), z.unknown()),
  /** write-only: confluence {email, apiToken} | {token}; sharepoint {clientSecret} */
  secret: z.record(z.string(), z.string()).optional(),
  syncIntervalMinutes: z.number().int().min(0).max(10080).optional(),
  enabled: z.boolean().optional(),
});

function validateConfig(type: string, cfg: unknown) {
  if (type === 'filesystem') { const c = fsCfg.parse(cfg); resolveFsPath(c.path); return c; }
  if (type === 'confluence') return confCfg.parse(cfg);
  return spCfg.parse(cfg);
}

knowledgeAdminRouter.post('/sources', async (req, res) => {
  const p = sourceBody.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  let cfg;
  try { cfg = validateConfig(p.data.type, p.data.config); } catch (e) { return res.status(400).json({ error: e instanceof z.ZodError ? e.issues.map((i) => i.message).join(', ') : (e as Error).message }); }
  const { secret, ...d } = p.data;
  const [s] = await db.insert(knowledgeSources).values({ ...d, config: cfg as Record<string, unknown>, secretEnc: secret ? encryptJson(secret) : null }).returning();
  await audit(req, { action: 'knowledge.source.create', targetType: 'knowledge_source', targetId: s.id, details: { name: s.name, type: s.type, config: cfg } });
  res.status(201).json({ id: s.id });
});

knowledgeAdminRouter.patch('/sources/:id', async (req, res) => {
  const p = sourceBody.partial().omit({ type: true, collectionId: true }).safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const [cur] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, req.params.id));
  if (!cur) return res.status(404).end();
  let cfg;
  if (p.data.config) {
    try { cfg = validateConfig(cur.type, p.data.config); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
  }
  const { secret, config: _c, ...d } = p.data;
  await db.update(knowledgeSources).set({ ...d, ...(cfg ? { config: cfg as Record<string, unknown> } : {}), ...(secret ? { secretEnc: encryptJson(secret) } : {}) })
    .where(eq(knowledgeSources.id, cur.id));
  await audit(req, { action: 'knowledge.source.update', targetType: 'knowledge_source', targetId: cur.id, details: { ...d, config: cfg, secretChanged: !!secret } });
  res.json({ ok: true });
});

knowledgeAdminRouter.delete('/sources/:id', async (req, res) => {
  const [s] = await db.delete(knowledgeSources).where(eq(knowledgeSources.id, req.params.id)).returning();
  if (!s) return res.status(404).end();
  await audit(req, { action: 'knowledge.source.delete', targetType: 'knowledge_source', targetId: s.id, details: { name: s.name } });
  res.status(204).end();
});

/** Starts a sync in the background; the UI polls the source status. */
knowledgeAdminRouter.post('/sources/:id/sync', async (req, res) => {
  const [s] = await db.select({ id: knowledgeSources.id }).from(knowledgeSources).where(eq(knowledgeSources.id, req.params.id));
  if (!s) return res.status(404).end();
  void syncSource(s.id, 'manual', { id: req.user!.id, username: req.user!.username });
  res.status(202).json({ started: true });
});

knowledgeAdminRouter.get('/sources/:id/documents', async (req, res) => {
  res.json(await db.select({
    id: knowledgeDocuments.id, title: knowledgeDocuments.title, url: knowledgeDocuments.url, status: knowledgeDocuments.status,
    error: knowledgeDocuments.error, chunkCount: knowledgeDocuments.chunkCount, size: knowledgeDocuments.size, indexedAt: knowledgeDocuments.indexedAt,
  }).from(knowledgeDocuments).where(eq(knowledgeDocuments.sourceId, req.params.id)).orderBy(desc(knowledgeDocuments.indexedAt)).limit(1000));
});

knowledgeAdminRouter.delete('/documents/:id', async (req, res) => {
  const [d] = await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, req.params.id)).returning({ id: knowledgeDocuments.id, title: knowledgeDocuments.title });
  if (!d) return res.status(404).end();
  await audit(req, { action: 'knowledge.document.delete', targetType: 'knowledge_document', targetId: d.id, details: { title: d.title } });
  res.status(204).end();
});

/* ---------------- Upload into a collection ---------------- */

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.KNOWLEDGE_MAX_FILE_MB * 1024 * 1024, files: 50 } });

knowledgeAdminRouter.post('/collections/:id/upload', upload.array('files', 50), async (req, res) => {
  const [c] = await db.select().from(knowledgeCollections).where(eq(knowledgeCollections.id, String(req.params.id)));
  if (!c) return res.status(404).end();
  const embedder = await getEmbedder();
  if (!embedder) return res.status(400).json({ error: 'Zuerst ein Embedding-Modell konfigurieren' });

  let [src] = await db.select().from(knowledgeSources).where(and(eq(knowledgeSources.collectionId, c.id), eq(knowledgeSources.type, 'upload')));
  src ??= (await db.insert(knowledgeSources).values({ collectionId: c.id, type: 'upload', name: 'Uploads', syncIntervalMinutes: 0 }).returning())[0];

  const results = [];
  for (const f of (req.files as Express.Multer.File[]) ?? []) {
    const filename = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const result = await indexDocument(src, { externalId: filename, title: filename, filename, mimeType: f.mimetype, version: null, data: f.buffer }, embedder);
    await audit(req, { action: 'knowledge.upload', targetType: 'knowledge_collection', targetId: c.id, success: result !== 'error', details: { filename, size: f.size, result } });
    results.push({ filename, result });
  }
  await db.update(knowledgeSources).set({ lastSyncAt: new Date(), lastStatus: 'ok' }).where(eq(knowledgeSources.id, src.id));
  res.status(201).json(results);
});

/* ---------------- For all users ---------------- */

knowledgeUserRouter.get('/collections', async (req, res) => {
  const cols = await accessibleCollections(req.user!);
  res.json({ enabled: !!(await getEmbeddingSettings()), collections: cols.map((c) => ({ id: c.id, name: c.name, description: c.description })) });
});

/** Direct search (also useful for testing retrieval quality). */
knowledgeUserRouter.get('/search', async (req, res) => {
  const q = z.string().min(1).max(1000).parse(req.query.q);
  const cols = await accessibleCollections(req.user!);
  const hits = await hybridSearch(q, cols.map((c) => c.id), 10);
  await audit(req, { action: 'knowledge.search', details: { via: 'api', chars: q.length, hits: hits.length, ...(config.AUDIT_LOG_PROMPTS ? { query: q } : {}) } });
  res.json(hits);
});

/**
 * Opens a document: redirect to the source (Confluence page, SharePoint file, file share link),
 * or – where no source link exists (uploads) – show the extracted text version.
 */
knowledgeUserRouter.get('/documents/:id/open', async (req, res) => {
  const [d] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, req.params.id));
  if (!d) return res.status(404).end();
  const allowed = (await accessibleCollections(req.user!)).some((c) => c.id === d.collectionId);
  if (!allowed) return res.status(404).end();
  await audit(req, { action: 'knowledge.document.open', targetType: 'knowledge_document', targetId: d.id, details: { title: d.title, redirect: !!d.url } });
  if (d.url) return res.redirect(d.url);
  if (!d.text) return res.status(404).end();
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(d.title.replace(/\.[^.]+$/, '') + '.txt')}`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.send(`${d.title}\n(Textfassung – das Original wird nicht gespeichert)\n\n${d.text}`);
});
