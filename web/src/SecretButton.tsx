import { useState, type FormEvent } from 'react';
import { t } from './i18n';

/**
 * Button that opens a masked input for a secret (password, API key). Replaces window.prompt(), which shows
 * what is typed in clear text. The value only lives in component state until it is submitted.
 */
export function SecretButton({ label, placeholder, className, minLength, onSubmit }: {
  label: string; placeholder: string; className?: string; minLength?: number; onSubmit: (value: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const close = () => { setValue(''); setOpen(false); };
  if (!open) return <button className={className} onClick={() => setOpen(true)}>{label}</button>;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value) return;
    const v = value;
    close();
    await onSubmit(v);
  };
  return (
    <form className="row" onSubmit={submit} style={{ gap: 6 }}>
      <input type="password" autoFocus autoComplete="new-password" minLength={minLength} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      <button type="submit" className="primary" disabled={!value || (minLength !== undefined && value.length < minLength)}>{t('OK')}</button>
      <button type="button" className="ghost" onClick={close}>{t('Abbrechen')}</button>
    </form>
  );
}
