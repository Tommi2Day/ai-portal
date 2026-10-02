import { useEffect, useState, type FormEvent } from 'react';
import { api, type Me } from './api';
import { Knowledge } from './Knowledge';
import { availableLabel, useAvailable } from './availableModels';
import { locale, t } from './i18n';

type Tab = 'users' | 'providers' | 'knowledge' | 'audit' | 'plugins';

export function Admin({ me, onPluginsChanged }: { me: Me; onPluginsChanged?: () => void }) {
  const [tab, setTab] = useState<Tab>('providers');
  return (
    <div className="page">
      <div className="seg">
        <button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>{t('Anbieter & Modelle')}</button>
        <button className={tab === 'knowledge' ? 'active' : ''} onClick={() => setTab('knowledge')}>{t('Wissensdatenbank')}</button>
        <button className={tab === 'plugins' ? 'active' : ''} onClick={() => setTab('plugins')}>{t('Plugins')}</button>
        <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>{t('Benutzer')}</button>
        <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>{t('Audit-Log')}</button>
      </div>
      {tab === 'users' && <Users me={me} />}
      {tab === 'providers' && <Providers />}
      {tab === 'knowledge' && <Knowledge />}
      {tab === 'plugins' && <Plugins onChanged={onPluginsChanged} />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

interface Plugin { id: string; name: string; description: string; enabled: boolean; hasPage: boolean }

function Plugins({ onChanged }: { onChanged?: () => void }) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { api<Plugin[]>('/admin/plugins').then(setPlugins).catch((e: Error) => setError(e.message)); }, []);

  const toggle = async (plugin: Plugin) => {
    setError('');
    try {
      const updated = await api<{ enabled: boolean }>(`/admin/plugins/${plugin.id}`, { method: 'PATCH', body: { enabled: !plugin.enabled } });
      setPlugins((list) => list.map((p) => p.id === plugin.id ? { ...p, enabled: updated.enabled } : p));
      onChanged?.();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <>
      <h3>{t('Plugins')}</h3>
      <table>
        <thead><tr><th>{t('Name')}</th><th>{t('Beschreibung')}</th><th>{t('Aktiv')}</th></tr></thead>
        <tbody>{plugins.map((p) => (
          <tr key={p.id}><td>{t(p.name)}</td><td>{t(p.description)}</td>
            <td><input type="checkbox" checked={p.enabled} aria-label={`${t(p.name)}: ${t('Aktiv')}`} onChange={() => toggle(p)} /></td>
          </tr>
        ))}</tbody>
      </table>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/* ---------------- Users ---------------- */
interface U { id: string; username: string; displayName: string | null; email: string | null; authSource: string; role: 'admin' | 'user'; groups: string[]; active: boolean; pendingApproval?: boolean; lastLoginAt: string | null }

function Users({ me }: { me: Me }) {
  const [list, setList] = useState<U[]>([]);
  const [f, setF] = useState({ username: '', displayName: '', password: '', role: 'user' });
  const [error, setError] = useState('');
  const load = () => api<U[]>('/admin/users').then(setList);
  useEffect(() => { load(); }, []);

  const patch = async (id: string, body: object) => {
    try { await api(`/admin/users/${id}`, { method: 'PATCH', body }); load(); } catch (e) { alert((e as Error).message); }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try { await api('/admin/users', { body: f }); setF({ username: '', displayName: '', password: '', role: 'user' }); load(); }
    catch (err) { setError((err as Error).message); }
  };

  return (
    <>
      <p className="muted">{t('LDAP- und SSO-Benutzer werden bei der ersten Anmeldung automatisch angelegt.')}</p>
      <table>
        <thead><tr><th>{t('Benutzer')}</th><th>{t('Quelle')}</th><th>{t('Gruppen')}</th><th>{t('Rolle')}</th><th>{t('Aktiv')}</th><th>{t('Letzte Anmeldung')}</th><th /></tr></thead>
        <tbody>
          {list.map((u) => (
            <tr key={u.id}>
              <td>{u.username}<div className="muted small">{u.displayName} {u.email}</div>{u.pendingApproval && <div className="small"><strong>{t('Wartet auf Freigabe')}</strong></div>}</td>
              <td>{u.authSource}</td>
              <td className="small">
                {u.groups.join(', ') || '–'}
                {u.authSource === 'local' && <button className="ghost small" onClick={() => { const g = prompt(t('Gruppen (kommagetrennt)'), u.groups.join(', ')); if (g !== null) patch(u.id, { groups: g.split(',').map((x) => x.trim()).filter(Boolean) }); }}>{t('ändern')}</button>}
              </td>
              <td>
                <select value={u.role} disabled={u.id === me.id} onChange={(e) => patch(u.id, { role: e.target.value })}>
                  <option value="user">{t('Benutzer')}</option><option value="admin">{t('Admin')}</option>
                </select>
              </td>
              <td><input type="checkbox" checked={u.active} disabled={u.id === me.id} onChange={(e) => patch(u.id, { active: e.target.checked })} /></td>
              <td className="small">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString(locale()) : '–'}</td>
              <td className="actions">
                {u.authSource === 'local' && <button className="ghost" onClick={() => { const p = prompt(t('Neues Passwort (min. 12 Zeichen)')); if (p) patch(u.id, { password: p }); }}>{t('Passwort')}</button>}
                {u.id !== me.id && <button className="ghost" onClick={async () => { if (confirm(t('{name} löschen?', { name: u.username }))) { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); load(); } }}>{t('Löschen')}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>{t('Lokalen Benutzer anlegen')}</h3>
      <form className="grid-form" onSubmit={create}>
        <label>{t('Benutzername')}<input required value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></label>
        <label>{t('Anzeigename')}<input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></label>
        <label>{t('Passwort')}<input required type="password" minLength={12} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        <label>{t('Rolle')}<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="user">{t('Benutzer')}</option><option value="admin">{t('Admin')}</option></select></label>
        <div><button type="submit" className="primary">{t('Anlegen')}</button></div>
      </form>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/* ---------------- Providers & models ---------------- */
type PType = 'anthropic' | 'bedrock' | 'github' | 'openai_compatible';
interface P { id: string; name: string; type: PType; baseUrl: string | null; region: string | null; options: Record<string, string>; enabled: boolean; hasSecret: boolean }
interface M { id: string; providerId: string; modelId: string; displayName: string; description: string | null; supportsImages: boolean; enabled: boolean; isDefault: boolean; sort: number }

const TYPE_LABEL: Record<PType, string> = { anthropic: 'Anthropic Claude', bedrock: 'AWS Bedrock', github: 'GitHub Models / Enterprise', openai_compatible: 'OpenAI-kompatibel' };
type BAuth = 'iam' | 'keys' | 'apiKey';
const AUTH_LABEL: Record<BAuth, string> = { iam: 'IAM-Rolle (kurzlebige API-Keys)', keys: 'Zugangsschlüssel', apiKey: 'Bedrock-API-Key' };
const emptyP = {
  name: '', type: 'anthropic' as PType, baseUrl: '', region: 'eu-central-1', org: '', apiKey: '', accessKeyId: '', secretAccessKey: '',
  auth: 'iam' as BAuth, roleArn: '', externalId: '',
};
const bedrockOptions = (f: typeof emptyP) => ({
  auth: f.auth,
  ...(f.auth !== 'apiKey' && f.roleArn ? { roleArn: f.roleArn } : {}),
  ...(f.auth !== 'apiKey' && f.roleArn && f.externalId ? { externalId: f.externalId } : {}),
});
const providerSecret = (f: typeof emptyP) => {
  if (f.type !== 'bedrock') return f.apiKey ? { apiKey: f.apiKey } : undefined;
  if (f.auth === 'keys') return { accessKeyId: f.accessKeyId, secretAccessKey: f.secretAccessKey };
  if (f.auth === 'apiKey') return { apiKey: f.apiKey };
  return undefined;
};
const providerTarget = (p: P) =>
  p.type === 'bedrock'
    ? [p.region, p.options.roleArn && `→ ${p.options.roleArn}`, p.baseUrl].filter(Boolean).join(' ')
    : p.baseUrl ?? p.options.org ?? t('Standard');
/** Same rule as bedrockAuth() on the server: without the option, a provider without secret uses the IAM role. */
const usesIamRole = (p: P) => p.type === 'bedrock' && (p.options.auth ?? (p.hasSecret ? '' : 'iam')) === 'iam';
const providerKey = (p: P) => (usesIamRole(p) ? t('IAM-Rolle') : p.hasSecret ? '••••' : '–');


function Providers() {
  const [ps, setPs] = useState<P[]>([]);
  const [ms, setMs] = useState<M[]>([]);
  const [f, setF] = useState(emptyP);
  const [mf, setMf] = useState({ providerId: '', modelId: '', displayName: '', supportsImages: false });
  const [error, setError] = useState('');
  const { av, loading, reload } = useAvailable(mf.providerId);

  const load = () => Promise.all([api<P[]>('/admin/providers').then(setPs), api<M[]>('/admin/models').then(setMs)]);
  useEffect(() => { load(); }, []);

  const addProvider = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try {
      await api('/admin/providers', {
        body: {
          name: f.name, type: f.type, baseUrl: f.baseUrl || undefined,
          region: f.type === 'bedrock' ? f.region : undefined,
          options: f.type === 'github' && f.org ? { org: f.org } : f.type === 'bedrock' ? bedrockOptions(f) : {},
          secret: providerSecret(f),
        },
      });
      setF(emptyP); load();
    } catch (err) { setError((err as Error).message); }
  };

  const addModel = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try { await api('/admin/models', { body: mf }); setMf({ ...mf, modelId: '', displayName: '' }); load(); }
    catch (err) { setError((err as Error).message); }
  };

  const selProvider = ps.find((p) => p.id === mf.providerId);
  const patchModel = async (id: string, body: object) => { await api(`/admin/models/${id}`, { method: 'PATCH', body }); load(); };

  return (
    <>
      <h3>{t('KI-Anbieter')}</h3>
      <table>
        <thead><tr><th>{t('Name')}</th><th>{t('Typ')}</th><th>{t('Endpunkt / Region')}</th><th>{t('Schlüssel')}</th><th>{t('Aktiv')}</th><th /></tr></thead>
        <tbody>
          {ps.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td><td>{t(TYPE_LABEL[p.type])}</td>
              <td className="small mono">{providerTarget(p)}</td>
              <td>{providerKey(p)}</td>
              <td><input type="checkbox" checked={p.enabled} onChange={async (e) => { await api(`/admin/providers/${p.id}`, { method: 'PATCH', body: { enabled: e.target.checked } }); load(); }} /></td>
              <td className="actions">
                {!usesIamRole(p) && (
                  <button className="ghost" onClick={async () => { const k = prompt(t('Neuer API-Schlüssel')); if (k) { await api(`/admin/providers/${p.id}`, { method: 'PATCH', body: { secret: { apiKey: k }, ...(p.type === 'bedrock' ? { options: { ...p.options, auth: 'apiKey' } } : {}) } }); load(); } }}>{t('Schlüssel')}</button>
                )}
                <button className="ghost" onClick={async () => { if (confirm(t('Anbieter samt Modellen löschen?'))) { await api(`/admin/providers/${p.id}`, { method: 'DELETE' }); load(); } }}>{t('Löschen')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="grid-form" onSubmit={addProvider}>
        <label>{t('Name')}<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t('Claude (Produktion)')} /></label>
        <label>{t('Typ')}<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as PType })}>
          {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
        </select></label>
        {f.type === 'bedrock' ? (
          <>
            <label>{t('Region')}<input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} /></label>
            <label>{t('Anmeldung')}<select value={f.auth} onChange={(e) => setF({ ...f, auth: e.target.value as BAuth })}>
              {Object.entries(AUTH_LABEL).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
            </select></label>
            {f.auth === 'keys' && (
              <>
                <label>{t('Access Key ID')}<input required value={f.accessKeyId} onChange={(e) => setF({ ...f, accessKeyId: e.target.value })} /></label>
                <label>{t('Secret Access Key')}<input required type="password" value={f.secretAccessKey} onChange={(e) => setF({ ...f, secretAccessKey: e.target.value })} /></label>
              </>
            )}
            {f.auth === 'apiKey' && <label>{t('Bedrock-API-Key')}<input required type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>}
            {f.auth !== 'apiKey' && (
              <>
                <label>{t('Rolle übernehmen (optional)')}<input value={f.roleArn} onChange={(e) => setF({ ...f, roleArn: e.target.value })} placeholder="arn:aws:iam::123456789012:role/bedrock-invoke" /></label>
                {f.roleArn && <label>{t('External ID (optional)')}<input value={f.externalId} onChange={(e) => setF({ ...f, externalId: e.target.value })} /></label>}
              </>
            )}
            {f.auth === 'iam' && <p className="muted small">{t('Keine gespeicherten Schlüssel: Das Portal nutzt die AWS-Identität des Pods (EKS Pod Identity, IRSA, Instanzprofil) und erzeugt daraus kurzlebige Bedrock-API-Keys, die es selbst erneuert.')}</p>}
          </>
        ) : (
          <>
            {f.type === 'github' && <label>{t('Organisation (optional)')}<input value={f.org} onChange={(e) => setF({ ...f, org: e.target.value })} /></label>}
            <label>{f.type === 'github' ? t('Token (PAT, models:read)') : t('API-Schlüssel')}<input type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>
            <label>{t('Basis-URL')} {f.type === 'openai_compatible' ? '' : t('(optional)')}<input type="url" required={f.type === 'openai_compatible'} value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder={f.type === 'github' ? 'https://models.github.ai/inference' : ''} /></label>
          </>
        )}
        <div><button type="submit" className="primary">{t('Anbieter anlegen')}</button></div>
      </form>

      <h3>{t('Modellauswahl für Benutzer')}</h3>
      <table>
        <thead><tr><th>{t('Anzeigename')}</th><th>{t('Modell-ID')}</th><th>{t('Anbieter')}</th><th>{t('Bilder')}</th><th>{t('Standard')}</th><th>{t('Aktiv')}</th><th /></tr></thead>
        <tbody>
          {ms.map((m) => (
            <tr key={m.id}>
              <td>{m.displayName}</td><td className="mono small">{m.modelId}</td>
              <td>{ps.find((p) => p.id === m.providerId)?.name}</td>
              <td>{m.supportsImages ? '✓' : ''}</td>
              <td><input type="radio" checked={m.isDefault} onChange={() => patchModel(m.id, { isDefault: true })} /></td>
              <td><input type="checkbox" checked={m.enabled} onChange={(e) => patchModel(m.id, { enabled: e.target.checked })} /></td>
              <td className="actions"><button className="ghost" onClick={async () => { await api(`/admin/models/${m.id}`, { method: 'DELETE' }); load(); }}>{t('Löschen')}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="grid-form" onSubmit={addModel}>
        <label>{t('Anbieter')}<select required value={mf.providerId} onChange={(e) => setMf({ ...mf, providerId: e.target.value })}>
          <option value="">{t('– wählen –')}</option>{ps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        {selProvider && (
          <label>
            <span>{av?.source === 'account' ? t('Verfügbare Modelle im AWS-Konto') : t('Vorlage')}
              {selProvider.type === 'bedrock' && <button type="button" className="small ghost" onClick={reload} disabled={loading} title={t('Liste neu aus dem Konto laden')}>↻</button>}
            </span>
            <select value="" disabled={loading} onChange={(e) => { const x = av?.models.find((m) => m.modelId === e.target.value); if (x) setMf({ ...mf, modelId: x.modelId, displayName: x.displayName, supportsImages: x.supportsImages }); }}>
              <option value="">{loading ? t('lädt …') : t('– auswählen –')}</option>
              {(['profile', 'region', 'preset'] as const).map((via) => {
                const list = (av?.models ?? []).filter((m) => m.kind === 'chat' && m.via === via);
                if (!list.length) return null;
                const label = via === 'profile' ? t('Inferenzprofile (regionsübergreifend)') : via === 'region' ? t('Modelle in der Region') : t('Vorlagen');
                return (
                  <optgroup key={via} label={label}>
                    {list.map((m) => (
                      <option key={m.modelId} value={m.modelId} disabled={m.access === 'missing' || ms.some((x) => x.providerId === selProvider.id && x.modelId === m.modelId)}>
                        {availableLabel(m)}{ms.some((x) => x.providerId === selProvider.id && x.modelId === m.modelId) ? ` ${t('– bereits freigegeben')}` : ''}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            {av?.error && <span className="error small">{t('Abfrage im AWS-Konto fehlgeschlagen:')} {av.error}</span>}
          </label>
        )}
        <label>{t('Modell-ID')}<input required value={mf.modelId} onChange={(e) => setMf({ ...mf, modelId: e.target.value })} /></label>
        <label>{t('Anzeigename')}<input required value={mf.displayName} onChange={(e) => setMf({ ...mf, displayName: e.target.value })} /></label>
        <label className="toggle"><input type="checkbox" checked={mf.supportsImages} onChange={(e) => setMf({ ...mf, supportsImages: e.target.checked })} /> {t('versteht Bilder')}</label>
        <div><button type="submit" className="primary">{t('Modell freigeben')}</button></div>
      </form>
      {error && <p className="error">{error}</p>}
    </>
  );
}

/* ---------------- Audit ---------------- */
interface A { id: number; ts: string; username: string | null; action: string; targetType: string | null; targetId: string | null; success: boolean; ip: string | null; details: Record<string, unknown> | null }

function Audit() {
  const [rows, setRows] = useState<A[]>([]);
  const [q, setQ] = useState({ user: '', action: '', from: '', to: '' });
  const qs = () => new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  const load = () => api<A[]>(`/admin/audit?${qs()}`).then(setRows);
  useEffect(() => { load(); }, []);

  return (
    <>
      <form className="grid-form" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <label>{t('Benutzer')}<input value={q.user} onChange={(e) => setQ({ ...q, user: e.target.value })} /></label>
        <label>{t('Aktion')}<input value={q.action} onChange={(e) => setQ({ ...q, action: e.target.value })} placeholder={t('auth., chat., mcp.')} /></label>
        <label>{t('Von')}<input type="datetime-local" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></label>
        <label>{t('Bis')}<input type="datetime-local" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></label>
        <div className="actions"><button type="submit" className="primary">{t('Filtern')}</button><a className="button" href={`/api/admin/audit?${qs()}&format=csv`}>{t('CSV-Export')}</a></div>
      </form>
      <table className="audit">
        <thead><tr><th>{t('Zeit')}</th><th>{t('Benutzer')}</th><th>{t('Aktion')}</th><th>{t('Ziel')}</th><th>{t('IP')}</th><th>{t('Details')}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.success ? '' : 'failed'}>
              <td className="small">{new Date(r.ts).toLocaleString(locale())}</td>
              <td>{r.username ?? '–'}</td>
              <td className="mono small">{r.action}</td>
              <td className="small">{r.targetType}</td>
              <td className="small mono">{r.ip}</td>
              <td className="small mono details">{r.details ? JSON.stringify(r.details) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
