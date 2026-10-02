import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { t } from '../i18n';

export function TextStats() {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ words: number; characters: number } | null>(null);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    try { setResult(await api('/plugins/text-stats/count', { body: { text } })); }
    catch (e) { setError((e as Error).message); setResult(null); }
  };

  return (
    <div className="page">
      <h2>{t('Text-Statistik')}</h2>
      <form className="card-box article-form" onSubmit={submit}>
        <label>{t('Text')}<textarea required maxLength={10000} rows={8} value={text} onChange={(e) => setText(e.target.value)} /></label>
        <button className="primary" type="submit">{t('Zählen')}</button>
      </form>
      {result && <p role="status">{t('Wörter')}: {result.words} · {t('Zeichen')}: {result.characters}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
