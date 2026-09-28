import { describe, expect, it } from 'vitest';
import type { TextStreamPart, ToolSet } from 'ai';
import { AnswerRecorder, KNOWLEDGE_PROMPT, buildUserContent, chatTitle, systemPrompt, toModelMessages } from '../src/ai/answer.js';
import type { Attachment } from '../src/db/schema.js';

const att = (id: string, o: Partial<Attachment>) => ({ id, filename: `${id}.txt`, mimeType: 'text/plain', extractedText: null, data: Buffer.from('x'), ...o }) as Attachment;
const part = (p: object) => p as TextStreamPart<ToolSet>;

describe('systemPrompt', () => {
  it('adds the knowledge-base instructions and the English hint only when needed', () => {
    expect(systemPrompt(false, 'de')).not.toContain(KNOWLEDGE_PROMPT.trim());
    expect(systemPrompt(true, 'de')).toContain('wissensdatenbank_suchen');
    expect(systemPrompt(false, 'en')).toContain('answer in English');
    expect(systemPrompt(false, 'de')).not.toContain('answer in English');
  });
});

describe('buildUserContent / toModelMessages', () => {
  const log = att('a1', { filename: 'app.log', extractedText: 'ERROR x' });
  const img = att('a2', { filename: 'shot.png', mimeType: 'image/png' });

  it('puts text attachments in front of the prompt and images only for image models', () => {
    const withImages = buildUserContent('Why?', [log, img], true) as { type: string; text?: string }[];
    expect(withImages[0].text).toBe('<datei name="app.log">\nERROR x\n</datei>\n\nWhy?');
    expect(withImages.map((p) => p.type)).toEqual(['text', 'image']);
    expect((buildUserContent('Why?', [img], false) as unknown[]).length).toBe(1);
  });

  it('maps the history, skips attachments of other users and appends the new prompt', () => {
    const attMap = new Map([[log.id, log]]);
    const msgs = toModelMessages(
      [{ role: 'user', content: 'first', attachmentIds: ['a1', 'foreign'] }, { role: 'assistant', content: '', attachmentIds: [] }],
      { content: 'second', attachmentIds: [] }, attMap, false,
    );
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((msgs[0].content as { text: string }[])[0].text).toContain('app.log');
    expect(msgs[1].content).toBe('(leer)');
    expect((msgs[2].content as { text: string }[])[0].text).toBe('second');
  });
});

describe('chatTitle', () => {
  it('collapses whitespace and cuts at 60 characters', () => {
    expect(chatTitle('  Warum\n\nschlägt   das Backup fehl? ')).toBe('Warum schlägt das Backup fehl?');
    expect(chatTitle('x'.repeat(80))).toHaveLength(60);
  });
});

describe('AnswerRecorder', () => {
  it('collects text, tool calls with results/errors and usage, and returns the browser events', () => {
    const r = new AnswerRecorder();
    const events = [
      part({ type: 'text-delta', text: 'Ich ' }),
      part({ type: 'tool-call', toolCallId: 'c1', toolName: 'db__query', input: { sql: 'select 1' } }),
      part({ type: 'tool-result', toolCallId: 'c1', output: { rows: 1 } }),
      part({ type: 'tool-call', toolCallId: 'c2', toolName: 'git__mr', input: {} }),
      part({ type: 'tool-error', toolCallId: 'c2', error: new Error('403') }),
      part({ type: 'text-delta', text: 'prüfe' }),
      part({ type: 'text-delta', text: ' das.' }),
      part({ type: 'finish', totalUsage: { inputTokens: 10, outputTokens: 3 } }),
      part({ type: 'start-step' }),
    ].map((p) => r.handle(p));

    expect(events.map((e) => e?.t ?? null)).toEqual(['text', 'tool-call', 'tool-result', 'tool-call', 'tool-error', 'text', 'text', null, null]);
    expect(r.text).toBe('Ich prüfe das.');
    expect(r.parts).toEqual([
      { type: 'text', text: 'Ich ' },
      { type: 'tool', toolCallId: 'c1', name: 'db__query', input: { sql: 'select 1' }, output: '{"rows":1}' },
      { type: 'tool', toolCallId: 'c2', name: 'git__mr', input: {}, error: 'Error: 403' },
      { type: 'text', text: 'prüfe das.' },
    ]);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(r.toolNames()).toEqual(['db__query', 'git__mr']);
    expect(r.error).toBeUndefined();
  });

  it('truncates long tool output and records stream errors', () => {
    const r = new AnswerRecorder();
    r.handle(part({ type: 'tool-call', toolCallId: 'c', toolName: 't', input: {} }));
    const ev = r.handle(part({ type: 'tool-result', toolCallId: 'c', output: 'y'.repeat(30_000) })) as { output: string };
    expect(ev.output.length).toBe(20_001);
    expect(ev.output.endsWith('…')).toBe(true);
    expect(r.handle(part({ type: 'error', error: new Error('throttled') }))).toEqual({ t: 'error', message: 'throttled' });
    expect(r.error).toBe('throttled');
  });
});
