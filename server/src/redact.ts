/**
 * Central masking of secrets for everything that leaves the process as text: application logs, audit entries,
 * error texts stored in the database and shown in the UI, and the configuration shown to admins.
 *
 *  - keys: values of fields with secret-looking names are replaced entirely
 *  - strings: bearer/basic credentials, URL passwords, secret query parameters, JWTs and well-known token formats are masked
 *  - errors: only type, message, stack, code and status survive (request bodies, headers and response bodies of
 *    SDK/HTTP errors can contain prompts and credentials)
 */

export const REDACTED = '[REDACTED]';

const EXACT_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?token|session[-_]?token|x-api-key|header[-_]?value|bearer|credentials?|assertion)$/i;
const SUFFIX_KEY = /(password|passwd|secret|api[-_]?key|private[-_]?key|secret[-_]?access[-_]?key|secret[-_]?enc|headers[-_]?enc|oauth[-_]?enc)$/i;

export const isSensitiveKey = (k: string) => EXACT_KEY.test(k) || SUFFIX_KEY.test(k);

const SECRET_PARAMS = 'access_token|refresh_token|id_token|token|api[_-]?key|apikey|key|secret|client_secret|password|passwd|pwd|auth|authorization|signature|sig|code|assertion|x-amz-signature|x-amz-security-token|x-amz-credential';

/** Masks credentials inside free text (log messages, error messages, URLs). */
export function maskString(s: string): string {
  return s
    .replaceAll(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replaceAll(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1$2:***@')
    .replaceAll(new RegExp(`([?&;](?:${SECRET_PARAMS})=)[^&#\\s"']+`, 'gi'), '$1***')
    .replaceAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[jwt]')
    .replaceAll(/\bap_[A-Za-z0-9_-]{16,}/g, 'ap_***')
    .replaceAll(/\b(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, '***');
}

const MAX_DEPTH = 8;

function redactError(e: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const x = e as Error & { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
  return {
    type: e.name,
    message: maskString(e.message),
    ...(e.stack ? { stack: maskString(e.stack) } : {}),
    ...(typeof x.code === 'string' || typeof x.code === 'number' ? { code: x.code } : {}),
    ...(typeof (x.statusCode ?? x.status) === 'number' ? { statusCode: x.statusCode ?? x.status } : {}),
    ...(x.cause !== undefined ? { cause: redactDeep(x.cause, depth + 1, seen) } : {}),
  };
}

/** Deep copy with secrets masked; safe for cyclic structures. */
export function redactDeep(v: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof v === 'string') return maskString(v);
  if (v === null || typeof v !== 'object') return v;
  if (depth > MAX_DEPTH) return '[truncated]';
  if (v instanceof Date) return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return '[binary]';
  if (seen.has(v)) return '[circular]';
  seen.add(v);
  if (v instanceof Error) return redactError(v, depth, seen);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    // booleans (e.g. hasSecret) carry no secret; empty values show that nothing is set
    out[k] = isSensitiveKey(k) && val !== null && val !== undefined && val !== '' && typeof val !== 'boolean' ? REDACTED : redactDeep(val, depth + 1, seen);
  }
  return out;
}

/** Error text for users, audit entries and stored status fields. */
export const safeErrorText = (e: unknown) => maskString(e instanceof Error ? e.message : String(e));
