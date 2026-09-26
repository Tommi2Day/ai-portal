import { inArray } from 'drizzle-orm';
import { tool, jsonSchema, type Tool } from 'ai';
import { db, pool } from '../db/index.js';
import { knowledgeCollections, type KnowledgeCollection } from '../db/schema.js';
import type { SessionUser } from '../auth/session.js';
import { getEmbedder } from './embeddings.js';
import { ensureVectorIndex } from './store.js';

/** Admins see every collection; others: public ones plus those shared with one of their groups (case-insensitive). */
export async function accessibleCollections(user: SessionUser & { groups?: string[] }): Promise<KnowledgeCollection[]> {
  const all = await db.select().from(knowledgeCollections);
  if (user.role === 'admin') return all;
  const mine = new Set((user.groups ?? []).map((g) => g.toLowerCase()));
  return all.filter((c) => c.public || c.allowedGroups.some((g) => mine.has(g.toLowerCase())));
}

const STOP = new Set(('und oder aber der die das den dem des ein eine einen einem einer ist sind war wie was wer wo wann warum welche welcher welches ich du er sie es wir ihr mit für von zu zum zur auf aus bei nach über unter nicht auch noch nur mal kann können muss soll wird werden hat haben gibt '
  + 'the and or for with what how why when where who which is are was were can could should would does do did not this that from into').split(' '));

export interface Hit {
  chunkId: number;
  documentId: string;
  title: string;
  url: string | null;
  collection: string;
  content: string;
  score: number;
}

/**
 * Hybrid search: pgvector cosine similarity + PostgreSQL full text ('simple' config,
 * good for error codes, product and host names), merged with Reciprocal Rank Fusion.
 */
export async function hybridSearch(query: string, collectionIds: string[], k = 8): Promise<Hit[]> {
  if (!collectionIds.length || !query.trim()) return [];
  const embedder = await getEmbedder();
  if (!embedder) throw new Error('Kein Embedding-Modell konfiguriert');
  const [qv] = await embedder.embed([query]);
  const dim = qv.length;
  await ensureVectorIndex(dim);
  const vec = `[${qv.join(',')}]`;

  const vectorQ = pool.query<{ id: string }>(`
    SELECT id FROM knowledge_chunks
    WHERE collection_id = ANY($1::uuid[]) AND embedding_dim = ${dim} AND embedding_model = $2
    ORDER BY (embedding::vector(${dim})) <=> $3::vector(${dim})
    LIMIT 40`, [collectionIds, embedder.key, vec]);
  // OR over significant terms: natural-language questions rarely match with AND semantics
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/gu) ?? []).filter((t) => !STOP.has(t)))].slice(0, 20);
  const tsq = terms.map((t) => `'${t.replace(/'/g, "''")}'`).join(' | ') || "''";
  const textQ = pool.query<{ id: string }>(`
    SELECT id FROM knowledge_chunks, to_tsquery('simple', $2) q
    WHERE collection_id = ANY($1::uuid[]) AND tsv @@ q
    ORDER BY ts_rank_cd(tsv, q) DESC
    LIMIT 40`, [collectionIds, tsq]);
  const [v, t] = await Promise.all([vectorQ, textQ]);

  const score = new Map<string, number>();
  const rrf = (ids: string[], weight: number) => ids.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + weight / (60 + i)));
  rrf(v.rows.map((r) => r.id), 1);
  rrf(t.rows.map((r) => r.id), 0.8);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k * 3);
  if (!ranked.length) return [];

  const { rows } = await pool.query<{ id: string; document_id: string; content: string; title: string; url: string | null; collection: string }>(`
    SELECT c.id, c.document_id, c.content, d.title, d.url, k.name AS collection
    FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id JOIN knowledge_collections k ON k.id = c.collection_id
    WHERE c.id = ANY($1::bigint[])`, [ranked.map(([id]) => id)]);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // max. 2 chunks per document for diversity
  const perDoc = new Map<string, number>();
  const hits: Hit[] = [];
  for (const [id, s] of ranked) {
    const r = byId.get(id);
    if (!r) continue;
    const n = perDoc.get(r.document_id) ?? 0;
    if (n >= 2) continue;
    perDoc.set(r.document_id, n + 1);
    hits.push({ chunkId: Number(r.id), documentId: r.document_id, title: r.title, url: r.url, collection: r.collection, content: r.content, score: s });
    if (hits.length >= k) break;
  }
  return hits;
}

/**
 * The chat tool. Numbering continues across several calls within one answer,
 * so the model can cite [1], [2], … consistently.
 */
export function knowledgeTool(collections: KnowledgeCollection[], onSearch: (info: { query: string; collections: string[]; hits: Hit[] }) => void): Tool {
  let counter = 0;
  const names = collections.map((c) => c.name);
  return tool({
    description:
      `Durchsucht die interne Wissensdatenbank (Sammlungen: ${collections.map((c) => `${c.name}${c.description ? ` – ${c.description}` : ''}`).join('; ')}). ` +
      'Nutze das Tool für Fragen zu internen Abläufen, Systemen, Richtlinien und Dokumentation. Formuliere präzise Suchbegriffe; bei Bedarf mehrfach suchen.',
    inputSchema: jsonSchema<{ query: string; sammlung?: string }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchanfrage in natürlicher Sprache oder Stichworten' },
        sammlung: { type: 'string', enum: names, description: 'Optional: nur in dieser Sammlung suchen' },
      },
      required: ['query'],
    }),
    execute: async ({ query, sammlung }) => {
      const ids = collections.filter((c) => !sammlung || c.name === sammlung).map((c) => c.id);
      const hits = await hybridSearch(query, ids);
      onSearch({ query, collections: sammlung ? [sammlung] : names, hits });
      return {
        treffer: hits.map((h) => ({
          nr: ++counter, titel: h.title, url: h.url ?? `/api/knowledge/documents/${h.documentId}/open`, quelle: h.url ? 'Original' : 'Textfassung', sammlung: h.collection,
          dokumentId: h.documentId, auszug: h.content,
        })),
        hinweis: hits.length ? 'Belege Aussagen mit [nr]. Liste am Ende die verwendeten Quellen als Markdown-Links.' : 'Keine Treffer.',
      };
    },
  });
}

export async function collectionsByIds(ids: string[]) {
  return ids.length ? db.select().from(knowledgeCollections).where(inArray(knowledgeCollections.id, ids)) : [];
}
