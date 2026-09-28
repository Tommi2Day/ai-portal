import type { Message, ModelOpt, Part, StreamEvent } from './api';

/** Id of the assistant message while its answer is streaming. */
export const STREAMING = 'streaming';

type ToolPart = Extract<Part, { type: 'tool' }>;

const patchTool = (parts: Part[], id: string, patch: Partial<ToolPart>): Part[] =>
  parts.map((x) => (x.type === 'tool' && x.toolCallId === id ? { ...x, ...patch } : x));

const appendText = (parts: Part[], d: string): Part[] => {
  const last = parts.at(-1);
  return last?.type === 'text' ? [...parts.slice(0, -1), { ...last, text: last.text + d }] : [...parts, { type: 'text', text: d }];
};

/** Applies a content event of the answer stream to the parts of the streaming message (other events: unchanged). */
export function applyEvent(parts: Part[], e: StreamEvent): Part[] {
  switch (e.t) {
    case 'text': return appendText(parts, e.d);
    case 'tool-call': return [...parts, { type: 'tool', toolCallId: e.id, name: e.name, input: e.input }];
    case 'tool-result': return patchTool(parts, e.id, { output: e.output });
    case 'tool-error': return patchTool(parts, e.id, { error: e.error });
    default: return parts;
  }
}

/** Replaces the streaming message in the list via fn. */
export const updateStreaming = (list: Message[], fn: (m: Message) => Message) => list.map((x) => (x.id === STREAMING ? fn(x) : x));

/** Model preselected for a new chat: the default model, else the first one. */
export const defaultModelId = (models: ModelOpt[]) => (models.find((x) => x.isDefault) ?? models[0])?.id ?? '';

/** Parts to render; older messages only have content. */
export const messageParts = (m: Message): Part[] => {
  if (m.parts.length) return m.parts;
  return m.content ? [{ type: 'text', text: m.content }] : [];
};

/** Text of the answer without tool calls (for "Copy"). */
export const answerText = (parts: Part[]) => parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

/** Status symbol of a tool call: error, running, done. */
export const toolStatus = (p: ToolPart) => {
  if (p.error) return '✕';
  return p.output === undefined ? '…' : '✓';
};

/** Tool output as shown in the chat. */
export const toolOutput = (p: ToolPart) => (typeof p.output === 'string' ? p.output : JSON.stringify(p.output, null, 2));

/** Notice for MCP servers that could not be reached, or '' if all are fine. */
export const mcpProblems = (status: { name: string; ok: boolean; error?: string }[]) =>
  status.filter((s) => !s.ok).map((b) => `${b.name} (${b.error})`).join(', ');
