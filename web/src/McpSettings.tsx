import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { fmtDate, fmtDateTime, t } from './i18n';

interface Srv {
  id: string; name: string; url: string; transport: 'streamable-http' | 'sse'; enabled: boolean;
  headerNames: string[]; lastStatus: string | null; lastError: string | null; toolCount: number | null;
}
interface TestResult { ok: boolean; tools?: { name: string; description?: string }[]; error?: string }

const empty: { name: string; url: string; transport: 'streamable-http' | 'sse'; headerName: string; headerValue: string } = { name: '', url: '', transport: 'streamable-http', headerName: 'Authorization', headerValue: '' };

export function McpSettings() {
  const [list, setList] = useState<Srv[]>([]);
  const [form, setForm] = useState(empty);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [error, setError] = useState('');

  const load = () => api<Srv[]>('/mcp-servers').then(setList);
  useEffect(() => { load(); }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try {
      await api('/mcp-servers', {
        body: {
          name: form.name, url: form.url, transport: form.transport,
          headers: form.headerValue ? { [form.headerName]: form.headerValue } : undefined,
        },
      });
      setForm(empty); load();
    } catch (err) { setError((err as Error).message); }
  };

  const test = async (id: string) => {
    setTests((cur) => ({ ...cur, [id]: { ok: false, error: t('teste …') } }));
    const r = await api<TestResult>(`/mcp-servers/${id}/test`, { method: 'POST' });
    setTests((cur) => ({ ...cur, [id]: r })); load();
  };

  return (
    <div className="page">
      <h2>{t('Meine MCP-Server')}</h2>
      <p className="muted">{t('Remote-MCP-Server stellen dem Modell Werkzeuge bereit (z. B. Ticketsystem, Monitoring, Wiki). Zugangsdaten werden verschlüsselt gespeichert und nur serverseitig verwendet.')}</p>
      <table>
        <thead><tr><th>{t('Name')}</th><th>URL</th><th>{t('Transport')}</th><th>{t('Status')}</th><th>{t('Aktiv')}</th><th /></tr></thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.id}>
              <td>{s.name}{s.headerNames.length > 0 && <div className="muted small">{t('Header')}: {s.headerNames.join(', ')}</div>}</td>
              <td className="mono small">{s.url}</td>
              <td>{s.transport}</td>
              <td>
                {s.lastStatus === 'ok' ? `✓ ${t('{n} Tools', { n: s.toolCount ?? 0 })}` : s.lastStatus === 'error' ? <span className="error">✕ {s.lastError}</span> : '–'}
                {tests[s.id]?.tools && <div className="muted small">{tests[s.id].tools!.map((x) => x.name).join(', ')}</div>}
              </td>
              <td><input type="checkbox" checked={s.enabled} onChange={async (e) => { await api(`/mcp-servers/${s.id}`, { method: 'PATCH', body: { enabled: e.target.checked } }); load(); }} /></td>
              <td className="actions">
                <button onClick={() => test(s.id)}>{t('Testen')}</button>
                <button className="ghost" onClick={async () => { if (confirm(t('Löschen?'))) { await api(`/mcp-servers/${s.id}`, { method: 'DELETE' }); load(); } }}>{t('Löschen')}</button>
              </td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={6} className="muted">{t('Noch keine MCP-Server.')}</td></tr>}
        </tbody>
      </table>

      <h3>{t('Server hinzufügen')}</h3>
      <form className="grid-form" onSubmit={add}>
        <label>{t('Name')}<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jira" /></label>
        <label>URL<input required type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://mcp.intern/mcp" /></label>
        <label>{t('Transport')}
          <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as Srv['transport'] })}>
            <option value="streamable-http">Streamable HTTP</option><option value="sse">{t('SSE (alt)')}</option>
          </select>
        </label>
        <label>{t('Header-Name')}<input value={form.headerName} onChange={(e) => setForm({ ...form, headerName: e.target.value })} /></label>
        <label>{t('Header-Wert')}<input type="password" value={form.headerValue} onChange={(e) => setForm({ ...form, headerValue: e.target.value })} placeholder="Bearer …" /></label>
        <div><button type="submit" className="primary">{t('Hinzufügen')}</button></div>
      </form>
      {error && <p className="error">{error}</p>}

      <KnowledgeMcp />
    </div>
  );
}

interface Tok { id: string; name: string; prefix: string; expiresAt: string | null; lastUsedAt: string | null; createdAt: string }

function KnowledgeMcp() {
  const [toks, setToks] = useState<Tok[]>([]);
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [fresh, setFresh] = useState<string | null>(null);
  const endpoint = `${location.origin}/mcp`;
  const load = () => api<Tok[]>('/tokens').then(setToks);
  useEffect(() => { load(); }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ token: string }>('/tokens', { body: { name, expiresInDays: Number(days) } });
    setFresh(r.token); setName(''); load();
  };

  const librechat = `mcpServers:
  ai-knowledge:
    type: streamable-http
    url: ${endpoint}
    headers:
      Authorization: "Bearer {{AI_PORTAL_TOKEN}}"
    customUserVars:
      AI_PORTAL_TOKEN:
        title: "${t('AI Portal Zugriffstoken')}"
        description: "${t('Im AI Portal unter MCP-Server → Zugriffstokens erstellen')}"`;
  const desktop = `{
  "mcpServers": {
    "ai-knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${endpoint}", "--header", "Authorization:Bearer \${TOKEN}"],
      "env": { "TOKEN": "${fresh ?? 'ap_…'}" }
    }
  }
}`;

  return (
    <>
      <h2 style={{ marginTop: 48 }}>{t('Wissensdatenbank in anderen Tools')}</h2>
      <p className="muted">{t('Die Wissensdatenbank ist selbst ein MCP-Server. Mit einem persönlichen Zugriffstoken nutzen LibreChat, Claude Desktop, VS Code oder andere MCP-Clients sie mit deinen Rechten.')}</p>
      <p>{t('Endpunkt (Streamable HTTP)')}: <code className="mono">{endpoint}</code> · Tools: <code>sammlungen_auflisten</code>, <code>wissensdatenbank_suchen</code>, <code>dokument_lesen</code></p>

      <h3>{t('Zugriffstokens')}</h3>
      {fresh && (
        <div className="card-box">
          <strong>{t('Neues Token – wird nur jetzt angezeigt:')}</strong>
          <div className="row" style={{ marginTop: 8 }}>
            <code className="mono" style={{ wordBreak: 'break-all', flex: 1 }}>{fresh}</code>
            <button onClick={() => navigator.clipboard.writeText(fresh)}>{t('Kopieren')}</button>
          </div>
        </div>
      )}
      <table>
        <thead><tr><th>{t('Name')}</th><th>{t('Token')}</th><th>{t('Läuft ab')}</th><th>{t('Zuletzt genutzt')}</th><th /></tr></thead>
        <tbody>
          {toks.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td><td className="mono small">{k.prefix}…</td>
              <td className="small">{k.expiresAt ? fmtDate(k.expiresAt) : '–'}</td>
              <td className="small">{k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : t('nie')}</td>
              <td className="actions"><button className="ghost" onClick={async () => { if (confirm(t('Token widerrufen?'))) { await api(`/tokens/${k.id}`, { method: 'DELETE' }); load(); } }}>{t('Widerrufen')}</button></td>
            </tr>
          ))}
          {toks.length === 0 && <tr><td colSpan={5} className="muted">{t('Noch keine Tokens.')}</td></tr>}
        </tbody>
      </table>
      <form className="grid-form" onSubmit={create}>
        <label>{t('Name')}<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="LibreChat" /></label>
        <label>{t('Gültigkeit')}<select value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="30">{t('30 Tage')}</option><option value="90">{t('90 Tage')}</option><option value="365">{t('1 Jahr')}</option>
        </select></label>
        <div><button type="submit" className="primary">{t('Token erstellen')}</button></div>
      </form>

      <h3>{t('Einrichtung')}</h3>
      <p className="muted small">LibreChat (<code>librechat.yaml</code>) – {t('jede Person trägt ihr eigenes Token in LibreChat ein:')}</p>
      <pre className="snippet">{librechat}</pre>
      <p className="muted small">Claude Desktop (<code>claude_desktop_config.json</code>) {t('über den Adapter')} <code>mcp-remote</code>:</p>
      <pre className="snippet">{desktop}</pre>
    </>
  );
}
