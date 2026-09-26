import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { knowledgeChunks, knowledgeDocuments, type KnowledgeSource } from '../db/schema.js';
import { extractTextFrom } from '../extract.js';
import { logger } from '../logger.js';
import { chunkText } from './chunk.js';
import type { Embedder } from './embeddings.js';

const ensuredDims = new Set<number>();

/**
 * pgvector HNSW indexes need a fixed dimension. We store vectors without a
 * dimension and create one partial expression index per dimension in use.
 * Queries must use the same expression: (embedding::vector(D)).
 */
export async function ensureVectorIndex(dim: number) {
  if (ensuredDims.has(dim) || !Number.isInteger(dim) || dim < 1) return;
  if (dim <= 2000) {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS kchunk_hnsw_${dim} ON knowledge_chunks USING hnsw ((embedding::vector(${dim})) vector_cosine_ops) WHERE embedding_dim = ${dim}`,
    );
  } else {
    logger.warn({ dim }, 'embedding dimension > 2000: no HNSW index, exact search is used');
  }
  ensuredDims.add(dim);
}

export interface IncomingDoc {
  externalId: string;
  title: string;
  url?: string | null;
  mimeType?: string | null;
  version?: string | null;
  /** Filename used to pick the text extractor. */
  filename: string;
  /** Either raw bytes (extracted here, then discarded) or already extracted text. */
  data?: Buffer;
  text?: string;
}

export type IndexResult = 'added' | 'updated' | 'unchanged' | 'error' | 'skipped';

/**
 * What needs to happen with a document from the source:
 *  - 'unchanged': same version, same embedding model
 *  - 'reembed':   same version, stored text available, only the embedding model changed -> no download
 *  - 'fetch':     new or changed -> download and extract
 */
export async function planDocument(sourceId: string, externalId: string, version: string | null | undefined, embedderKey: string) {
  const [d] = await db.select({ version: knowledgeDocuments.version, model: knowledgeDocuments.embeddingModel, status: knowledgeDocuments.status, text: knowledgeDocuments.text, title: knowledgeDocuments.title })
    .from(knowledgeDocuments).where(and(eq(knowledgeDocuments.sourceId, sourceId), eq(knowledgeDocuments.externalId, externalId)));
  const sameVersion = !!d && !!version && d.version === version && d.status !== 'error';
  // documents indexed before the text column existed are fetched once more to backfill their text
  if (sameVersion && d.model === embedderKey && d.text) return { action: 'unchanged' as const };
  if (sameVersion && d.text) return { action: 'reembed' as const, text: d.text };
  return { action: 'fetch' as const };
}

export async function indexDocument(source: KnowledgeSource, doc: IncomingDoc, embedder: Embedder): Promise<IndexResult> {
  const [existing] = await db.select({ id: knowledgeDocuments.id }).from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.sourceId, source.id), eq(knowledgeDocuments.externalId, doc.externalId)));

  const base = {
    sourceId: source.id, collectionId: source.collectionId, externalId: doc.externalId, title: doc.title.slice(0, 500),
    url: doc.url ?? null, mimeType: doc.mimeType ?? null, version: doc.version ?? null,
    sha256: doc.data ? crypto.createHash('sha256').update(doc.data).digest('hex') : null,
    size: doc.data?.length ?? doc.text?.length ?? null,
    embeddingModel: embedder.key, indexedAt: new Date(),
  };

  let text: string | null;
  try {
    text = doc.text ?? (doc.data ? await extractTextFrom(doc.filename, doc.mimeType ?? 'application/octet-stream', doc.data) : null);
  } catch (e) {
    await upsertDoc(existing?.id, { ...base, status: 'error', error: `Extraktion fehlgeschlagen: ${(e as Error).message}`, chunkCount: 0 });
    return 'error';
  }
  if (!text?.trim()) {
    await upsertDoc(existing?.id, { ...base, status: 'skipped', error: 'Kein Text extrahierbar (Format nicht unterstützt oder gescannt)', chunkCount: 0 });
    return 'skipped';
  }

  base.sha256 ??= crypto.createHash('sha256').update(text).digest('hex');
  const chunks = chunkText(text, doc.title);
  let vectors: number[][];
  try {
    vectors = await embedder.embed(chunks);
  } catch (e) {
    await upsertDoc(existing?.id, { ...base, status: 'error', error: `Embedding fehlgeschlagen: ${(e as Error).message}`, chunkCount: 0 });
    return 'error';
  }
  const dim = vectors[0]?.length ?? 0;
  await ensureVectorIndex(dim);

  await db.transaction(async (tx) => {
    const [d] = existing
      ? await tx.update(knowledgeDocuments).set({ ...base, text, status: 'indexed', error: null, chunkCount: chunks.length })
          .where(eq(knowledgeDocuments.id, existing.id)).returning({ id: knowledgeDocuments.id })
      : await tx.insert(knowledgeDocuments).values({ ...base, text, status: 'indexed', chunkCount: chunks.length }).returning({ id: knowledgeDocuments.id });
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, d.id));
    for (let i = 0; i < chunks.length; i += 200) {
      await tx.insert(knowledgeChunks).values(chunks.slice(i, i + 200).map((content, j) => ({
        documentId: d.id, collectionId: source.collectionId, ordinal: i + j, content,
        embedding: vectors[i + j], embeddingDim: dim, embeddingModel: embedder.key,
      })));
    }
  });
  return existing ? 'updated' : 'added';
}

async function upsertDoc(id: string | undefined, values: typeof knowledgeDocuments.$inferInsert) {
  if (id) {
    await db.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, id));
    await db.update(knowledgeDocuments).set(values).where(eq(knowledgeDocuments.id, id));
  } else {
    await db.insert(knowledgeDocuments).values(values);
  }
}

/** Removes documents that no longer exist in the source. */
export async function removeMissing(sourceId: string, seenExternalIds: string[]): Promise<number> {
  // single array parameter -> no bind-parameter limit for large sources
  const r = await pool.query('DELETE FROM knowledge_documents WHERE source_id = $1 AND NOT (external_id = ANY($2::text[]))', [sourceId, seenExternalIds]);
  return r.rowCount ?? 0;
}

export async function collectionStats() {
  const { rows } = await pool.query<{ collection_id: string; documents: string; chunks: string }>(`
    select d.collection_id, count(distinct d.id) documents, coalesce(sum(d.chunk_count),0) chunks
    from knowledge_documents d group by d.collection_id`);
  return new Map(rows.map((r) => [r.collection_id, { documents: Number(r.documents), chunks: Number(r.chunks) }]));
}

