import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { t } from './i18n';
import { LangSwitch } from './LangSwitch';
import { Brand } from './Brand';

interface AuthCfg { local: boolean; ldap: boolean; registration?: boolean; oidc: { name: string } | null }

export function Login({ onDone }: { onDone: () => void }) {
  const [cfg, setCfg] = useState<AuthCfg | null>(null);
  const [method, setMethod] = useState<'local' | 'ldap'>('local');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(new URLSearchParams(location.search).get('error') ?? '');
  const [busy, setBusy] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [reg, setReg] = useState({ displayName: '', email: '', username: '', password: '' });
  const [registered, setRegistered] = useState(false);

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

  const register = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api('/auth/register', { body: reg }); setRegistered(true); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (!cfg) return null;
  if (registering && cfg.registration) {
    return (
      <div className="login">
        <form className="card" onSubmit={register}>
          <div className="row"><h1 style={{ flex: 1 }}><Brand /></h1><LangSwitch /></div>
          <h2>{t('Registrieren')}</h2>
          {registered ? <p role="status">{t('Registrierung eingegangen. Ein Admin muss dein Konto freigeben, bevor du dich anmelden kannst.')}</p> : (
            <>
              <label>{t('Vollständiger Name')}<input required autoFocus autoComplete="name" maxLength={200} value={reg.displayName} onChange={(e) => setReg({ ...reg, displayName: e.target.value })} /></label>
              <label>{t('E-Mail')}<input required type="email" autoComplete="email" maxLength={200} value={reg.email} onChange={(e) => setReg({ ...reg, email: e.target.value })} /></label>
              <label>{t('Benutzername')}<input required autoComplete="username" minLength={2} maxLength={100} value={reg.username} onChange={(e) => setReg({ ...reg, username: e.target.value })} /></label>
              <label>{t('Passwort')}<input required type="password" autoComplete="new-password" minLength={12} maxLength={200} value={reg.password} onChange={(e) => setReg({ ...reg, password: e.target.value })} /></label>
              <p className="muted small">{t('Mindestens 12 Zeichen.')}</p>
              <button type="submit" className="primary" disabled={busy}>{t('Registrieren')}</button>
            </>
          )}
          <button type="button" className="ghost" onClick={() => { setRegistering(false); setRegistered(false); setError(''); }}>{t('Zurück zur Anmeldung')}</button>
          {error && <p className="error">{error}</p>}
        </form>
      </div>
    );
  }
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
        {cfg.registration && <button type="button" className="ghost" onClick={() => { setRegistering(true); setError(''); }}>{t('Neues Konto registrieren')}</button>}
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
