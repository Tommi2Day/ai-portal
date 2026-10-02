import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from './api';
import { fmtDateTime, t } from './i18n';

interface Collection { id: string; name: string }
interface Article {
  id: string; title: string; collection: string; status: 'pending' | 'reviewing' | 'approved' | 'rejected';
  submittedAt: string; documentId: string | null;
}

export function Articles() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [articles, setArticles] = useState<Article[]>([]);
  const [form, setForm] = useState({ collectionId: '', title: '', body: '' });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => api<Article[]>('/knowledge/articles').then(setArticles).catch((e: Error) => setError(e.message));
  useEffect(() => {
    api<{ enabled: boolean; collections: Collection[] }>('/knowledge/collections')
      .then((r) => { setEnabled(r.enabled); setCollections(r.collections); return load(); })
      .catch((e: Error) => { if (!(e instanceof ApiError && e.status === 404)) setError(e.message); });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setMessage(''); setSaving(true);
    try {
      await api('/knowledge/articles', { body: form });
      setForm({ collectionId: form.collectionId, title: '', body: '' });
      setMessage(t('Artikel zur Prüfung eingereicht'));
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="page">
      <h2>{t('Artikel beitragen')}</h2>
      <p className="muted">{t('Schreibe einen Artikel für eine Sammlung, auf die du Zugriff hast. Ein Admin prüft ihn vor der Veröffentlichung.')}</p>
      {!enabled && <p className="muted">{t('Die Wissensdatenbank ist noch nicht eingerichtet.')}</p>}
      {enabled && collections.length === 0 && <p className="muted">{t('Keine zugänglichen Sammlungen vorhanden.')}</p>}
      {enabled && collections.length > 0 && (
        <form className="card-box article-form" onSubmit={submit}>
          <label>{t('Sammlung')}
            <select required value={form.collectionId} onChange={(e) => setForm({ ...form, collectionId: e.target.value })}>
              <option value="">{t('– wählen –')}</option>
              {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>{t('Titel')}<input required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label>{t('Inhalt (Markdown)')}
            <textarea required maxLength={100000} rows={14} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </label>
          <button className="primary" type="submit" disabled={saving}>{t('Zur Prüfung einreichen')}</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      {message && <p role="status">{message}</p>}
      <h3>{t('Meine Artikel')}</h3>
      <table>
        <thead><tr><th>{t('Titel')}</th><th>{t('Sammlung')}</th><th>{t('Status')}</th><th>{t('Eingereicht')}</th></tr></thead>
        <tbody>{articles.map((a) => (
          <tr key={a.id}>
            <td>{a.documentId ? <a href={`/api/knowledge/documents/${a.documentId}/open`} target="_blank" rel="noreferrer">{a.title}</a> : a.title}</td>
            <td>{a.collection}</td><td>{t(a.status === 'approved' ? 'Freigegeben' : a.status === 'rejected' ? 'Abgelehnt' : 'In Prüfung')}</td>
            <td>{fmtDateTime(a.submittedAt)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
