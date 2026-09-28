import { beforeEach, describe, expect, it } from 'vitest';
import type { Message, ModelOpt, Part } from '../src/api';
import { STREAMING, answerText, applyEvent, defaultModelId, mcpProblems, messageParts, toolOutput, toolStatus, updateStreaming } from '../src/chatStream';
import { availableLabel } from '../src/availableModels';
import { setLang } from '../src/i18n';

beforeEach(() => setLang('de'));

describe('applyEvent', () => {
  it('builds the parts of a streaming answer from the events', () => {
    let parts: Part[] = [];
    for (const e of [
      { t: 'text', d: 'Ich ' },
      { t: 'text', d: 'prüfe.' },
      { t: 'tool-call', id: 'c1', name: 'db__query', input: { sql: 'x' } },
      { t: 'tool-result', id: 'c1', output: '{"rows":1}' },
      { t: 'tool-call', id: 'c2', name: 'git__mr', input: {} },
      { t: 'tool-error', id: 'c2', error: '403' },
      { t: 'text', d: 'Fertig' },
      { t: 'error', message: 'ignored here' },
    ] as const) parts = applyEvent(parts, e);
    expect(parts).toEqual([
      { type: 'text', text: 'Ich prüfe.' },
      { type: 'tool', toolCallId: 'c1', name: 'db__query', input: { sql: 'x' }, output: '{"rows":1}' },
      { type: 'tool', toolCallId: 'c2', name: 'git__mr', input: {}, error: '403' },
      { type: 'text', text: 'Fertig' },
    ]);
    expect(answerText(parts)).toBe('Ich prüfe.Fertig');
  });
});

describe('message helpers', () => {
  const msg = (o: Partial<Message>): Message => ({ id: 'm', role: 'assistant', content: '', parts: [], attachmentIds: [], ...o });

  it('updates only the streaming message', () => {
    const list = [msg({ id: 'a' }), msg({ id: STREAMING })];
    expect(updateStreaming(list, (x) => ({ ...x, id: 'done' })).map((x) => x.id)).toEqual(['a', 'done']);
  });

  it('renders parts, or the content of older messages', () => {
    expect(messageParts(msg({ content: 'alt' }))).toEqual([{ type: 'text', text: 'alt' }]);
    expect(messageParts(msg({}))).toEqual([]);
    expect(messageParts(msg({ content: 'x', parts: [{ type: 'text', text: 'neu' }] }))).toEqual([{ type: 'text', text: 'neu' }]);
  });

  it('shows tool status and output', () => {
    const tool = { type: 'tool', toolCallId: 'c', name: 't', input: {} } as const;
    expect(toolStatus(tool)).toBe('…');
    expect(toolStatus({ ...tool, output: 'ok' })).toBe('✓');
    expect(toolStatus({ ...tool, error: 'x' })).toBe('✕');
    expect(toolOutput({ ...tool, output: 'text' })).toBe('text');
    expect(toolOutput({ ...tool, output: { a: 1 } })).toBe('{\n  "a": 1\n}');
  });

  it('preselects the default model, else the first', () => {
    const m = (id: string, isDefault = false) => ({ id, isDefault }) as ModelOpt;
    expect(defaultModelId([m('a'), m('b', true)])).toBe('b');
    expect(defaultModelId([m('a'), m('b')])).toBe('a');
    expect(defaultModelId([])).toBe('');
  });

  it('lists unreachable MCP servers', () => {
    expect(mcpProblems([{ name: 'git', ok: true }, { name: 'jira', ok: false, error: 'timeout' }])).toBe('jira (timeout)');
    expect(mcpProblems([{ name: 'git', ok: true }])).toBe('');
  });
});

describe('availableLabel', () => {
  const m = { modelId: 'eu.anthropic.claude-sonnet', displayName: 'Claude Sonnet', kind: 'chat', supportsImages: true, via: 'profile', access: 'granted', legacy: false } as const;
  it('shows the geography of a profile and marks legacy models and missing access', () => {
    expect(availableLabel(m)).toBe('Claude Sonnet (eu)');
    expect(availableLabel({ ...m, via: 'region', modelId: 'amazon.titan', legacy: true, access: 'missing' })).toBe('Claude Sonnet – veraltet – kein Modellzugriff');
  });
});
