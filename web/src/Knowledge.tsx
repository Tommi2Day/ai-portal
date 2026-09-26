import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import { locale, t } from './i18n';

type SType = 'upload' | 'filesystem' | 'confluence' | 'sharepoint';
interface Source {
  id: string; type: SType; name: string; config: Record<string, unknown>; hasSecret: boolean; syncIntervalMinutes: number; enabled: boolean;
  lastSyncAt: string | null; lastStatus: string | null; lastError: string | null; lastStats: Record<string, number> | null;
}
interface Collection {
  id: string; name: string; description: string | null; public: boolean; allowedGroups: string[];
  documents: number; chunks: number; sources: Source[];
}
interface Doc { id: string; title: string; url: string | null; status: string; error: string | null; chunkCount: number; indexedAt: string }
interface Provider { id: string; name: string; type: string }
interface EmbCfg { settings: { providerId: string; modelId: string; dimensions?: number } | null; presets: Record<string, { modelId: string; label: string; dimensions?: number }[]> }

const TYPE_LABEL: Record<SType, string> = { upload: 'Upload', filesystem: 'Dateifreigabe', confluence: 'Confluence', sharepoint: 'SharePoint / OneDrive' };
/** German labels (translated via t) for status values coming from the server */
const RESULT_LABEL: Record<string, string> = { added: 'hinzugefügt', updated: 'aktualisiert', unchanged: 'unverändert', skipped: 'übersprungen', error: 'Fehler', indexed: 'indiziert' };
const splitList = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

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
      <h3>{t('Sammlungen')}</h3>
      <p className="muted">{t('Übernommen wird nur der Text der Dokumente, keine Originaldateien; Treffer verlinken auf die Quelle (Confluence, SharePoint, Dateifreigabe). Eine Sammlung bündelt Quellen und bestimmt, wer die Inhalte im Chat finden kann. Gruppen kommen aus LDAP/AD, aus dem SSO-Token oder werden lokalen Benutzern zugewiesen.')}</p>
      {cols.map((c) => <CollectionCard key={c.id} c={c} reload={load} />)}
      <NewCollection onDone={load} onError={setError} />
      {error && <p className="error">{error}</p>}
    </>
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

  const presets = cfg?.presets[provs.find((p) => p.id === f.providerId)?.type ?? ''] ?? [];
  return (
    <div className="card-box">
      <h4>{t('Embedding-Modell')}</h4>
      <p className="muted small">{t('Wandelt Texte in Vektoren für die semantische Suche. Für Daten, die das Haus nicht verlassen sollen: lokales Modell (z. B. BGE-M3 via Ollama) als OpenAI-kompatiblen Anbieter anlegen.')}</p>
      <form className="grid-form" onSubmit={save}>
        <label>{t('Anbieter')}<select required value={f.providerId} onChange={(e) => setF({ ...f, providerId: e.target.value })}>
          <option value="">{t('– wählen –')}</option>{provs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        {presets.length > 0 && (
          <label>{t('Vorlage')}<select value="" onChange={(e) => { const x = presets.find((p) => p.modelId === e.target.value); if (x) setF({ ...f, modelId: x.modelId, dimensions: x.dimensions ? String(x.dimensions) : '' }); }}>
            <option value="">{t('– Vorlage –')}</option>{presets.map((p) => <option key={p.modelId} value={p.modelId}>{p.label}</option>)}
          </select></label>
        )}
        <label>{t('Modell-ID')}<input required value={f.modelId} onChange={(e) => setF({ ...f, modelId: e.target.value })} /></label>
        <label>{t('Dimensionen (optional)')}<input type="number" value={f.dimensions} onChange={(e) => setF({ ...f, dimensions: e.target.value })} /></label>
        <div><button className="primary">{t('Speichern & testen')}</button></div>
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
      <div><button className="primary">{t('Anlegen')}</button></div>
    </form>
  );
}

function CollectionCard({ c, reload }: { c: Collection; reload: () => void }) {
  const [adding, setAdding] = useState(false);
  const [docsOf, setDocsOf] = useState<string | null>(null);
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
      {uploadMsg && <p className="small">{uploadMsg}</p>}
      {c.sources.length > 0 && (
        <table>
          <thead><tr><th>{t('Quelle')}</th><th>{t('Typ')}</th><th>{t('Intervall')}</th><th>{t('Letzter Lauf')}</th><th>{t('Ergebnis')}</th><th /></tr></thead>
          <tbody>
            {c.sources.map((s) => (
              <tr key={s.id}>
                <td>{s.name}<div className="muted small mono">{describe(s)}</div></td>
                <td>{t(TYPE_LABEL[s.type])}</td>
                <td className="small">{s.type === 'upload' ? '–' : s.syncIntervalMinutes ? `${s.syncIntervalMinutes} min` : t('manuell')}</td>
                <td className="small">
                  <span className={`status-${s.lastStatus}`}>{s.lastStatus === 'running' ? t('läuft …') : s.lastStatus === 'ok' ? '✓' : s.lastStatus === 'error' ? '✕' : ''}</span>{' '}
                  {s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString(locale()) : t('nie')}
                  {s.lastError && <div className="error">{s.lastError}</div>}
                </td>
                <td className="small">{s.lastStats ? `+${s.lastStats.added} ~${s.lastStats.updated} =${s.lastStats.unchanged} −${s.lastStats.removed}${s.lastStats.errors ? ` ✕${s.lastStats.errors}` : ''}` : ''}</td>
                <td className="actions">
                  <button onClick={async () => { await api(`/admin/knowledge/sources/${s.id}/sync`, { method: 'POST' }); setTimeout(reload, 500); }}>{s.type === 'upload' ? t('Neu indizieren') : t('Synchronisieren')}</button>
                  <button className="ghost" onClick={() => setDocsOf(docsOf === s.id ? null : s.id)}>{t('Dokumente')}</button>
                  <button className="ghost" onClick={async () => { if (confirm(t('Quelle samt Dokumenten löschen?'))) { await api(`/admin/knowledge/sources/${s.id}`, { method: 'DELETE' }); reload(); } }}>{t('Löschen')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {docsOf && <Documents sourceId={docsOf} onChange={reload} />}
      {adding && <NewSource collectionId={c.id} onDone={() => { setAdding(false); reload(); }} />}
    </div>
  );
}

function describe(s: Source) {
  const c = s.config as Record<string, string & string[]>;
  if (s.type === 'filesystem') return c.path;
  if (s.type === 'confluence') return `${c.baseUrl} · ${(c.spaceKeys ?? []).join(', ')}`;
  if (s.type === 'sharepoint') return c.siteUrl ?? c.userPrincipalName;
  return '';
}

function Documents({ sourceId, onChange }: { sourceId: string; onChange: () => void }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const load = () => api<Doc[]>(`/admin/knowledge/sources/${sourceId}/documents`).then(setDocs);
  useEffect(() => { load(); }, [sourceId]);
  return (
    <table className="small">
      <thead><tr><th>{t('Dokument')}</th><th>{t('Status')}</th><th>{t('Abschnitte')}</th><th>{t('Indiziert')}</th><th /></tr></thead>
      <tbody>
        {docs.map((d) => (
          <tr key={d.id} className={d.status === 'error' ? 'failed' : ''}>
            <td>
              <a href={d.url ?? `/api/knowledge/documents/${d.id}/open`} target="_blank" rel="noreferrer">{d.title}</a>
              {!d.url && <span className="muted"> · {t('nur Textfassung')}</span>}
            </td>
            <td>{t(RESULT_LABEL[d.status] ?? d.status)}{d.error && <div className="muted">{t(d.error)}</div>}</td>
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

function NewSource({ collectionId, onDone }: { collectionId: string; onDone: () => void }) {
  const [type, setType] = useState<Exclude<SType, 'upload'>>('filesystem');
  const [f, setF] = useState<Record<string, string>>({ interval: '60', deployment: 'cloud' });
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
      config = { baseUrl: f.baseUrl, deployment: f.deployment, spaceKeys: splitList(f.spaceKeys ?? '') };
      secret = f.deployment === 'cloud' ? { email: f.email, apiToken: f.apiToken } : { token: f.token };
    } else {
      config = { tenantId: f.tenantId, clientId: f.clientId, siteUrl: f.siteUrl || undefined, userPrincipalName: f.upn || undefined, driveName: f.driveName || undefined, folderPath: f.folderPath || undefined };
      secret = { clientSecret: f.clientSecret };
    }
    try {
      const { id } = await api<{ id: string }>('/admin/knowledge/sources', { body: { collectionId, type, name: f.name, config, secret, syncIntervalMinutes: Number(f.interval) } });
      await api(`/admin/knowledge/sources/${id}/sync`, { method: 'POST' });
      onDone();
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <form className="grid-form" onSubmit={submit} style={{ marginTop: 12 }}>
      <label>{t('Typ')}<select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
        <option value="filesystem">{t('Dateifreigabe (SMB/NFS-Mount)')}</option><option value="confluence">{t('Confluence')}</option><option value="sharepoint">{t('SharePoint / OneDrive')}</option>
      </select></label>
      {input('name', 'Name', { required: true, placeholder: 'IT-Handbuch' })}
      <label>{t('Intervall')}<select value={f.interval} onChange={set('interval')}>
        <option value="15">{t('alle 15 min')}</option><option value="60">{t('stündlich')}</option><option value="1440">{t('täglich')}</option><option value="0">{t('nur manuell')}</option>
      </select></label>
      {type === 'filesystem' && <>
        {input('path', 'Pfad unter dem Mount', { required: true, placeholder: 'it-handbuch' })}
        {input('urlPrefix', 'Link-Präfix (optional)', { placeholder: 'file://fileserver/it-handbuch/' })}
        {input('exclude', 'Ausschließen (kommagetrennt)', { placeholder: 'Archiv, Entwürfe' })}
      </>}
      {type === 'confluence' && <>
        <label>{t('Variante')}<select value={f.deployment} onChange={set('deployment')}><option value="cloud">{t('Cloud')}</option><option value="server">{t('Server / Data Center')}</option></select></label>
        {input('baseUrl', 'Basis-URL', { required: true, type: 'url', placeholder: f.deployment === 'cloud' ? 'https://firma.atlassian.net/wiki' : 'https://confluence.firma.local' })}
        {input('spaceKeys', 'Space-Keys (kommagetrennt)', { required: true, placeholder: 'IT, OPS' })}
        {f.deployment === 'cloud'
          ? <>{input('email', 'E-Mail (Service-Konto)', { required: true })}{input('apiToken', 'API-Token', { required: true, type: 'password' })}</>
          : input('token', 'Personal Access Token', { required: true, type: 'password' })}
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
      <div><button className="primary">{t('Anlegen & synchronisieren')}</button></div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
