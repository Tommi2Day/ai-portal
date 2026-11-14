import { useRef, useState } from 'react';
import { t } from './i18n';

export const COMMENT_MAX = 300;

/**
 * Small admin note on an entry, edited in place: click the text (or "+ note"), type, Enter or leaving the field
 * saves, Escape cancels. An empty text removes the note. Saved through `onSave` (the entry's PATCH).
 */
export function CommentCell({ value, onSave, max = COMMENT_MAX }: { value: string | null | undefined; onSave: (text: string) => void | Promise<void>; max?: number }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const settled = useRef(false);

  const start = () => { settled.current = false; setText(value ?? ''); setEditing(true); };
  const finish = async (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const next = text.trim();
    if (save && next !== (value ?? '')) await onSave(next);
  };

  if (!editing) {
    return (
      <button type="button" className="ghost small comment" title={t('Kommentar bearbeiten')} onClick={start}>
        {value ? value : <span className="muted">{t('+ Notiz')}</span>}
      </button>
    );
  }
  return (
    <input
      autoFocus value={text} maxLength={max} placeholder={t('Kommentar')} aria-label={t('Kommentar')}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
      }}
    />
  );
}
