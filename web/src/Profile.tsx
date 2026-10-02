import { useState, type FormEvent } from 'react';
import { api, type Me } from './api';
import { t } from './i18n';
import { LangSwitch } from './LangSwitch';
import { Brand } from './Brand';

/** Shown once after the first LDAP/SSO login: name and email come from the directory, the user confirms or corrects them. */
export function Profile({ me, onDone, onLogout }: { me: Me; onDone: (me: Me) => void; onLogout: () => void }) {
  const [form, setForm] = useState({ displayName: me.displayName ?? '', email: me.email ?? '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try { onDone(await api<Me>('/auth/profile', { method: 'PUT', body: form })); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="row"><h1 style={{ flex: 1 }}><Brand /></h1><LangSwitch /></div>
        <h2>{t('Profil vervollständigen')}</h2>
        <p className="muted">{t('Bitte bestätige deinen Namen und deine E-Mail-Adresse.')}</p>
        <label>{t('Vollständiger Name')}<input required autoFocus maxLength={200} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
        <label>{t('E-Mail')}<input required type="email" maxLength={200} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <button type="submit" className="primary" disabled={busy}>{t('Weiter')}</button>
        <button type="button" className="ghost" onClick={onLogout}>{t('Abmelden')}</button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
