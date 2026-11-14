import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { isSensitiveKey, maskString, redactDeep, safeErrorText, REDACTED } from '../src/redact.js';
import { createLogger } from '../src/logger.js';

const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';

describe('maskString', () => {
  it('masks bearer/basic credentials, URL passwords, secret query parameters, JWTs and token formats', () => {
    expect(maskString('Authorization: Bearer abcdef0123456789')).toBe('Authorization: Bearer ***');
    expect(maskString('Basic dXNlcjpwYXNzd29yZA==')).toBe('Basic ***');
    expect(maskString('GET https://user:hunter2@wiki.example/p?x=1')).toBe('GET https://user:***@wiki.example/p?x=1');
    expect(maskString('https://h.example/a?api_key=SECRET&page=2&token=T0K3N#frag')).toBe('https://h.example/a?api_key=***&page=2&token=***#frag');
    expect(maskString('https://h.example/cb?code=abc&state=xyz')).toBe('https://h.example/cb?code=***&state=xyz');
    expect(maskString(`token ${jwt} rejected`)).toBe('token [jwt] rejected');
    expect(maskString('personal token ap_0123456789abcdefABCDEF used')).toBe('personal token ap_*** used');
    expect(maskString('key sk-ant-api03-abcdefghijklmnop1234 and AKIAABCDEFGHIJKLMNOP')).toBe('key *** and ***');
  });

  it('leaves harmless text and URLs alone', () => {
    expect(maskString('https://wiki.example/docs/a.html?page=2&lang=de')).toBe('https://wiki.example/docs/a.html?page=2&lang=de');
    expect(maskString('HTTP 401 login required')).toBe('HTTP 401 login required');
  });
});

describe('redactDeep', () => {
  it('replaces values of secret-looking keys at any depth, keeps token counts and ids', () => {
    const out = redactDeep({
      name: 'srv', clientSecret: 's3cr3t', password: 'pw', apiKey: 'k', secretAccessKey: 'x', Authorization: 'Bearer abcdefgh12345',
      headers: { 'X-Api-Key': 'k', accept: 'json', cookie: 'sid=1' }, nested: { list: [{ token: 'ey', accessToken: 'a' }] },
      inputTokens: 12, tokens: 3, accessKeyId: 'AKIA-id', empty: { password: '' }, none: { password: null },
    }) as Record<string, any>;
    expect(out).toMatchObject({
      name: 'srv', clientSecret: REDACTED, password: REDACTED, apiKey: REDACTED, secretAccessKey: REDACTED, Authorization: REDACTED,
      headers: { 'X-Api-Key': REDACTED, accept: 'json', cookie: REDACTED }, nested: { list: [{ token: REDACTED, accessToken: REDACTED }] },
      inputTokens: 12, tokens: 3, accessKeyId: 'AKIA-id', empty: { password: '' }, none: { password: null },
    });
  });

  it('masks inside strings, copes with cycles, depth, dates and binary data', () => {
    const a: Record<string, unknown> = { url: 'https://x.example/?token=abc', when: new Date(0), buf: Buffer.from('secret') };
    a.self = a;
    const out = redactDeep(a) as Record<string, unknown>;
    expect(out.url).toBe('https://x.example/?token=***');
    expect(out.self).toBe('[circular]');
    expect(out.buf).toBe('[binary]');
    expect(out.when).toEqual(new Date(0));
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 20; i++) { deep.n = {}; deep = deep.n as Record<string, unknown>; }
    expect(JSON.stringify(redactDeep(root))).toContain('[truncated]');
  });

  it('reduces errors to type, message, stack, code and status (no request bodies, headers, response bodies)', () => {
    const err = Object.assign(new Error('POST https://api.example/v1?api_key=KEY123 failed: Bearer abcdefgh12345'), {
      statusCode: 401, code: 'E_AUTH', requestBodyValues: { prompt: 'internal question' }, responseHeaders: { 'set-cookie': 'sid=1' },
      responseBody: 'echo: secret', cause: new Error('inner https://u:pw@h.example/'),
    });
    const out = redactDeep({ err }) as { err: Record<string, unknown> };
    const s = JSON.stringify(out);
    expect(out.err).toMatchObject({ type: 'Error', statusCode: 401, code: 'E_AUTH' });
    expect(s).not.toContain('KEY123');
    expect(s).not.toContain('abcdefgh12345');
    expect(s).not.toContain('internal question');
    expect(s).not.toContain('sid=1');
    expect(s).not.toContain('echo: secret');
    expect(s).not.toContain(':pw@');
    expect(safeErrorText(err)).not.toContain('KEY123');
    expect(safeErrorText('plain Bearer abcdefgh12345')).toBe('plain Bearer ***');
  });

  it('isSensitiveKey', () => {
    for (const k of ['password', 'newPassword', 'client_secret', 'clientSecret', 'apiKey', 'api_key', 'Authorization', 'cookie', 'token', 'secretEnc', 'headersEnc', 'oauthEnc', 'privateKey']) expect(isSensitiveKey(k), k).toBe(true);
    for (const k of ['username', 'tokens', 'inputTokens', 'tokenUrl', 'secretary', 'keyboard', 'accessKeyId']) expect(isSensitiveKey(k), k).toBe(false);
    expect(redactDeep({ hasSecret: true, hasPassword: false })).toEqual({ hasSecret: true, hasPassword: false });
  });
});

describe('logger', () => {
  it('writes masked JSON: message, fields, nested errors and audit-like entries', () => {
    const lines: string[] = [];
    const log = createLogger(new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } }), 'info');
    log.warn({ err: new Error('fetch https://h.example/?token=T0K3N failed'), headers: { authorization: 'Bearer abcdefgh12345' }, cfg: { clientSecret: 's3', url: 'https://u:pw@h.example/' } }, 'call with Bearer abcdefgh12345 failed');
    log.info({ audit: true, details: { url: 'https://h.example/x?api_key=AK' } }, 'audit mcp.create');
    const out = lines.join('');
    for (const leaked of ['T0K3N', 'abcdefgh12345', 's3"', ':pw@', 'api_key=AK']) expect(out, leaked).not.toContain(leaked);
    expect(out).toContain('token=***');
    expect(out).toContain('[REDACTED]');
    const first = JSON.parse(lines[0]);
    expect(first.err.message).toContain('failed');
    expect(first.msg).toBe('call with Bearer *** failed');
    expect(first.service).toBe('ai-portal');
  });
});
