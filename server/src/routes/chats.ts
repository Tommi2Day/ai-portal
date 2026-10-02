import { Router } from 'express';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { streamText, stepCountIs, type ToolSet } from 'ai';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { attachments, chats, mcpServers, messages, models, providers } from '../db/schema.js';
import { audit } from '../audit.js';
import { languageModel } from '../ai/providers.js';
import { openMcpSession } from '../ai/mcp.js';
import { AnswerRecorder, chatTitle, systemPrompt, toModelMessages, type StreamEvent } from '../ai/answer.js';
import { logger } from '../logger.js';
import { langOf, tr } from '../i18n.js';
import { accessibleCollections, knowledgeTool } from '../knowledge/search.js';
import { getEmbeddingSettings } from '../knowledge/embeddings.js';
import { pluginTools } from '../plugins/index.js';

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

const sendBody = z.object({
  content: z.string().min(1).max(200_000),
  modelId: z.string().uuid(),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
  useMcp: z.boolean().default(true),
  useKnowledge: z.boolean().default(true),
});
type SendBody = z.infer<typeof sendBody>;
type Req = Parameters<Parameters<typeof chatsRouter.post>[1]>[0];

/** Enabled model of an enabled provider, or undefined. */
async function availableModel(modelId: string) {
  const [mp] = await db.select().from(models).innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.id, modelId), eq(models.enabled, true), eq(providers.enabled, true)));
  return mp ? { model: mp.models, provider: mp.providers } : undefined;
}

/** History of the chat and the user's own attachments referenced by it or by the new prompt. */
async function loadHistory(chatId: string, userId: string, newIds: string[]) {
  const history = await db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.createdAt));
  const ids = [...new Set([...history.flatMap((m) => m.attachmentIds), ...newIds])];
  const atts = ids.length ? await db.select().from(attachments).where(and(inArray(attachments.id, ids), eq(attachments.userId, userId))) : [];
  return { history, attMap: new Map(atts.map((a) => [a.id, a])) };
}

/** Knowledge-base tool if enabled, configured and the user can see at least one collection. */
async function knowledgeTools(req: Req, chatId: string, use: boolean): Promise<ToolSet> {
  if (!config.KNOWLEDGE_ENABLED || !use || !(await getEmbeddingSettings())) return {};
  const cols = await accessibleCollections(req.user!);
  if (!cols.length) return {};
  return {
    wissensdatenbank_suchen: knowledgeTool(cols, (i) => void audit(req, {
      action: 'knowledge.search', targetType: 'chat', targetId: chatId,
      details: { via: 'chat', chars: i.query.length, collections: i.collections, hits: i.hits.length, documents: [...new Set(i.hits.map((h) => h.documentId))], ...(config.AUDIT_LOG_PROMPTS ? { query: i.query } : {}) },
    })),
  };
}

/** MCP servers of the user (if wanted); every tool call is audited. */
async function mcpTools(req: Req, use: boolean) {
  const servers = use ? await db.select().from(mcpServers).where(and(eq(mcpServers.userId, req.user!.id), eq(mcpServers.enabled, true))) : [];
  return openMcpSession(servers, (i) =>
    void audit(req, { action: 'mcp.tool_call', targetType: 'mcp_server', targetId: i.server.id, success: i.ok, details: { server: i.server.name, tool: i.tool, ms: i.ms, error: i.error } }),
  );
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs the model and passes every event for the browser to send. */
async function streamAnswer(rec: AnswerRecorder, opts: Parameters<typeof streamText>[0], send: (ev: StreamEvent) => void) {
  const result = streamText(opts);
  for await (const part of result.fullStream) {
    const ev = rec.handle(part);
    if (ev) send(ev);
  }
}

function startNdjson(res: import('express').Response) {
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('x-accel-buffering', 'no'); // nginx ingress: disable buffering
  res.flushHeaders();
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  return { send: (o: unknown) => res.write(JSON.stringify(o) + '\n'), abort };
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
  const body: SendBody = p.data;

  const [chat] = await db.select().from(chats).where(own(user.id, req.params.id));
  if (!chat) return res.status(404).end();
  const mp = await availableModel(body.modelId);
  if (!mp) return res.status(400).json({ error: 'Modell nicht verfügbar' });
  const { model, provider } = mp;

  const { history, attMap } = await loadHistory(chat.id, user.id, body.attachmentIds);
  if (body.attachmentIds.some((id) => !attMap.has(id))) return res.status(400).json({ error: 'Unbekannter Anhang' });
  const modelMessages = toModelMessages(history, body, attMap, model.supportsImages);

  const [userMsg] = await db.insert(messages).values({ chatId: chat.id, role: 'user', content: body.content, attachmentIds: body.attachmentIds, modelId: model.id }).returning();
  await audit(req, {
    action: 'chat.prompt', targetType: 'chat', targetId: chat.id,
    details: { model: model.modelId, provider: provider.name, chars: body.content.length, attachments: body.attachmentIds.length, ...(config.AUDIT_LOG_PROMPTS ? { prompt: body.content } : {}) },
  });

  const { send, abort } = startNdjson(res);
  const lang = langOf(req);
  const mcp = await mcpTools(req, body.useMcp);
  if (mcp.status.length) send({ t: 'mcp', status: mcp.status.map((s) => ({ ...s, error: s.error && tr(s.error, lang) })) });
  const kb = await knowledgeTools(req, chat.id, body.useKnowledge);

  const started = Date.now();
  const rec = new AnswerRecorder();
  try {
    const plugin = await pluginTools(user);
    for (const name of Object.keys(plugin)) {
      if (name in mcp.tools || name in kb) throw new Error(`Plugin tool name collision: ${name}`);
    }
    const tools = { ...mcp.tools, ...kb, ...plugin };
    await streamAnswer(rec, {
      model: languageModel(provider, model),
      system: systemPrompt(Object.keys(kb).length > 0, lang),
      messages: modelMessages,
      tools: Object.keys(tools).length ? tools : undefined,
      stopWhen: stepCountIs(config.MAX_TOOL_STEPS),
      abortSignal: abort.signal,
    }, (ev) => send(ev.t === 'error' ? { ...ev, message: tr(ev.message, lang) } : ev));
  } catch (e) {
    rec.error = abort.signal.aborted ? 'abgebrochen' : errorText(e);
    logger.warn({ err: e, chat: chat.id }, 'stream failed');
    send({ t: 'error', message: tr(rec.error, lang) });
  } finally {
    await mcp.close();
  }

  const { text, parts, usage, error } = rec;
  const [asst] = await db.insert(messages).values({ chatId: chat.id, role: 'assistant', content: text, parts, modelId: model.id, usage }).returning();
  const title = history.length === 0 ? chatTitle(body.content) : undefined;
  await db.update(chats).set({ updatedAt: new Date(), modelId: model.id, ...(title ? { title } : {}) }).where(eq(chats.id, chat.id));

  await audit(req, {
    action: error ? 'chat.error' : 'chat.completion', targetType: 'chat', targetId: chat.id, success: !error,
    details: {
      model: model.modelId, provider: provider.name, ms: Date.now() - started,
      inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens,
      toolCalls: rec.toolNames(), error,
      userMessageId: userMsg.id, assistantMessageId: asst.id,
    },
  });
  send({ t: 'done', messageId: asst.id, usage, title });
  res.end();
});
