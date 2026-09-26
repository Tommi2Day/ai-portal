import { LANGS, setLang, useLang } from './i18n';

export function LangSwitch() {
  const lang = useLang();
  return (
    <div className="lang" role="group" aria-label="Language">
      {LANGS.map((l) => (
        <button key={l.code} type="button" className={lang === l.code ? 'active' : ''} aria-pressed={lang === l.code} onClick={() => setLang(l.code)}>{l.label}</button>
      ))}
    </div>
  );
}
