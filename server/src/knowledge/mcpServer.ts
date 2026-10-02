import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { apiTokens, knowledgeDocuments, users } from '../db/schema.js';
import { audit } from '../audit.js';
import { toSessionUser } from '../auth/session.js';
import { hashToken } from '../routes/tokens.js';
import { collectionStats } from './store.js';
import { accessibleCollections, documentMeta, hybridSearch, metaForTool, publishedArticleDocument } from './search.js';

/** Bearer personal access token -> req.user. Session cookies are deliberately NOT accepted on /mcp. */
export async function mcpAuth(req: Request, res: Response, next: NextFunction) {
  const m = /^Bearer\s+(ap_[\w-]+)$/.exec(req.get('authorization') ?? '');
  const deny = async (reason: string) => {
    await audit(req, { action: 'token.auth_failed', success: false, details: { reason } });
    res.status(401).set('www-authenticate', 'Bearer realm="ai-portal"').json({ error: 'Gültiges Zugriffstoken erforderlich' });
  };
  if (!m) return deny('no token');
  const [row] = await db.select().from(apiTokens).innerJoin(users, eq(apiTokens.userId, users.id)).where(eq(apiTokens.tokenHash, hashToken(m[1])));
  if (!row) return deny('unknown token');
  if (row.api_tokens.expiresAt && row.api_tokens.expiresAt < new Date()) return deny('token expired');
  if (!row.users.active) return deny('user deactivated');
  req.user = toSessionUser(row.users);
  void db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.api_tokens.id)).catch(() => {});
  next();
}

const abs = (url: string) => (url.startsWith('/') ? config.PUBLIC_URL.replace(/\/$/, '') + url : url);

function buildServer(req: Request) {
  const user = req.user!;
  const server = new McpServer(
    { name: 'ai-portal-knowledge', version: '1.0.0' },
    { instructions: 'Interne Wissensdatenbank. Erst suchen, bei Bedarf ganze Dokumente lesen. Aussagen mit Quelle (Titel + URL) belegen.' },
  );

  server.registerTool('sammlungen_auflisten', {
    description: 'Listet die Wissenssammlungen, auf die du Zugriff hast, mit Beschreibung und Dokumentanzahl.',
    inputSchema: {},
  }, async () => {
    const [cols, stats] = await Promise.all([accessibleCollections(user), collectionStats()]);
    const out = cols.map((c) => ({ name: c.name, beschreibung: c.description, dokumente: stats.get(c.id)?.documents ?? 0 }));
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: { sammlungen: out } };
  });

  server.registerTool('wissensdatenbank_suchen', {
    description: 'Durchsucht interne Dokumente (Handbücher, Richtlinien, Confluence, SharePoint, Dateifreigaben). Hybrid aus semantischer und exakter Suche – auch für Fehlercodes und Hostnamen.',
    inputSchema: {
      query: z.string().min(1).max(1000).describe('Suchanfrage in natürlicher Sprache oder Stichworten'),
      sammlung: z.string().optional().describe('Optional: nur in dieser Sammlung suchen (siehe sammlungen_auflisten)'),
      anzahl: z.number().int().min(1).max(20).optional().describe('Anzahl Treffer, Standard 8'),
      metadaten: z.boolean().optional().describe('Autor, Datenquelle und Zeitpunkt der letzten Änderung je Treffer mitliefern'),
    },
  }, async ({ query, sammlung, anzahl, metadaten }) => {
    const cols = (await accessibleCollections(user)).filter((c) => !sammlung || c.name.toLowerCase() === sammlung.toLowerCase());
    if (sammlung && !cols.length) return { isError: true, content: [{ type: 'text', text: `Sammlung „${sammlung}“ nicht gefunden oder kein Zugriff` }] };
    const hits = await hybridSearch(query, cols.map((c) => c.id), anzahl ?? 8);
    await audit(req, {
      action: 'knowledge.search', details: { via: 'mcp', chars: query.length, collections: cols.map((c) => c.name), hits: hits.length,
        documents: [...new Set(hits.map((h) => h.documentId))], ...(config.AUDIT_LOG_PROMPTS ? { query } : {}) },
    });
    const treffer = hits.map((h, i) => ({
      nr: i + 1, titel: h.title, url: abs(h.url ?? `/api/knowledge/documents/${h.documentId}/open`), quelle: h.url ? 'Original' : 'Textfassung',
      sammlung: h.collection, dokument_id: h.documentId, auszug: h.content, ...(metadaten ? { metadaten: metaForTool(h.meta) } : {}),
    }));
    const text = treffer.length
      ? treffer.map((t) => `[${t.nr}] ${t.titel} (${t.sammlung})\n${t.url}\ndokument_id: ${t.dokument_id}\n${t.metadaten ? `Autor: ${t.metadaten.autor ?? 'unbekannt'} · Quelle: ${t.metadaten.datenquelle} · Zuletzt geändert: ${t.metadaten.zuletzt_geaendert}\n` : ''}${t.auszug}`).join('\n\n---\n\n')
      : 'Keine Treffer.';
    return { content: [{ type: 'text', text }], structuredContent: { treffer } };
  });

  server.registerTool('dokument_lesen', {
    description: 'Liefert den vollständigen extrahierten Text eines Dokuments (dokument_id aus der Suche).',
    inputSchema: {
      dokument_id: z.string().uuid(),
      max_zeichen: z.number().int().min(1000).max(200_000).optional().describe('Standard 50.000'),
      metadaten: z.boolean().optional().describe('Autor, Datenquelle und Zeitpunkt der letzten Änderung mitliefern'),
    },
  }, async ({ dokument_id, max_zeichen, metadaten }) => {
    const [d] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, dokument_id));
    const allowed = d && (await accessibleCollections(user)).some((c) => c.id === d.collectionId)
      && await publishedArticleDocument(d);
    if (!allowed) return { isError: true, content: [{ type: 'text', text: 'Dokument nicht gefunden oder kein Zugriff' }] };
    let text = d.text ?? '';
    const max = max_zeichen ?? 50_000;
    if (text.length > max) text = text.slice(0, max) + `\n\n[… gekürzt, insgesamt ${text.length} Zeichen]`;
    await audit(req, { action: 'knowledge.document.read', targetType: 'knowledge_document', targetId: d.id, details: { via: 'mcp', title: d.title } });
    const meta = metadaten ? await documentMeta(d.id) : null;
    const metaLine = meta ? (({ datenquelle, autor, zuletzt_geaendert }) => `Autor: ${autor ?? 'unbekannt'} · Datenquelle: ${datenquelle} · Zuletzt geändert: ${zuletzt_geaendert}\n`)(metaForTool(meta)) : '';
    return { content: [{ type: 'text', text: `# ${d.title}\nQuelle: ${d.url ?? 'keine (hochgeladen) – Textfassung: ' + abs(`/api/knowledge/documents/${d.id}/open`)}\n${metaLine}\n${text}` }] };
  });

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request (works behind any number of replicas). */
export async function mcpHandler(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).set('allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
  }
  const server = buildServer(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
