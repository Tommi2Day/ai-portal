import { beforeEach, describe, expect, it } from 'vitest';
import { EN } from '../src/i18n.en';
import { getLang, locale, setLang, t } from '../src/i18n';

beforeEach(() => setLang('de'));

describe('t', () => {
  it('returns the German source text for German', () => {
    expect(t('Anmelden')).toBe('Anmelden');
  });

  it('translates to English and falls back to German for missing keys', () => {
    setLang('en');
    expect(t('Mit {name} anmelden', { name: 'Microsoft' })).toBe('Sign in with Microsoft');
    expect(t('Nicht übersetzter Text')).toBe('Nicht übersetzter Text');
  });

  it('replaces all placeholders, also numbers', () => {
    expect(t('{n} Treffer', { n: 3 })).toBe('3 Treffer');
    expect(t('{a} und {a}', { a: 'x' })).toBe('x und x');
  });
});

describe('setLang', () => {
  it('persists the language and updates html lang, cookie and locale', () => {
    setLang('en');
    expect(getLang()).toBe('en');
    expect(localStorage.getItem('ai-portal-lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.cookie).toContain('ap_lang=en');
    expect(locale()).toBe('en-GB');
    setLang('de');
    expect(locale()).toBe('de-DE');
  });
});

describe('EN dictionary', () => {
  it('keeps the placeholders of the German key', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [de, en] of Object.entries(EN)) expect(vars(en), de).toEqual(vars(de));
  });

  it('has no empty translations', () => {
    for (const [de, en] of Object.entries(EN)) expect(en.trim(), de).not.toBe('');
  });
});
