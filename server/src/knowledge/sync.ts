import { eq } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { knowledgeDocuments, knowledgeSources, type KnowledgeSource } from '../db/schema.js';
import { decryptJson } from '../crypto.js';
import { audit } from '../audit.js';
import { logger } from '../logger.js';
import { getEmbedder, type Embedder } from './embeddings.js';
import { indexDocument, planDocument, removeMissing } from './store.js';
import { filesystemConnector, type FilesystemConfig } from './connectors/filesystem.js';
import { confluenceConnector, type ConfluenceConfig, type ConfluenceSecret } from './connectors/confluence.js';
import { sharepointConnector, type SharePointConfig, type SharePointSecret } from './connectors/sharepoint.js';
import type { Connector } from './connectors/types.js';

export function connectorFor(s: KnowledgeSource): Connector | null {
  switch (s.type) {
    case 'filesystem': return filesystemConnector(s.config as unknown as FilesystemConfig);
    case 'confluence': return confluenceConnector(s.config as unknown as ConfluenceConfig, decryptJson<ConfluenceSecret>(s.secretEnc, {}));
    case 'sharepoint': return sharepointConnector(s.config as unknown as SharePointConfig, decryptJson<SharePointSecret>(s.secretEnc, { clientSecret: '' }));
    case 'upload': return null;
  }
}

/** Uploads have no remote source: "sync" re-embeds their stored text when the embedding model changed. */
async function reindexUploads(s: KnowledgeSource, embedder: Embedder, stats: Record<string, number>) {
  const docs = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.sourceId, s.id));
  for (const d of docs) {
    if (d.embeddingModel === embedder.key && d.status === 'indexed') { stats.unchanged++; continue; }
    if (!d.text) { stats.errors++; continue; }
    const r = await indexDocument(s, { externalId: d.externalId, title: d.title, url: d.url, filename: d.title, mimeType: d.mimeType, version: d.version, text: d.text }, embedder);
    stats[r === 'added' || r === 'updated' ? 'updated' : r === 'error' ? 'errors' : r]++;
  }
}

/** 64-bit advisory lock key per source -> only one pod syncs a source at a time. */
const lockKey = (id: string) => BigInt.asIntN(64, BigInt('0x' + id.replace(/-/g, '').slice(0, 16))).toString();

export async function syncSource(sourceId: string, trigger: 'schedule' | 'manual', actor?: { id: string; username: string }) {
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS ok', [lockKey(sourceId)]);
    if (!rows[0].ok) return { skipped: 'läuft bereits' };
    try {
      return await runSync(sourceId, trigger, actor);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey(sourceId)]);
    }
  } finally {
    lockClient.release();
  }
}

async function runSync(sourceId: string, trigger: string, actor?: { id: string; username: string }) {
  const [s] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId));
  if (!s) return { skipped: 'nicht gefunden' };
  const started = Date.now();
  const stats: Record<string, number> = { added: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, errors: 0 };
  await db.update(knowledgeSources).set({ lastStatus: 'running', lastError: null }).where(eq(knowledgeSources.id, s.id));
  let error: string | undefined;
  try {
    const embedder = await getEmbedder();
    if (!embedder) throw new Error('Kein Embedding-Modell konfiguriert');
    if (s.type === 'upload') {
      await reindexUploads(s, embedder, stats);
    } else {
      const seen: string[] = [];
      for await (const ref of connectorFor(s)!.list()) {
        seen.push(ref.externalId);
        try {
          const plan = await planDocument(s.id, ref.externalId, ref.version, embedder.key);
          if (plan.action === 'unchanged') { stats.unchanged++; continue; }
          // only the embedding model changed: re-embed the stored text, no download from the source
          const content = plan.action === 'reembed' ? { text: plan.text } : await ref.load();
          const r = await indexDocument(s, { ...ref, ...content }, embedder);
          stats[r === 'error' ? 'errors' : r]++;
        } catch (e) {
          stats.errors++;
          logger.warn({ err: e, source: s.name, doc: ref.externalId }, 'knowledge document failed');
        }
      }
      stats.removed = await removeMissing(s.id, seen);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    logger.error({ err: e, source: s.name }, 'knowledge sync failed');
  }
  const ms = Date.now() - started;
  await db.update(knowledgeSources).set({
    lastStatus: error ? 'error' : 'ok', lastError: error ?? null, lastSyncAt: new Date(), lastStats: { ...stats, ms },
  }).where(eq(knowledgeSources.id, s.id));
  await audit(null, {
    action: 'knowledge.sync', userId: actor?.id ?? null, username: actor?.username ?? 'system', targetType: 'knowledge_source', targetId: s.id,
    success: !error, details: { source: s.name, type: s.type, trigger, ms, ...stats, error },
  });
  return { stats, error, ms };
}

/** Every minute: start due syncs (sequentially, so embedding APIs are not flooded). */
export function startScheduler() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const { rows } = await pool.query<{ id: string }>(`
        SELECT id FROM knowledge_sources
        WHERE enabled AND sync_interval_minutes > 0 AND type <> 'upload'
          AND (last_sync_at IS NULL OR last_sync_at < now() - make_interval(mins => sync_interval_minutes))
        ORDER BY last_sync_at NULLS FIRST`);
      for (const r of rows) await syncSource(r.id, 'schedule');
    } catch (e) {
      logger.error({ err: e }, 'knowledge scheduler');
    } finally {
      busy = false;
    }
  };
  setTimeout(tick, 15_000);
  return setInterval(tick, 60_000);
}

