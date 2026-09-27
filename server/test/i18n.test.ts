import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { i18nMiddleware, langOf, tr } from '../src/i18n.js';
import { englishDetails } from '../src/audit.js';

const req = (headers: Record<string, string> = {}, cookies: Record<string, string> = {}) =>
  ({ cookies, get: (h: string) => headers[h.toLowerCase()] }) as unknown as Request;

describe('langOf', () => {
  it('prefers the x-ui-lang header, then the ap_lang cookie, then Accept-Language', () => {
    expect(langOf(req({ 'x-ui-lang': 'en', 'accept-language': 'de-DE' }, { ap_lang: 'de' }))).toBe('en');
    expect(langOf(req({ 'accept-language': 'en-US' }, { ap_lang: 'de' }))).toBe('de');
    expect(langOf(req({ 'accept-language': 'de-AT,de;q=0.9' }))).toBe('de');
    expect(langOf(req({ 'accept-language': 'fr-FR' }))).toBe('en');
    expect(langOf(req())).toBe('en');
  });

  it('ignores unknown values', () => {
    expect(langOf(req({ 'x-ui-lang': 'fr', 'accept-language': 'de' }))).toBe('de');
  });
});

describe('tr', () => {
  it('keeps German for German clients', () => {
    expect(tr('Modell nicht verfügbar', 'de')).toBe('Modell nicht verfügbar');
  });

  it('translates exact messages', () => {
    expect(tr('Modell nicht verfügbar', 'en')).toBe('Model not available');
    expect(tr('Private Netzadressen sind für MCP-Server nicht erlaubt', 'en')).toBe('Private network addresses are not allowed for MCP servers');
  });

  it('translates messages with parameters', () => {
    expect(tr('Datei zu groß (max. 20 MB)', 'en')).toBe('File too large (max. 20 MB)');
    expect(tr('MCP Jira: Timeout nach 60s', 'en')).toBe('MCP Jira: timeout after 60 s');
    expect(tr('Pfad liegt außerhalb von /data/shares', 'en')).toBe('Path is outside of /data/shares');
  });

  it('passes unknown messages (e.g. provider errors) through unchanged', () => {
    expect(tr('invalid x-api-key', 'en')).toBe('invalid x-api-key');
    expect(tr('', 'en')).toBe('');
  });
});

describe('i18nMiddleware', () => {
  const run = (headers: Record<string, string>, body: unknown) => {
    let sent: unknown;
    const res = { json: (b: unknown) => { sent = b; return res; } } as unknown as Response;
    i18nMiddleware(req(headers), res, () => {});
    res.json(body);
    return sent;
  };

  it('translates error and warning fields for English clients', () => {
    expect(run({ 'x-ui-lang': 'en' }, { error: 'Ungültige Eingabe', warning: 'Keine Datei', data: 'Ungültige Eingabe' }))
      .toEqual({ error: 'Invalid input', warning: 'No file', data: 'Ungültige Eingabe' });
    expect(run({ 'x-ui-lang': 'en' }, [{ error: 'Interner Fehler' }])).toEqual([{ error: 'Internal error' }]);
  });

  it('leaves German responses untouched', () => {
    expect(run({ 'x-ui-lang': 'de' }, { error: 'Ungültige Eingabe' })).toEqual({ error: 'Ungültige Eingabe' });
  });
});

describe('englishDetails (audit entries are always English)', () => {
  it('translates reason, error and warning, keeps the rest', () => {
    expect(englishDetails({ reason: 'Token abgelaufen', error: 'abgebrochen', model: 'claude-sonnet-5', chars: 12 }))
      .toEqual({ reason: 'token expired', error: 'cancelled', model: 'claude-sonnet-5', chars: 12 });
  });

  it('handles empty details', () => {
    expect(englishDetails(undefined)).toBeUndefined();
    expect(englishDetails(null)).toBeUndefined();
  });
});
