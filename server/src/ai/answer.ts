/**
 * Pure building blocks of a chat answer (no database, no HTTP): prompt, model messages from the history,
 * and the recorder that turns the AI SDK stream into NDJSON events and the stored message parts.
 */
import type { ModelMessage, TextStreamPart, ToolSet, UserContent } from 'ai';
import type { Attachment, Message, MessagePart } from '../db/schema.js';
import { isImage } from '../extract.js';
import type { Lang } from '../i18n.js';

export const SYSTEM_PROMPT = () => `Du bist der KI-Assistent des internen AI Portals.
Heute ist ${new Date().toLocaleDateString('de-DE', { dateStyle: 'full' })}.
Antworte in der Sprache der Nutzerin bzw. des Nutzers, präzise und strukturiert, mit Markdown.
Bei Fehleranalysen: nenne die wahrscheinlichste Ursache zuerst, belege sie mit Zeilen aus Logs/Stacktraces und schlage konkrete nächste Schritte vor.
Bei Präsentationen: liefere eine Gliederung Folie für Folie mit Titel, Kernaussage und Stichpunkten.
Nutze verfügbare Tools, wenn sie für die Antwort nötig sind.`;

export const KNOWLEDGE_PROMPT = `
Dir steht die interne Wissensdatenbank zur Verfügung (Tool wissensdatenbank_suchen). Nutze sie bei Fragen zu internen Themen, bevor du antwortest.
Belege Aussagen aus der Wissensdatenbank mit [nr] und schließe mit einer Liste "Quellen" als Markdown-Links [nr] [titel](url). Erfinde keine Quellen; wenn nichts gefunden wird, sage das.`;

const ENGLISH_UI = '\nThe user interface is set to English: answer in English unless the user writes in another language.';

export const systemPrompt = (withKnowledge: boolean, lang: Lang) =>
  SYSTEM_PROMPT() + (withKnowledge ? KNOWLEDGE_PROMPT : '') + (lang === 'en' ? ENGLISH_UI : '');

/** Text attachments go in front of the prompt as <datei> blocks; images only for models that understand them. */
export function buildUserContent(text: string, atts: Attachment[], images: boolean): UserContent {
  const parts: Exclude<UserContent, string> = [];
  const docs = atts.filter((a) => a.extractedText).map((a) => `<datei name="${a.filename}">\n${a.extractedText}\n</datei>`);
  parts.push({ type: 'text', text: docs.length ? `${docs.join('\n\n')}\n\n${text}` : text });
  if (images) for (const a of atts) if (isImage(a.mimeType)) parts.push({ type: 'image', image: a.data, mediaType: a.mimeType });
  return parts;
}

/** History + new prompt as model messages; attachments that are not in attMap (not the user's) are left out. */
export function toModelMessages(
  history: Pick<Message, 'role' | 'content' | 'attachmentIds'>[],
  prompt: { content: string; attachmentIds: string[] },
  attMap: Map<string, Attachment>,
  images: boolean,
): ModelMessage[] {
  const atts = (ids: string[]) => ids.map((id) => attMap.get(id)).filter((a): a is Attachment => !!a);
  const out: ModelMessage[] = history.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: buildUserContent(m.content, atts(m.attachmentIds), images) }
      : { role: 'assistant', content: m.content || '(leer)' },
  );
  out.push({ role: 'user', content: buildUserContent(prompt.content, atts(prompt.attachmentIds), images) });
  return out;
}

/** Title of a new chat: the first prompt, whitespace collapsed, max. 60 characters. */
export const chatTitle = (content: string) => content.replaceAll(/\s+/g, ' ').trim().slice(0, 60);

export type StreamEvent =
  | { t: 'text'; d: string }
  | { t: 'tool-call'; id: string; name: string; input: unknown }
  | { t: 'tool-result'; id: string; output: string }
  | { t: 'tool-error'; id: string; error: string }
  | { t: 'error'; message: string };

type ToolPart = Extract<MessagePart, { type: 'tool' }>;
const MAX_TOOL_OUTPUT = 20_000;

/** Collects the answer (text, tool parts, usage, error) and maps each stream part to the event for the browser. */
export class AnswerRecorder {
  readonly parts: MessagePart[] = [];
  text = '';
  usage: { inputTokens?: number; outputTokens?: number } | undefined;
  error: string | undefined;

  private tool(id: string) {
    return this.parts.find((x): x is ToolPart => x.type === 'tool' && x.toolCallId === id);
  }

  private addText(d: string) {
    this.text += d;
    const last = this.parts.at(-1);
    if (last?.type === 'text') last.text += d; else this.parts.push({ type: 'text', text: d });
  }

  /** Returns the event to send, or null for parts the browser does not need. */
  handle(part: TextStreamPart<ToolSet>): StreamEvent | null {
    switch (part.type) {
      case 'text-delta':
        this.addText(part.text);
        return { t: 'text', d: part.text };
      case 'tool-call':
        this.parts.push({ type: 'tool', toolCallId: part.toolCallId, name: part.toolName, input: part.input });
        return { t: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input };
      case 'tool-result': {
        const out = JSON.stringify(part.output ?? null);
        const trimmed = out.length > MAX_TOOL_OUTPUT ? out.slice(0, MAX_TOOL_OUTPUT) + '…' : out;
        const tp = this.tool(part.toolCallId);
        if (tp) tp.output = trimmed;
        return { t: 'tool-result', id: part.toolCallId, output: trimmed };
      }
      case 'tool-error': {
        const tp = this.tool(part.toolCallId);
        if (tp) tp.error = String(part.error);
        return { t: 'tool-error', id: part.toolCallId, error: String(part.error) };
      }
      case 'error':
        this.error = part.error instanceof Error ? part.error.message : String(part.error);
        return { t: 'error', message: this.error };
      case 'finish':
        this.usage = { inputTokens: part.totalUsage.inputTokens, outputTokens: part.totalUsage.outputTokens };
        return null;
      default:
        return null;
    }
  }

  toolNames() {
    return this.parts.filter((x): x is ToolPart => x.type === 'tool').map((x) => x.name);
  }
}
