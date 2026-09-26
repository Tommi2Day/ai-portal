import { useEffect, useReducer } from 'react';
import { EN } from './i18n.en';

export type Lang = 'de' | 'en';
export const LANGS: { code: Lang; label: string }[] = [{ code: 'de', label: 'DE' }, { code: 'en', label: 'EN' }];
const KEY = 'ai-portal-lang';

function detect(): Lang {
  try {
    const s = localStorage.getItem(KEY);
    if (s === 'de' || s === 'en') return s;
  } catch { /* storage unavailable */ }
  return navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

let current: Lang = detect();
document.documentElement.lang = current;
document.cookie = `ap_lang=${current}; path=/; max-age=31536000; SameSite=Lax`;
const listeners = new Set<() => void>();

export const getLang = () => current;
export const locale = () => (current === 'de' ? 'de-DE' : 'en-GB');

export function setLang(l: Lang) {
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  // cookie lets the server answer redirects (e.g. SSO errors) in the same language
  document.cookie = `ap_lang=${l}; path=/; max-age=31536000; SameSite=Lax`;
  document.documentElement.lang = l;
  listeners.forEach((f) => f());
}

/** Re-renders the calling component when the language changes. */
export function useLang(): Lang {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { listeners.add(force); return () => { listeners.delete(force); }; }, []);
  return current;
}

/**
 * The German source text is the key; English comes from EN (falls back to German).
 * Placeholders: t('Mit {name} anmelden', { name: 'Microsoft' })
 */
export function t(de: string, vars?: Record<string, string | number>): string {
  let s = current === 'en' ? EN[de] ?? de : de;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export const fmtDateTime = (d: string | Date) => new Date(d).toLocaleString(locale());
export const fmtDate = (d: string | Date) => new Date(d).toLocaleDateString(locale());
