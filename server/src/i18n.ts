import type { Request, Response, NextFunction } from 'express';

/**
 * Server messages are written in German (source language). For English UIs they are translated
 * on the way out. Audit entries always keep the German original.
 */
export type Lang = 'de' | 'en';

/** x-ui-lang header (set by the web UI) > ap_lang cookie (for redirects) > Accept-Language. */
export function langOf(req: Request): Lang {
  const h = req.get('x-ui-lang') ?? req.cookies?.ap_lang;
  if (h === 'de' || h === 'en') return h;
  return (req.get('accept-language') ?? '').toLowerCase().startsWith('de') ? 'de' : 'en';
}

const EXACT: Record<string, string> = {
  'Anmeldevorgang abgelaufen': 'Sign-in expired, please try again',
  'Benutzer ist deaktiviert': 'User is deactivated',
  'Registrierung wartet auf Freigabe durch einen Admin': 'Registration is awaiting approval by an admin',
  'Benutzername oder Passwort falsch': 'Wrong username or password',
  'Keine Berechtigung für das AI Portal': 'You are not authorized to use the AI Portal',
  'LDAP-Anmeldung deaktiviert': 'LDAP sign-in is disabled',
  'Lokale Anmeldung deaktiviert': 'Local sign-in is disabled',
  'Passwort fehlt': 'Password missing',
  'Anmeldung fehlgeschlagen': 'Sign-in failed',
  'SSO-Anmeldung fehlgeschlagen': 'SSO sign-in failed',
  'Anbieter unbekannt': 'Unknown provider',
  'Mit einem Bedrock-API-Key ist nur der Modellaufruf möglich': 'A Bedrock API key can only call models',
  'Ungültige Bedrock-Optionen (auth: keys, apiKey oder iam; roleArn: arn:aws:iam::<Konto>:role/<Name>)':
    'Invalid Bedrock options (auth: keys, apiKey or iam; roleArn: arn:aws:iam::<account>:role/<name>)',
  'Anthropic bietet keine Embeddings an': 'Anthropic does not offer embeddings',
  'Anthropic bietet keine Embedding-Modelle an – bitte Bedrock, GitHub oder einen OpenAI-kompatiblen Endpunkt wählen':
    'Anthropic does not offer embedding models – please choose Bedrock, GitHub or an OpenAI-compatible endpoint',
  'Benutzername existiert bereits': 'Username already exists',
  'Eigene Admin-Rechte können nicht entzogen werden': 'You cannot remove your own admin rights',
  'Eigenes Konto kann nicht gelöscht werden': 'You cannot delete your own account',
  'Gültiges Zugriffstoken erforderlich': 'A valid access token is required',
  'Interner Fehler': 'Internal error',
  'Kein Text extrahierbar (Format nicht unterstützt oder gescannt)': 'No text could be extracted (unsupported format or scanned)',
  'Keine Datei': 'No file',
  'Modell nicht verfügbar': 'Model not available',
  'Passwort nur für lokale Benutzer': 'Passwords can only be set for local users',
  'Unbekannter Anhang': 'Unknown attachment',
  'Ungültige Eingabe': 'Invalid input',
  'Zuerst ein Embedding-Modell konfigurieren': 'Configure an embedding model first',
  'Embedding-Anbieter existiert nicht mehr': 'The embedding provider no longer exists',
  'Kein Embedding-Modell konfiguriert': 'No embedding model configured',
  'Nur http(s)-URLs sind erlaubt': 'Only http(s) URLs are allowed',
  'Private Netzadressen sind für MCP-Server nicht erlaubt': 'Private network addresses are not allowed for MCP servers',
  'siteUrl oder userPrincipalName erforderlich': 'siteUrl or userPrincipalName is required',
  'Dateityp wird nicht unterstützt – Inhalt wird dem Modell nicht übergeben': 'File type not supported – the content is not passed to the model',
  'abgebrochen': 'cancelled',
  // legacy audit reasons (before audit entries were written in English)
  'kein Token': 'no token',
  'unbekanntes Token': 'unknown token',
  'Token abgelaufen': 'token expired',
  'Benutzer deaktiviert': 'user deactivated',
};

const PATTERNS: [RegExp, string][] = [
  [/^Datei zu groß \(max\. (\d+) MB\)$/, 'File too large (max. $1 MB)'],
  [/^Text konnte nicht extrahiert werden: (.*)$/s, 'Text could not be extracted: $1'],
  [/^Benutzername (.+) ist bereits einer anderen Anmeldequelle zugeordnet$/, 'Username $1 already belongs to another sign-in source'],
  [/^(.*): Timeout nach (\d+)s$/, '$1: timeout after $2 s'],
  [/^Pfad liegt außerhalb von (.*)$/, 'Path is outside of $1'],
  [/^Space (.+) nicht gefunden oder kein Zugriff$/, 'Space $1 not found or no access'],
  [/^Bibliothek (.*) nicht gefunden \(vorhanden: (.*)\)$/, 'Library $1 not found (available: $2)'],
  [/^Extraktion fehlgeschlagen: (.*)$/s, 'Extraction failed: $1'],
  [/^Embedding fehlgeschlagen: (.*)$/s, 'Embedding failed: $1'],
];

export function tr(msg: string, lang: Lang): string {
  if (lang === 'de' || !msg) return msg;
  if (EXACT[msg]) return EXACT[msg];
  for (const [re, rep] of PATTERNS) if (re.test(msg)) return msg.replace(re, rep);
  return msg;
}

/** Translates `error` / `warning` fields of JSON responses for English clients. */
export function i18nMiddleware(req: Request, res: Response, next: NextFunction) {
  const lang = langOf(req);
  (req as Request & { lang: Lang }).lang = lang;
  if (lang === 'en') {
    const json = res.json.bind(res);
    const fix = (o: unknown) => {
      if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>;
        if (typeof r.error === 'string') r.error = tr(r.error, lang);
        if (typeof r.warning === 'string') r.warning = tr(r.warning, lang);
      }
    };
    res.json = (body: unknown) => {
      if (Array.isArray(body)) body.forEach(fix); else fix(body);
      return json(body);
    };
  }
  next();
}
