import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { t } from './i18n';
import { LangSwitch } from './LangSwitch';
import { Brand } from './Brand';

interface AuthCfg { local: boolean; ldap: boolean; oidc: { name: string } | null }

export function Login({ onDone }: { onDone: () => void }) {
  const [cfg, setCfg] = useState<AuthCfg | null>(null);
  const [method, setMethod] = useState<'local' | 'ldap'>('local');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(new URLSearchParams(location.search).get('error') ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AuthCfg>('/auth/config').then((c) => { setCfg(c); setMethod(c.ldap ? 'ldap' : 'local'); });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/auth/login', { body: { username, password, method } });
      history.replaceState(null, '', '/');
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (!cfg) return null;
  const pw = cfg.local || cfg.ldap;
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="row"><h1 style={{ flex: 1 }}><Brand /></h1><LangSwitch /></div>
        {pw && (
          <>
            {cfg.local && cfg.ldap && (
              <div className="seg">
                <button type="button" className={method === 'ldap' ? 'active' : ''} onClick={() => setMethod('ldap')}>{t('Firmenkonto (LDAP)')}</button>
                <button type="button" className={method === 'local' ? 'active' : ''} onClick={() => setMethod('local')}>{t('Lokal')}</button>
              </div>
            )}
            <label>{t('Benutzername')}<input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
            <label>{t('Passwort')}<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <button type="submit" className="primary" disabled={busy || !username || !password}>{t('Anmelden')}</button>
          </>
        )}
        {cfg.oidc && (
          <>
            {pw && <div className="divider">{t('oder')}</div>}
            <a className="button" href="/api/auth/oidc/start">{t('Mit {name} anmelden', { name: cfg.oidc.name })}</a>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
