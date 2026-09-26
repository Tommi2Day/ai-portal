import { Router } from 'express';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { streamText, stepCountIs, type ModelMessage, type UserContent } from 'ai';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { attachments, chats, mcpServers, messages, models, providers, type MessagePart } from '../db/schema.js';
import { audit } from '../audit.js';
import { languageModel } from '../ai/providers.js';
import { openMcpSession } from '../ai/mcp.js';
import { isImage } from '../extract.js';
import { logger } from '../logger.js';
import { langOf, tr } from '../i18n.js';
import { accessibleCollections, knowledgeTool } from '../knowledge/search.js';
import { getEmbeddingSettings } from '../knowledge/embeddings.js';

export const chatsRouter = Router();
export const modelsRouter = Router();

/** Models a user can pick: enabled models of enabled providers. */
modelsRouter.get('/', async (_req, res) => {
  const rows = await db
    .select({ id: models.id, displayName: models.displayName, description: models.description, supportsImages: models.supportsImages, isDefault: models.isDefault, provider: providers.name })
    .from(models).innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.enabled, true)))
    .orderBy(asc(models.sort), asc(models.displayName));
  res.json(rows);
});

const own = (userId: string, id: string) => and(eq(chats.userId, userId), eq(chats.id, id));

chatsRouter.get('/', async (req, res) => {
  res.json(await db.select({ id: chats.id, title: chats.title, updatedAt: chats.updatedAt }).from(chats)
    .where(eq(chats.userId, req.user!.id)).orderBy(desc(chats.updatedAt)).limit(200));
});

chatsRouter.post('/', async (req, res) => {
  const modelId = z.string().uuid().optional().parse(req.body?.modelId);
  const [c] = await db.insert(chats).values({ userId: req.user!.id, modelId }).returning();
  await audit(req, { action: 'chat.create', targetType: 'chat', targetId: c.id });
  res.status(201).json(c);
});

chatsRouter.get('/:id', async (req, res) => {
  const [c] = await db.select().from(chats).where(own(req.user!.id, req.params.id));
  if (!c) return res.status(404).end();
  const msgs = await db.select().from(messages).where(eq(messages.chatId, c.id)).orderBy(asc(messages.createdAt));
  const attIds = [...new Set(msgs.flatMap((m) => m.attachmentIds))];
  const atts = attIds.length
    ? await db.select({ id: attachments.id, filename: attachments.filename, mimeType: attachments.mimeType, size: attachments.size })
        .from(attachments).where(and(inArray(attachments.id, attIds), eq(attachments.userId, req.user!.id)))
    : [];
  res.json({ ...c, messages: msgs, attachments: atts });
});

chatsRouter.patch('/:id', async (req, res) => {
  const title = z.string().min(1).max(200).parse(req.body?.title);
  const [c] = await db.update(chats).set({ title }).where(own(req.user!.id, req.params.id)).returning();
  if (!c) return res.status(404).end();
  res.json(c);
});

chatsRouter.delete('/:id', async (req, res) => {
  const [c] = await db.delete(chats).where(own(req.user!.id, req.params.id)).returning();
  if (!c) return res.status(404).end();
  await audit(req, { action: 'chat.delete', targetType: 'chat', targetId: c.id, details: { title: c.title } });
  res.status(204).end();
});

const SYSTEM_PROMPT = () => `Du bist der KI-Assistent des internen AI Portals.
Heute ist ${new Date().toLocaleDateString('de-DE', { dateStyle: 'full' })}.
Antworte in der Sprache der Nutzerin bzw. des Nutzers, präzise und strukturiert, mit Markdown.
Bei Fehleranalysen: nenne die wahrscheinlichste Ursache zuerst, belege sie mit Zeilen aus Logs/Stacktraces und schlage konkrete nächste Schritte vor.
Bei Präsentationen: liefere eine Gliederung Folie für Folie mit Titel, Kernaussage und Stichpunkten.
Nutze verfügbare Tools, wenn sie für die Antwort nötig sind.`;

const sendBody = z.object({
  content: z.string().min(1).max(200_000),
  modelId: z.string().uuid(),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
  useMcp: z.boolean().default(true),
  useKnowledge: z.boolean().default(true),
});

type Att = typeof attachments.$inferSelect;

function buildUserContent(text: string, atts: Att[], images: boolean): UserContent {
  const parts: Exclude<UserContent, string> = [];
  const docs = atts.filter((a) => a.extractedText).map((a) => `<datei name="${a.filename}">\n${a.extractedText}\n</datei>`);
  parts.push({ type: 'text', text: docs.length ? `${docs.join('\n\n')}\n\n${text}` : text });
  if (images) for (const a of atts) if (isImage(a.mimeType)) parts.push({ type: 'image', image: a.data, mediaType: a.mimeType });
  return parts;
}

/**
 * Streams the answer as NDJSON lines:
 *  {t:"text",d}  {t:"tool-call",id,name,input}  {t:"tool-result",id,output}  {t:"tool-error",id,error}
 *  {t:"mcp",status}  {t:"error",message}  {t:"done",messageId,usage,title}
 */
chatsRouter.post('/:id/messages', async (req, res) => {
  const user = req.user!;
  const p = sendBody.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Ungültige Eingabe', issues: p.error.issues });
  const { content, modelId, attachmentIds, useMcp, useKnowledge } = p.data;

  const [chat] = await db.select().from(chats).where(own(user.id, req.params.id));
  if (!chat) return res.status(404).end();
  const [mp] = await db.select().from(models).innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.id, modelId), eq(models.enabled, true), eq(providers.enabled, true)));
  if (!mp) return res.status(400).json({ error: 'Modell nicht verfügbar' });
  const { models: model, providers: provider } = mp;

  // History + attachments (only the user's own files)
  const history = await db.select().from(messages).where(eq(messages.chatId, chat.id)).orderBy(asc(messages.createdAt));
  const allAttIds = [...new Set([...history.flatMap((m) => m.attachmentIds), ...attachmentIds])];
  const atts = allAttIds.length
    ? await db.select().from(attachments).where(and(inArray(attachments.id, allAttIds), eq(attachments.userId, user.id)))
    : [];
  const attMap = new Map(atts.map((a) => [a.id, a]));
  if (attachmentIds.some((id) => !attMap.has(id))) return res.status(400).json({ error: 'Unbekannter Anhang' });

  const modelMessages: ModelMessage[] = history.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: buildUserContent(m.content, m.attachmentIds.map((id) => attMap.get(id)!).filter(Boolean), model.supportsImages) }
      : { role: 'assistant', content: m.content || '(leer)' },
  );
  modelMessages.push({ role: 'user', content: buildUserContent(content, attachmentIds.map((id) => attMap.get(id)!), model.supportsImages) });

  const [userMsg] = await db.insert(messages).values({ chatId: chat.id, role: 'user', content, attachmentIds, modelId: model.id }).returning();
  await audit(req, {
    action: 'chat.prompt', targetType: 'chat', targetId: chat.id,
    details: { model: model.modelId, provider: provider.name, chars: content.length, attachments: attachmentIds.length, ...(config.AUDIT_LOG_PROMPTS ? { prompt: content } : {}) },
  });

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('x-accel-buffering', 'no'); // nginx ingress: disable buffering
  res.flushHeaders();
  const send = (o: unknown) => res.write(JSON.stringify(o) + '\n');

  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });

  const servers = useMcp ? await db.select().from(mcpServers).where(and(eq(mcpServers.userId, user.id), eq(mcpServers.enabled, true))) : [];
  const mcp = await openMcpSession(servers, (i) =>
    void audit(req, { action: 'mcp.tool_call', targetType: 'mcp_server', targetId: i.server.id, success: i.ok, details: { server: i.server.name, tool: i.tool, ms: i.ms, error: i.error } }),
  );
  const lang = langOf(req);
  if (mcp.status.length) send({ t: 'mcp', status: mcp.status.map((s) => ({ ...s, error: s.error && tr(s.error, lang) })) });

  const tools = { ...mcp.tools };
  let systemExtra = '';
  if (config.KNOWLEDGE_ENABLED && useKnowledge && (await getEmbeddingSettings())) {
    const cols = await accessibleCollections(user);
    if (cols.length) {
      tools.wissensdatenbank_suchen = knowledgeTool(cols, (i) => void audit(req, {
        action: 'knowledge.search', targetType: 'chat', targetId: chat.id,
        details: { via: 'chat', chars: i.query.length, collections: i.collections, hits: i.hits.length, documents: [...new Set(i.hits.map((h) => h.documentId))], ...(config.AUDIT_LOG_PROMPTS ? { query: i.query } : {}) },
      }));
      systemExtra = `\nDir steht die interne Wissensdatenbank zur Verfügung (Tool wissensdatenbank_suchen). Nutze sie bei Fragen zu internen Themen, bevor du antwortest.
Belege Aussagen aus der Wissensdatenbank mit [nr] und schließe mit einer Liste "Quellen" als Markdown-Links [nr] [titel](url). Erfinde keine Quellen; wenn nichts gefunden wird, sage das.`;
    }
  }

  const started = Date.now();
  const parts: MessagePart[] = [];
  let text = '';
  const pushText = (d: string) => {
    text += d;
    const last = parts.at(-1);
    if (last?.type === 'text') last.text += d; else parts.push({ type: 'text', text: d });
  };
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let error: string | undefined;

  try {
    const result = streamText({
      model: languageModel(provider, model),
      system: SYSTEM_PROMPT() + systemExtra + (lang === 'en' ? '\nThe user interface is set to English: answer in English unless the user writes in another language.' : ''),
      messages: modelMessages,
      tools: Object.keys(tools).length ? tools : undefined,
      stopWhen: stepCountIs(config.MAX_TOOL_STEPS),
      abortSignal: abort.signal,
    });
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          pushText(part.text); send({ t: 'text', d: part.text }); break;
        case 'tool-call':
          parts.push({ type: 'tool', toolCallId: part.toolCallId, name: part.toolName, input: part.input });
          send({ t: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input }); break;
        case 'tool-result': {
          const tp = parts.find((x) => x.type === 'tool' && x.toolCallId === part.toolCallId) as Extract<MessagePart, { type: 'tool' }> | undefined;
          const out = JSON.stringify(part.output ?? null);
          const trimmed = out.length > 20_000 ? out.slice(0, 20_000) + '…' : out;
          if (tp) tp.output = trimmed;
          send({ t: 'tool-result', id: part.toolCallId, output: trimmed }); break;
        }
        case 'tool-error': {
          const tp = parts.find((x) => x.type === 'tool' && x.toolCallId === part.toolCallId) as Extract<MessagePart, { type: 'tool' }> | undefined;
          if (tp) tp.error = String(part.error);
          send({ t: 'tool-error', id: part.toolCallId, error: String(part.error) }); break;
        }
        case 'error':
          error = part.error instanceof Error ? part.error.message : String(part.error);
          send({ t: 'error', message: tr(error, lang) }); break;
        case 'finish':
          usage = { inputTokens: part.totalUsage.inputTokens, outputTokens: part.totalUsage.outputTokens }; break;
      }
    }
  } catch (e) {
    error = abort.signal.aborted ? 'abgebrochen' : e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, chat: chat.id }, 'stream failed');
    send({ t: 'error', message: tr(error, lang) });
  } finally {
    await mcp.close();
  }

  const [asst] = await db.insert(messages).values({ chatId: chat.id, role: 'assistant', content: text, parts, modelId: model.id, usage }).returning();
  const title = history.length === 0 ? content.replace(/\s+/g, ' ').trim().slice(0, 60) : undefined;
  await db.update(chats).set({ updatedAt: new Date(), modelId: model.id, ...(title ? { title } : {}) }).where(eq(chats.id, chat.id));

  await audit(req, {
    action: error ? 'chat.error' : 'chat.completion', targetType: 'chat', targetId: chat.id, success: !error,
    details: {
      model: model.modelId, provider: provider.name, ms: Date.now() - started,
      inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens,
      toolCalls: parts.filter((x) => x.type === 'tool').map((x) => (x as { name: string }).name), error,
      userMessageId: userMsg.id, assistantMessageId: asst.id,
    },
  });
  send({ t: 'done', messageId: asst.id, usage, title });
  res.end();
});
