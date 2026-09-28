import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { t } from './i18n';
import { api, streamMessage, type Attachment, type ChatSummary, type Message, type ModelOpt, type Part, type StreamEvent } from './api';
import { STREAMING, answerText, applyToStreaming, defaultModelId, mcpProblems, messageParts, toolOutput, toolStatus, updateStreaming } from './chatStream';

// computed at render time so they follow the selected language
const suggestions = () => [
  { label: t('Fehleranalyse'), text: t('Analysiere den folgenden Fehler bzw. das angehängte Log. Nenne die wahrscheinlichste Ursache und konkrete nächste Schritte:') + '\n\n' },
  { label: t('Präsentation'), text: t('Erstelle eine Gliederung für eine Präsentation (Folie für Folie, mit Titel, Kernaussage und Stichpunkten) zum Thema:') + ' ' },
  { label: t('Zusammenfassen'), text: t('Fasse das angehängte Dokument in 5 Kernpunkten zusammen und nenne offene Fragen.') },
  { label: t('Text überarbeiten'), text: t('Überarbeite den folgenden Text – klarer, kürzer, gleicher Inhalt:') + '\n\n' },
];
const chatTitle = (title: string) => (title === 'Neuer Chat' ? t('Neuer Chat') : title);
const without = (list: Attachment[], id: string) => list.filter((x) => x.id !== id);

export function Chat() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [attNames, setAttNames] = useState<Record<string, string>>({});
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [modelId, setModelId] = useState('');
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<Attachment[]>([]);
  const [useMcp, setUseMcp] = useState(true);
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [kb, setKb] = useState<{ enabled: boolean; collections: { name: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const loadChats = () => api<ChatSummary[]>('/chats').then(setChats);

  useEffect(() => {
    loadChats();
    api<{ enabled: boolean; collections: { name: string }[] }>('/knowledge/collections').then(setKb).catch(() => setKb(null));
    api<ModelOpt[]>('/models').then((m) => {
      setModels(m);
      const preset = defaultModelId(m);
      setModelId((cur) => cur || preset);
    });
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const openChat = async (id: string) => {
    if (busy) return;
    const c = await api<{ modelId: string | null; messages: Message[]; attachments: Attachment[] }>(`/chats/${id}`);
    setActiveId(id);
    setMessages(c.messages);
    setAttNames(Object.fromEntries(c.attachments.map((a) => [a.id, a.filename])));
    if (c.modelId && models.some((m) => m.id === c.modelId)) setModelId(c.modelId);
    setNotice('');
  };

  const newChat = () => { if (!busy) { setActiveId(null); setMessages([]); setNotice(''); taRef.current?.focus(); } };

  const deleteChat = async (id: string) => {
    if (!confirm(t('Chat löschen?'))) return;
    await api(`/chats/${id}`, { method: 'DELETE' });
    if (id === activeId) newChat();
    loadChats();
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    [...files].forEach((f) => fd.append('files', f));
    try {
      const res = await api<Attachment[]>('/files', { body: fd });
      setPending((p) => [...p, ...res]);
      setAttNames((n) => ({ ...n, ...Object.fromEntries(res.map((a) => [a.id, a.filename])) }));
      const warn = res.filter((r) => r.warning).map((r) => `${r.filename}: ${r.warning}`);
      if (warn.length) setNotice(warn.join(' · '));
    } catch (e) { setNotice((e as Error).message); }
    if (fileRef.current) fileRef.current.value = '';
  };

  const send = async (text = input) => {
    if (!text.trim() || !modelId || busy) return;
    setBusy(true); setNotice('');
    let chatId = activeId;
    if (!chatId) {
      const c = await api<{ id: string }>('/chats', { body: { modelId } });
      chatId = c.id; setActiveId(c.id);
    }
    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text, parts: [], attachmentIds: pending.map((p) => p.id) };
    const asst: Message = { id: STREAMING, role: 'assistant', content: '', parts: [], attachmentIds: [] };
    setMessages((m) => [...m, userMsg, asst]);
    setInput(''); setPending([]);

    const onEvent = (e: StreamEvent) => {
      if (e.t === 'mcp') {
        const list = mcpProblems(e.status);
        if (list) setNotice(t('MCP nicht erreichbar: {list}', { list }));
      } else if (e.t === 'error') {
        setNotice(t('Fehler: {message}', { message: e.message }));
      } else {
        setMessages(applyToStreaming(e));
      }
    };

    abortRef.current = new AbortController();
    try {
      await streamMessage(chatId, { content: text, modelId, attachmentIds: userMsg.attachmentIds, useMcp, useKnowledge }, onEvent, abortRef.current.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setNotice((e as Error).message);
    } finally {
      setMessages((m) => updateStreaming(m, (x) => ({ ...x, id: crypto.randomUUID() })));
      setBusy(false); abortRef.current = null;
      loadChats();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const removePending = (id: string) => setPending((p) => without(p, id));

  const composer = (
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files); }}>
      {pending.length > 0 && (
        <div className="chips">
          {pending.map((a) => (
            <span key={a.id} className="chip">{a.filename}<button type="button" onClick={() => removePending(a.id)}>×</button></span>
          ))}
        </div>
      )}
      <textarea ref={taRef} rows={3} placeholder={t('Frage stellen, Log einfügen oder Datei anhängen …')} value={input}
        onChange={(e) => setInput(e.target.value)} onKeyDown={onKey}
        onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); upload(e.clipboardData.files); } }} />
      <div className="composer-bar">
        <button className="ghost" title={t('Datei anhängen')} onClick={() => fileRef.current?.click()}>＋ {t('Datei')}</button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        {kb?.enabled && kb.collections.length > 0 && (
          <label className="toggle" title={t('Sammlungen: {list}', { list: kb.collections.map((c) => c.name).join(', ') })}>
            <input type="checkbox" checked={useKnowledge} onChange={(e) => setUseKnowledge(e.target.checked)} /> {t('Wissensdatenbank')}
          </label>
        )}
        <label className="toggle"><input type="checkbox" checked={useMcp} onChange={(e) => setUseMcp(e.target.checked)} /> {t('MCP-Tools')}</label>
        <span className="spacer" />
        <select value={modelId} onChange={(e) => setModelId(e.target.value)} title={t('Modell')}>
          {models.length === 0 && <option value="">{t('Kein Modell freigegeben')}</option>}
          {models.map((m) => <option key={m.id} value={m.id}>{m.displayName} · {m.provider}</option>)}
        </select>
        {busy
          ? <button onClick={() => abortRef.current?.abort()}>{t('Stopp')}</button>
          : <button className="primary" disabled={!input.trim() || !modelId} onClick={() => send()}>{t('Senden')}</button>}
      </div>
    </div>
  );

  return (
    <div className="chat-layout">
      <aside className="sidebar">
        <button className="primary block" onClick={newChat}>{t('Neuer Chat')}</button>
        <ul>
          {chats.map((c) => (
            <li key={c.id} className={c.id === activeId ? 'active' : ''}>
              <button className="link" onClick={() => openChat(c.id)} title={chatTitle(c.title)}>{chatTitle(c.title)}</button>
              <button className="icon" onClick={() => deleteChat(c.id)} title={t('Löschen')}>×</button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="conversation">
        {messages.length === 0 ? (
          <div className="empty">
            <h2>{t('Wie kann ich helfen?')}</h2>
            {composer}
            <div className="suggestions">
              {suggestions().map((s) => (
                <button key={s.label} onClick={() => { setInput(s.text); taRef.current?.focus(); }}>{s.label}</button>
              ))}
            </div>
            {notice && <p className="notice">{notice}</p>}
          </div>
        ) : (
          <>
            <div className="messages">
              {messages.map((m) => <MessageView key={m.id} m={m} attNames={attNames} streaming={m.id === STREAMING} />)}
              <div ref={endRef} />
            </div>
            {notice && <p className="notice">{notice}</p>}
            {composer}
          </>
        )}
      </section>
    </div>
  );
}

function MessageView({ m, attNames, streaming }: { m: Message; attNames: Record<string, string>; streaming: boolean }) {
  if (m.role === 'user') {
    return (
      <div className="msg user">
        {m.attachmentIds.length > 0 && (
          <div className="chips">
            {m.attachmentIds.map((id) => <a key={id} className="chip" href={`/api/files/${id}`}>{attNames[id] ?? t('Datei')}</a>)}
          </div>
        )}
        <div className="bubble">{m.content}</div>
      </div>
    );
  }
  const parts = messageParts(m);
  return (
    <div className="msg assistant">
      {parts.map((p, i) => <PartView key={i} p={p} />)}
      {streaming && parts.length === 0 && <div className="typing">…</div>}
      {m.usage?.outputTokens != null && <div className="meta">{m.usage.inputTokens} → {m.usage.outputTokens} {t('Tokens')}</div>}
      {!streaming && parts.length > 0 && (
        <button type="button" className="ghost small" onClick={() => navigator.clipboard.writeText(answerText(parts))}>{t('Kopieren')}</button>
      )}
    </div>
  );
}

function PartView({ p }: { p: Part }) {
  if (p.type === 'text') return <div className="md"><Markdown remarkPlugins={[remarkGfm]}>{p.text}</Markdown></div>;
  if (p.name === 'wissensdatenbank_suchen') return <KnowledgePart p={p} />;
  return (
    <details className={`tool ${p.error ? 'err' : ''}`}>
      <summary>{toolStatus(p)} Tool <code>{p.name}</code></summary>
      <pre>{JSON.stringify(p.input, null, 2)}</pre>
      {p.output !== undefined && <pre>{toolOutput(p)}</pre>}
      {p.error && <pre>{p.error}</pre>}
    </details>
  );
}

type Treffer = { nr: number; titel: string; url: string; sammlung: string; quelle?: string };

function KnowledgePart({ p }: { p: Extract<Part, { type: 'tool' }> }) {
  let hits: Treffer[] | null = null;
  try {
    const o = typeof p.output === 'string' ? JSON.parse(p.output) : p.output;
    hits = (o as { treffer?: Treffer[] } | undefined)?.treffer ?? null;
  } catch { /* still running */ }
  const q = (p.input as { query?: string })?.query ?? '';
  return (
    <details className={`tool kb ${p.error ? 'err' : ''}`}>
      <summary>{p.error ? '✕' : hits ? '✓' : '…'} {t('Wissensdatenbank')}: „{q}“ {hits && <span className="muted">· {t('{n} Treffer', { n: hits.length })}</span>}</summary>
      {hits && (
        <ol className="hits">
          {hits.map((h) => (
            <li key={h.nr} value={h.nr}><a href={h.url} target="_blank" rel="noreferrer">{h.titel}</a> <span className="muted small">{h.sammlung}{h.quelle === 'Textfassung' ? ` · ${t('Textfassung')}` : ''}</span></li>
          ))}
        </ol>
      )}
      {p.error && <pre>{p.error}</pre>}
    </details>
  );
}
