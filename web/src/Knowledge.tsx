import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './api';
import { locale, t } from './i18n';
import { availableLabel, useAvailable } from './availableModels';
import { CommentCell } from './CommentCell';

type SType = 'upload' | 'filesystem' | 'confluence' | 'sharepoint' | 'http';
interface Source {
  id: string; type: SType; name: string; comment: string | null; config: Record<string, unknown>; hasSecret: boolean; syncIntervalMinutes: number; enabled: boolean;
  replaceOnSync: boolean; hasTrigger: boolean; triggerTokenCreatedAt: string | null; hookUrl?: string | null;
  lastSyncAt: string | null; lastStatus: string | null; lastError: string | null; lastStats: Record<string, number> | null;
}
interface Collection {
  id: string; name: string; comment: string | null; description: string | null; public: boolean; allowedGroups: string[];
  documents: number; chunks: number; sources: Source[];
}
interface Doc { id: string; title: string; url: string | null; status: string; error: string | null; chunkCount: number; indexedAt: string; author: string | null; modifiedAt: string | null }
interface Provider { id: string; name: string; type: string }
interface EmbCfg { settings: { providerId: string; modelId: string; dimensions?: number } | null; presets: Record<string, { modelId: string; label: string; dimensions?: number }[]> }

const TYPE_LABEL: Record<SType, string> = { upload: 'Upload', filesystem: 'Dateifreigabe', confluence: 'Confluence', sharepoint: 'SharePoint / OneDrive', http: 'Webseiten (HTTP)' };
/** German labels (translated via t) for status values coming from the server */
const RESULT_LABEL: Record<string, string> = { added: 'hinzugefügt', updated: 'aktualisiert', unchanged: 'unverändert', skipped: 'übersprungen', error: 'Fehler', indexed: 'indiziert' };
const splitList = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
/** How a source is updated: automatically (interval), manually, or when an external system calls the webhook. */
const updateLabel = (s: Source) =>
  (s.syncIntervalMinutes > 0 ? `${s.syncIntervalMinutes} min` : s.hasTrigger ? t('extern ausgelöst') : t('manuell')) + (s.replaceOnSync ? ` · ${t('ersetzt vollständig')}` : '') + (s.enabled ? '' : ` · ${t('deaktiviert')}`);

export function Knowledge() {
  const [cols, setCols] = useState<Collection[]>([]);
  const [error, setError] = useState('');
  const load = () => api<Collection[]>('/admin/knowledge/collections').then(setCols);

  useEffect(() => { load(); }, []);
  // poll while a sync is running
  useEffect(() => {
    if (!cols.some((c) => c.sources.some((s) => s.lastStatus === 'running'))) return;
    const t = setTimeout(load, 2000);
    return () => clearTimeout(t);
  }, [cols]);

  return (
    <>
      <EmbeddingSettings onSaved={load} />
      <ArticleReview onApproved={load} />
      <h3>{t('Sammlungen')}</h3>
      <p className="muted">{t('Übernommen wird nur der Text der Dokumente, keine Originaldateien; Treffer verlinken auf die Quelle (Confluence, SharePoint, Dateifreigabe). Eine Sammlung bündelt Quellen und bestimmt, wer die Inhalte im Chat finden kann. Gruppen kommen aus LDAP/AD, aus dem SSO-Token oder werden lokalen Benutzern zugewiesen.')}</p>
      {cols.map((c) => <CollectionCard key={c.id} c={c} reload={load} />)}
      <NewCollection onDone={load} onError={setError} />
      {error && <p className="error">{error}</p>}
    </>
  );
}

interface ReviewArticle { id: string; title: string; body: string; author: string | null; collection: string; submittedAt: string }

function ArticleReview({ onApproved }: { onApproved: () => void }) {
  const [articles, setArticles] = useState<ReviewArticle[]>([]);
  const [error, setError] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const load = () => api<ReviewArticle[]>('/admin/knowledge/articles').then(setArticles).catch((e: Error) => setError(e.message));
  useEffect(() => { load(); }, []);

  const review = async (id: string, decision: 'approve' | 'reject') => {
    setError(''); setWorking(id);
    try {
      await api(`/admin/knowledge/articles/${id}/${decision}`, { method: 'POST' });
      await load();
      if (decision === 'approve') onApproved();
    } catch (e) { setError((e as Error).message); }
    finally { setWorking(null); }
  };

  return (
    <div className="card-box">
      <h4>{t('Artikel prüfen')} ({articles.length})</h4>
      {articles.map((a) => (
        <div key={a.id} className="review-article">
          <strong>{a.title}</strong> <span className="muted small">· {a.collection} · {a.author ?? '–'} · {new Date(a.submittedAt).toLocaleString(locale())}</span>
          <pre>{a.body}</pre>
          <div className="row">
            <button className="primary" disabled={working !== null} onClick={() => review(a.id, 'approve')}>{t('Freigeben')}</button>
            <button disabled={working !== null} onClick={() => review(a.id, 'reject')}>{t('Ablehnen')}</button>
          </div>
        </div>
      ))}
      {articles.length === 0 && <p className="muted">{t('Keine Artikel zur Prüfung.')}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function EmbeddingSettings({ onSaved }: { onSaved: () => void }) {
  const [cfg, setCfg] = useState<EmbCfg | null>(null);
  const [provs, setProvs] = useState<Provider[]>([]);
  const [f, setF] = useState({ providerId: '', modelId: '', dimensions: '' });
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api<EmbCfg>('/admin/knowledge/embedding').then((c) => {
      setCfg(c);
      if (c.settings) setF({ providerId: c.settings.providerId, modelId: c.settings.modelId, dimensions: c.settings.dimensions ? String(c.settings.dimensions) : '' });
    });
    api<Provider[]>('/admin/providers').then((p) => setProvs(p.filter((x) => x.type !== 'anthropic')));
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (cfg?.settings && (cfg.settings.modelId !== f.modelId || cfg.settings.providerId !== f.providerId)
      && !confirm(t('Ein neues Embedding-Modell erfordert eine Neuindizierung aller Quellen. Fortfahren?'))) return;
    setMsg(t('teste …'));
    const r = await api<{ ok: boolean; dim?: number; error?: string; reindexStarted?: boolean }>('/admin/knowledge/embedding', {
      method: 'PUT', body: { providerId: f.providerId, modelId: f.modelId, dimensions: f.dimensions ? Number(f.dimensions) : undefined },
    });
    setMsg(r.ok ? `✓ ${t('Modell erreichbar, {dim} Dimensionen', { dim: r.dim ?? '?' })}${r.reindexStarted ? ` – ${t('Neuindizierung gestartet')}` : ''}` : `✕ ${r.error}`);
    onSaved();
  };

  const isBedrock = provs.find((p) => p.id === f.providerId)?.type === 'bedrock';
  const { av } = useAvailable(isBedrock ? f.providerId : '');
  const fromAccount = av?.source === 'account' ? av.models.filter((m) => m.kind === 'embedding') : [];
  const presets = fromAccount.length
    ? fromAccount.map((m) => ({ modelId: m.modelId, label: availableLabel(m), dimensions: undefined as number | undefined, disabled: m.access === 'missing' }))
    : (cfg?.presets[provs.find((p) => p.id === f.providerId)?.type ?? ''] ?? []).map((p) => ({ ...p, disabled: false }));
  return (
    <div className="card-box">
      <h4>{t('Embedding-Modell')}</h4>
      <p className="muted small">{t('Wandelt Texte in Vektoren für die semantische Suche. Für Daten, die das Haus nicht verlassen sollen: lokales Modell (z. B. BGE-M3 via Ollama) als OpenAI-kompatiblen Anbieter anlegen.')}</p>
      <form className="grid-form" onSubmit={save}>
        <label>{t('Anbieter')}<select required value={f.providerId} onChange={(e) => setF({ ...f, providerId: e.target.value })}>
          <option value="">{t('– wählen –')}</option>{provs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        {presets.length > 0 && (
          <label>{fromAccount.length ? t('Verfügbare Modelle im AWS-Konto') : t('Vorlage')}<select value="" onChange={(e) => { const x = presets.find((p) => p.modelId === e.target.value); if (x) setF({ ...f, modelId: x.modelId, dimensions: x.dimensions ? String(x.dimensions) : '' }); }}>
            <option value="">{t('– Vorlage –')}</option>{presets.map((p) => <option key={p.modelId} value={p.modelId} disabled={p.disabled}>{p.label}</option>)}
          </select></label>
        )}
        <label>{t('Modell-ID')}<input required value={f.modelId} onChange={(e) => setF({ ...f, modelId: e.target.value })} /></label>
        <label>{t('Dimensionen (optional)')}<input type="number" value={f.dimensions} onChange={(e) => setF({ ...f, dimensions: e.target.value })} /></label>
        <div><button type="submit" className="primary">{t('Speichern & testen')}</button></div>
      </form>
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}

function NewCollection({ onDone, onError }: { onDone: () => void; onError: (e: string) => void }) {
  const [f, setF] = useState({ name: '', description: '', groups: '', public: false });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); onError('');
    try {
      await api('/admin/knowledge/collections', { body: { name: f.name, description: f.description || undefined, public: f.public, allowedGroups: splitList(f.groups) } });
      setF({ name: '', description: '', groups: '', public: false }); onDone();
    } catch (err) { onError((err as Error).message); }
  };
  return (
    <form className="grid-form card-box" onSubmit={submit}>
      <label>{t('Neue Sammlung')}<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t('IT-Betrieb')} /></label>
      <label>{t('Beschreibung (hilft dem Modell)')}<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={t('Handbücher, Störungen, Anleitungen')} /></label>
      <label>{t('Gruppen (kommagetrennt)')}<input value={f.groups} disabled={f.public} onChange={(e) => setF({ ...f, groups: e.target.value })} placeholder={t('IT-Team, AiPortal.Admin')} /></label>
      <label className="toggle"><input type="checkbox" checked={f.public} onChange={(e) => setF({ ...f, public: e.target.checked })} /> {t('für alle angemeldeten Benutzer')}</label>
      <div><button type="submit" className="primary">{t('Anlegen')}</button></div>
    </form>
  );
}

function CollectionCard({ c, reload }: { c: Collection; reload: () => void }) {
  const [adding, setAdding] = useState(false);
  const [docsOf, setDocsOf] = useState<string | null>(null);
  const [editOf, setEditOf] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    [...files].forEach((f) => fd.append('files', f));
    setUploadMsg(t('{n} Datei(en) werden indiziert …', { n: files.length }));
    try {
      const r = await api<{ filename: string; result: string }[]>(`/admin/knowledge/collections/${c.id}/upload`, { body: fd });
      setUploadMsg(r.map((x) => `${x.filename}: ${t(RESULT_LABEL[x.result] ?? x.result)}`).join(' · '));
    } catch (e) { setUploadMsg((e as Error).message); }
    if (fileRef.current) fileRef.current.value = '';
    reload();
  };

  const editAccess = async () => {
    const g = prompt(t('Gruppen (kommagetrennt), leer = nur Admins. „*“ = alle angemeldeten Benutzer'), c.public ? '*' : c.allowedGroups.join(', '));
    if (g === null) return;
    await api(`/admin/knowledge/collections/${c.id}`, { method: 'PATCH', body: g.trim() === '*' ? { public: true, allowedGroups: [] } : { public: false, allowedGroups: splitList(g) } });
    reload();
  };

  return (
    <div className="card-box">
      <div className="row">
        <h4 style={{ flex: 1 }}>{c.name} <span className="muted small">· {t('{n} Dokumente', { n: c.documents })} · {t('{n} Abschnitte', { n: c.chunks })}</span></h4>
        <button className="ghost" onClick={editAccess}>{t('Zugriff')}</button>
        <button onClick={() => fileRef.current?.click()}>{t('Dateien hochladen')}</button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        <button onClick={() => setAdding((a) => !a)}>{t('Quelle hinzufügen')}</button>
        <button className="ghost" onClick={async () => { if (confirm(`Sammlung „${c.name}“ mit allen Dokumenten löschen?`)) { await api(`/admin/knowledge/collections/${c.id}`, { method: 'DELETE' }); reload(); } }}>{t('Löschen')}</button>
      </div>
      <p className="muted small">{c.description} · {t('Zugriff')}: {c.public ? t('alle angemeldeten Benutzer') : c.allowedGroups.length ? c.allowedGroups.join(', ') : t('nur Admins')}</p>
      <div className="small">
        <span className="muted">{t('Kommentar')}: </span>
        <CommentCell value={c.comment} onSave={async (v) => { await api(`/admin/knowledge/collections/${c.id}`, { method: 'PATCH', body: { comment: v } }); reload(); }} />
      </div>
      {uploadMsg && <p className="small">{uploadMsg}</p>}
      {c.sources.length > 0 && (
        <table>
          <thead><tr><th>{t('Quelle')}</th><th>{t('Typ')}</th><th>{t('Aktualisierung')}</th><th>{t('Letzter Lauf')}</th><th>{t('Ergebnis')}</th><th>{t('Kommentar')}</th><th /></tr></thead>
          <tbody>
            {c.sources.map((s) => (
              <tr key={s.id} className={s.enabled ? undefined : 'disabled'}>
                <td>{s.name}<div className="muted small mono">{describe(s)}</div></td>
                <td>{t(TYPE_LABEL[s.type])}</td>
                <td className="small">{s.type === 'upload' ? '–' : updateLabel(s)}</td>
                <td className="small">
                  <span className={`status-${s.lastStatus}`}>{s.lastStatus === 'running' ? t('läuft …') : s.lastStatus === 'ok' ? '✓' : s.lastStatus === 'error' ? '✕' : ''}</span>{' '}
                  {s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString(locale()) : t('nie')}
                  {s.lastError && <div className="error">{s.lastError}</div>}
                </td>
                <td className="small">{s.lastStats ? `+${s.lastStats.added} ~${s.lastStats.updated} =${s.lastStats.unchanged} −${s.lastStats.removed}${s.lastStats.errors ? ` ✕${s.lastStats.errors}` : ''}` : ''}</td>
                <td><CommentCell value={s.comment} onSave={async (v) => { await api(`/admin/knowledge/sources/${s.id}`, { method: 'PATCH', body: { comment: v } }); reload(); }} /></td>
                <td className="actions">
                  <button onClick={async () => { await api(`/admin/knowledge/sources/${s.id}/sync`, { method: 'POST' }); setTimeout(reload, 500); }}>{s.type === 'upload' ? t('Neu indizieren') : t('Synchronisieren')}</button>
                  {s.type !== 'upload' && <button className="ghost" onClick={() => setEditOf(editOf === s.id ? null : s.id)}>{t('Einstellungen')}</button>}
                  <button className="ghost" onClick={() => setDocsOf(docsOf === s.id ? null : s.id)}>{t('Dokumente')}</button>
                  <button className="ghost" onClick={async () => { if (confirm(t('Quelle samt Dokumenten löschen?'))) { await api(`/admin/knowledge/sources/${s.id}`, { method: 'DELETE' }); reload(); } }}>{t('Löschen')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {docsOf && <Documents sourceId={docsOf} onChange={reload} />}
      {editOf && c.sources.some((x) => x.id === editOf) && <SourceSettings key={editOf} s={c.sources.find((x) => x.id === editOf)!} reload={reload} />}
      {adding && <NewSource collectionId={c.id} onDone={() => { setAdding(false); reload(); }} />}
    </div>
  );
}

function describe(s: Source) {
  const c = s.config as Record<string, string & string[]>;
  if (s.type === 'filesystem') return c.path;
  if (s.type === 'confluence') return `${c.baseUrl} · ${[...(c.spaceKeys ?? []), ...(c.rootPageIds ?? []).map((id: string) => `#${id}`)].join(', ')}`;
  if (s.type === 'http') return (c.startUrls ?? []).join(', ');
  if (s.type === 'sharepoint') return c.siteUrl ?? c.userPrincipalName;
  return '';
}

function Documents({ sourceId, onChange }: { sourceId: string; onChange: () => void }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const load = () => api<Doc[]>(`/admin/knowledge/sources/${sourceId}/documents`).then(setDocs);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when another source is opened
  useEffect(() => { load(); }, [sourceId]);
  return (
    <table className="small">
      <thead><tr><th>{t('Dokument')}</th><th>{t('Status')}</th><th>{t('Autor')}</th><th>{t('Zuletzt geändert')}</th><th>{t('Abschnitte')}</th><th>{t('Indiziert')}</th><th /></tr></thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id} className={d.status === 'error' ? 'failed' : ''}>
            <td>
              <a href={d.url ?? `/api/knowledge/documents/${d.id}/open`} target="_blank" rel="noreferrer">{d.title}</a>
              {!d.url && <span className="muted"> · {t('nur Textfassung')}</span>}
            </td>
            <td>{t(RESULT_LABEL[d.status] ?? d.status)}{d.error && <div className="muted">{t(d.error)}</div>}</td>
            <td>{d.author ?? '–'}</td>
            <td>{d.modifiedAt ? new Date(d.modifiedAt).toLocaleString(locale()) : '–'}</td>
            <td>{d.chunkCount}</td>
            <td>{new Date(d.indexedAt).toLocaleString(locale())}</td>
            <td className="actions"><button className="ghost" onClick={async () => { await api(`/admin/knowledge/documents/${d.id}`, { method: 'DELETE' }); load(); onChange(); }}>{t('Entfernen')}</button></td>
          </tr>
        ))}
        {docs.length === 0 && <tr><td colSpan={5} className="muted">Keine Dokumente.</td></tr>}
      </tbody>
    </table>
  );
}

/** Webhook of a source: URL, the token (shown once, masked until revealed) and a ready-made call. */
function TriggerInfo({ url, token, children }: { url: string; token?: string; children?: ReactNode }) {
  const [reveal, setReveal] = useState(false);
  const call = `curl -X POST -H "Authorization: Bearer ${token && reveal ? token : 'kt_…'}" ${url}`;
  return (
    <div>
      <p className="muted small">{t('Ein anderes System (CI-Job, Webhook, Cron) startet die Aktualisierung mit einem POST auf diese URL. Das Token gehört zu dieser Quelle und kann nichts anderes.')}</p>
      <p className="small">{t('Aufruf-URL')}: <code className="mono">POST {url}</code></p>
      {token && (
        <div className="card-box">
          <strong>{t('Neues Token – wird nur jetzt angezeigt:')}</strong>
          <div className="row" style={{ marginTop: 8 }}>
            <code className="mono" style={{ wordBreak: 'break-all', flex: 1 }}>{reveal ? token : `${token.slice(0, 7)}${'•'.repeat(24)}`}</code>
            <button type="button" className="ghost" onClick={() => setReveal(!reveal)}>{reveal ? t('Verbergen') : t('Anzeigen')}</button>
            <button type="button" onClick={() => navigator.clipboard.writeText(token)}>{t('Kopieren')}</button>
          </div>
        </div>
      )}
      <pre className="snippet">{call}</pre>
      <p className="muted small">{t('Optional {body} im Body erzwingt für diesen Aufruf das vollständige Ersetzen.', { body: '{"replace": true}' })}</p>
      {children}
    </div>
  );
}

/** Credentials of a source: write-only. The form replaces the stored set completely; nothing is ever shown. */
function SourceCredentials({ s, reload }: { s: Source; reload: () => void }) {
  const kind = s.type === 'http' ? 'http' : s.type === 'sharepoint' ? 'sharepoint' : (s.config as { deployment?: string }).deployment === 'cloud' ? 'cloud' : 'server';
  const blank = { email: '', apiToken: '', token: '', clientSecret: '', headerName: 'Authorization', headerValue: '' };
  const [v, setV] = useState(blank);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const input = (k: keyof typeof blank, label: string, props: Record<string, unknown> = {}) => (
    <label>{t(label)}<input required value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} autoComplete="off" {...props} /></label>
  );
  const secret = (): Record<string, string> => {
    if (kind === 'cloud') return { email: v.email, apiToken: v.apiToken };
    if (kind === 'server') return { token: v.token };
    if (kind === 'sharepoint') return { clientSecret: v.clientSecret };
    return { [v.headerName.trim() || 'Authorization']: v.headerValue };
  };
  const save = async (body: Record<string, string>, andSync = false) => {
    setError(''); setMsg('');
    try {
      await api(`/admin/knowledge/sources/${s.id}`, { method: 'PATCH', body: { secret: body } });
      if (andSync) await api(`/admin/knowledge/sources/${s.id}/sync`, { method: 'POST' });
      setV(blank); setMsg(t('Gespeichert. Die nächste Aktualisierung verwendet die neuen Zugangsdaten.'));
      reload();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div>
      <h5 style={{ margin: '16px 0 4px' }}>{t('Zugangsdaten')}</h5>
      <p className="muted small">
        {s.hasSecret ? t('Gespeichert (wird nicht angezeigt)') : t('Keine hinterlegt')} · {t('Zugangsdaten werden verschlüsselt gespeichert, nie angezeigt und ersetzen die bisherigen vollständig.')}
      </p>
      <form className="grid-form" onSubmit={(e) => { e.preventDefault(); void save(secret()); }}>
        {kind === 'cloud' && <>{input('email', 'E-Mail (Service-Konto)')}{input('apiToken', 'API-Token', { type: 'password', autoComplete: 'new-password' })}</>}
        {kind === 'server' && input('token', 'Personal Access Token', { type: 'password', autoComplete: 'new-password' })}
        {kind === 'sharepoint' && input('clientSecret', 'Client-Secret', { type: 'password', autoComplete: 'new-password' })}
        {kind === 'http' && <>{input('headerName', 'Header-Name')}{input('headerValue', 'Header-Wert', { type: 'password', autoComplete: 'new-password', placeholder: 'Bearer …' })}</>}
        <div className="actions" style={{ gridColumn: '1 / -1', justifyContent: 'flex-start' }}>
          <button type="submit" className="primary">{t('Zugangsdaten ersetzen')}</button>
          <button type="button" onClick={(e) => { if (e.currentTarget.form!.reportValidity()) void save(secret(), true); }}>{t('Ersetzen & synchronisieren')}</button>
          {kind === 'http' && s.hasSecret && (
            <button type="button" className="ghost" onClick={() => { if (confirm(t('Die hinterlegten Zugangsdaten werden entfernt. Fortfahren?'))) void save({}); }}>{t('Zugangsdaten entfernen')}</button>
          )}
        </div>
      </form>
      {msg && <p className="small">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Update settings of an existing source: automatic / manual / external, full replace, webhook token. */
function SourceSettings({ s, reload }: { s: Source; reload: () => void }) {
  const mode = s.syncIntervalMinutes > 0 ? 'auto' : s.hasTrigger ? 'external' : 'manual';
  const [interval, setIntervalValue] = useState(String(s.syncIntervalMinutes > 0 ? s.syncIntervalMinutes : 60));
  const [fresh, setFresh] = useState<{ token: string; url: string } | null>(null);
  const [error, setError] = useState('');
  const base = `/admin/knowledge/sources/${s.id}`;
  const url = s.hookUrl ?? `${location.origin}/api/hooks/knowledge/${s.id}/sync`; // the server knows the public address
  const guard = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); reload(); } catch (e) { setError((e as Error).message); } };

  const patch = (body: object) => guard(() => api(base, { method: 'PATCH', body }));
  const newToken = () => guard(async () => setFresh(await api<{ token: string; url: string }>(`${base}/trigger-token`, { method: 'POST', body: {} })));
  const revoke = () => guard(async () => { await api(`${base}/trigger-token`, { method: 'DELETE' }); setFresh(null); });
  const changeMode = (m: string) => guard(async () => {
    if (m === mode) return;
    if (m === 'auto') await api(base, { method: 'PATCH', body: { syncIntervalMinutes: Number(interval) } });
    else {
      await api(base, { method: 'PATCH', body: { syncIntervalMinutes: 0 } });
      if (m === 'manual' && s.hasTrigger) { await api(`${base}/trigger-token`, { method: 'DELETE' }); setFresh(null); }
      if (m === 'external' && !s.hasTrigger) setFresh(await api<{ token: string; url: string }>(`${base}/trigger-token`, { method: 'POST', body: {} }));
    }
  });
  const intervals = [...new Set([15, 60, 1440, s.syncIntervalMinutes].filter((n) => n > 0))].sort((a, b) => a - b);

  return (
    <div className="card-box">
      <h4>{t('Einstellungen von „{name}“', { name: s.name })}</h4>
      <label className="toggle"><input type="checkbox" checked={s.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} /> {t('Quelle aktiv')}</label>
      <p className="muted small">{t('Deaktivierte Quellen werden weder automatisch noch extern aktualisiert („Synchronisieren“ geht weiterhin); ihre Dokumente bleiben durchsuchbar.')}</p>
      <div className="grid-form">
        <label>{t('Aktualisierung')}
          <select value={mode} onChange={(e) => void changeMode(e.target.value)}>
            <option value="auto">{t('Automatisch (Intervall)')}</option><option value="manual">{t('Nur manuell')}</option><option value="external">{t('Extern ausgelöst (Webhook)')}</option>
          </select>
        </label>
        {mode === 'auto' && (
          <label>{t('Intervall')}
            <select value={interval} onChange={(e) => { setIntervalValue(e.target.value); void patch({ syncIntervalMinutes: Number(e.target.value) }); }}>
              {intervals.map((n) => <option key={n} value={n}>{n === 15 ? t('alle 15 min') : n === 60 ? t('stündlich') : n === 1440 ? t('täglich') : `${n} min`}</option>)}
            </select>
          </label>
        )}
        <label className="toggle">
          <input type="checkbox" checked={s.replaceOnSync} onChange={(e) => void patch({ replaceOnSync: e.target.checked })} /> {t('Gespeicherten Inhalt bei jeder Aktualisierung vollständig ersetzen')}
        </label>
      </div>
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <button
          type="button" title={t('Alle Dokumente neu einlesen und den gespeicherten Inhalt überschreiben')}
          onClick={async () => {
            if (!confirm(t('Alle Dokumente dieser Quelle werden neu eingelesen und überschreiben den gespeicherten Inhalt (auch Unterseiten, soweit eingestellt); nicht mehr vorhandene werden entfernt. Fortfahren?'))) return;
            await guard(() => api(`${base}/sync`, { method: 'POST', body: { replace: true } }));
            setTimeout(reload, 500);
          }}
        >{t('Vollständig ersetzen')}</button>
      </div>
      <p className="muted small">{s.replaceOnSync
        ? t('Jede Aktualisierung liest alle Dokumente (und Unterseiten, soweit eingestellt) neu ein und überschreibt den gespeicherten Inhalt; nicht mehr vorhandene werden entfernt. Liefert die Quelle gar nichts, bleibt der bisherige Inhalt erhalten.')
        : t('Jede Aktualisierung übernimmt nur neue und geänderte Dokumente und entfernt nicht mehr vorhandene.')}</p>
      {s.type !== 'filesystem' && s.type !== 'upload' && <SourceCredentials s={s} reload={reload} />}
      {(s.hasTrigger || fresh) && (
        <TriggerInfo url={fresh?.url ?? url} token={fresh?.token}>
          <div className="actions">
            <button type="button" onClick={() => { if (!s.hasTrigger || confirm(t('Das bisherige Token wird ungültig. Fortfahren?'))) void newToken(); }}>{t('Token neu erzeugen')}</button>
            <button type="button" className="ghost" onClick={() => void revoke()}>{t('Token widerrufen')}</button>
          </div>
        </TriggerInfo>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function NewSource({ collectionId, onDone }: { collectionId: string; onDone: () => void }) {
  const [type, setType] = useState<Exclude<SType, 'upload'>>('filesystem');
  const [created, setCreated] = useState<{ token: string; url: string } | null>(null);
  const [f, setF] = useState<Record<string, string>>({ interval: '60', replace: 'false', deployment: 'cloud', includeSubpages: 'true', maxDepth: '0', httpMaxDepth: '3', maxPages: '200' });
  const [error, setError] = useState('');
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const input = (k: string, label: string, props: Record<string, unknown> = {}) => (
    <label>{t(label)}<input value={f[k] ?? ''} onChange={set(k)} {...props} placeholder={typeof props.placeholder === 'string' ? t(props.placeholder) : undefined} /></label>
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    let config: Record<string, unknown>; let secret: Record<string, string> | undefined;
    if (type === 'filesystem') config = { path: f.path, urlPrefix: f.urlPrefix || undefined, exclude: splitList(f.exclude ?? '') };
    else if (type === 'confluence') {
      const rootPageIds = splitList(f.rootPageIds ?? '');
      config = {
        baseUrl: f.baseUrl, deployment: f.deployment, spaceKeys: splitList(f.spaceKeys ?? ''), rootPageIds: rootPageIds.length ? rootPageIds : undefined,
        includeSubpages: f.includeSubpages === 'true', maxDepth: Number(f.maxDepth) || 0,
      };
      secret = f.deployment === 'cloud' ? { email: f.email, apiToken: f.apiToken } : { token: f.token };
    } else if (type === 'http') {
      config = {
        startUrls: (f.startUrls ?? '').split('\n').map((x) => x.trim()).filter(Boolean), includeSubpages: f.includeSubpages === 'true',
        maxDepth: Number(f.httpMaxDepth) || 0, maxPages: Number(f.maxPages) || undefined, pathPrefix: f.pathPrefix || undefined, exclude: splitList(f.exclude ?? ''),
      };
      if (f.headerValue) secret = { [f.headerName || 'Authorization']: f.headerValue };
    } else {
      config = { tenantId: f.tenantId, clientId: f.clientId, siteUrl: f.siteUrl || undefined, userPrincipalName: f.upn || undefined, driveName: f.driveName || undefined, folderPath: f.folderPath || undefined };
      secret = { clientSecret: f.clientSecret };
    }
    try {
      const external = f.interval === 'external';
      const { id } = await api<{ id: string }>('/admin/knowledge/sources', {
        body: { collectionId, type, name: f.name, config, secret, syncIntervalMinutes: external ? 0 : Number(f.interval), replaceOnSync: f.replace === 'true' },
      });
      await api(`/admin/knowledge/sources/${id}/sync`, { method: 'POST' });
      if (external) setCreated(await api<{ token: string; url: string }>(`/admin/knowledge/sources/${id}/trigger-token`, { method: 'POST', body: {} }));
      else onDone();
    } catch (err) { setError((err as Error).message); }
  };

  if (created) {
    return (
      <div className="card-box">
        <TriggerInfo url={created.url} token={created.token} />
        <button type="button" className="primary" onClick={onDone}>{t('Fertig')}</button>
      </div>
    );
  }

  return (
    <form className="grid-form" onSubmit={submit} style={{ marginTop: 12 }}>
      <label>{t('Typ')}<select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
        <option value="filesystem">{t('Dateifreigabe (SMB/NFS-Mount)')}</option><option value="confluence">{t('Confluence')}</option><option value="sharepoint">{t('SharePoint / OneDrive')}</option><option value="http">{t('Webseiten (HTTP)')}</option>
      </select></label>
      {input('name', 'Name', { required: true, placeholder: 'IT-Handbuch' })}
      <label>{t('Aktualisierung')}<select value={f.interval} onChange={set('interval')}>
        <option value="15">{t('alle 15 min')}</option><option value="60">{t('stündlich')}</option><option value="1440">{t('täglich')}</option>
        <option value="0">{t('nur manuell')}</option><option value="external">{t('extern ausgelöst')}</option>
      </select></label>
      <label className="toggle"><input type="checkbox" checked={f.replace === 'true'} onChange={(e) => setF({ ...f, replace: String(e.target.checked) })} /> {t('Gespeicherten Inhalt bei jeder Aktualisierung vollständig ersetzen')}</label>
      {type === 'filesystem' && <>
        {input('path', 'Pfad unter dem Mount', { required: true, placeholder: 'it-handbuch' })}
        {input('urlPrefix', 'Link-Präfix (optional)', { placeholder: 'file://fileserver/it-handbuch/' })}
        {input('exclude', 'Ausschließen (kommagetrennt)', { placeholder: 'Archiv, Entwürfe' })}
      </>}
      {type === 'confluence' && <>
        <label>{t('Variante')}<select value={f.deployment} onChange={set('deployment')}><option value="cloud">{t('Cloud')}</option><option value="server">{t('Server / Data Center')}</option></select></label>
        {input('baseUrl', 'Basis-URL', { required: true, type: 'url', placeholder: f.deployment === 'cloud' ? 'https://firma.atlassian.net/wiki' : 'https://confluence.firma.local' })}
        {input('spaceKeys', 'Space-Keys (kommagetrennt)', { required: !f.rootPageIds, placeholder: 'IT, OPS' })}
        {input('rootPageIds', 'Seiten-IDs mit Unterseiten (optional)', { placeholder: '123456, 789012' })}
        <label className="toggle"><input type="checkbox" checked={f.includeSubpages === 'true'} onChange={(e) => setF({ ...f, includeSubpages: String(e.target.checked) })} /> {t('Unterseiten importieren')}</label>
        {input('maxDepth', 'Max. Tiefe der Seitenbäume (0 = unbegrenzt)', { type: 'number', min: 0 })}
        {f.deployment === 'cloud'
          ? <>{input('email', 'E-Mail (Service-Konto)', { required: true })}{input('apiToken', 'API-Token', { required: true, type: 'password' })}</>
          : input('token', 'Personal Access Token', { required: true, type: 'password' })}
      </>}
      {type === 'http' && <>
        <label>{t('Start-URLs (eine pro Zeile)')}<textarea required rows={3} value={f.startUrls ?? ''} onChange={set('startUrls')} placeholder="https://wiki.firma.local/it/" /></label>
        <label className="toggle"><input type="checkbox" checked={f.includeSubpages === 'true'} onChange={(e) => setF({ ...f, includeSubpages: String(e.target.checked) })} /> {t('Unterseiten (Links) folgen')}</label>
        {input('httpMaxDepth', 'Max. Linktiefe (0 = unbegrenzt)', { type: 'number', min: 0 })}
        {input('maxPages', 'Max. Seiten je Synchronisierung', { type: 'number', min: 1, max: 5000 })}
        {input('pathPrefix', 'Pfad-Präfix (optional)', { placeholder: '/it/' })}
        {input('exclude', 'Ausschließen (kommagetrennt)', { placeholder: '/login, ?print=1' })}
        {input('headerName', 'Header-Name (optional)', { placeholder: 'Authorization' })}
        {input('headerValue', 'Header-Wert (optional)', { type: 'password', placeholder: 'Bearer …' })}
      </>}
      {type === 'sharepoint' && <>
        {input('tenantId', 'Tenant-ID', { required: true })}
        {input('clientId', 'App (Client) ID', { required: true })}
        {input('clientSecret', 'Client-Secret', { required: true, type: 'password' })}
        {input('siteUrl', 'Site-URL', { placeholder: 'https://firma.sharepoint.com/sites/IT' })}
        {input('upn', 'oder OneDrive von (UPN)', { placeholder: 'max@firma.de' })}
        {input('driveName', 'Bibliothek (optional)', { placeholder: 'Dokumente' })}
        {input('folderPath', 'Unterordner (optional)', { placeholder: 'Handbücher/Betrieb' })}
      </>}
      <div><button type="submit" className="primary">{t('Anlegen & synchronisieren')}</button></div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
