import { describe, expect, it } from 'vitest';
import { decrypt, decryptJson, encrypt, encryptJson } from '../src/crypto.js';

describe('encrypt / decrypt (AES-256-GCM)', () => {
  it('round-trips text including Unicode', () => {
    const plain = 'sk-ant-api03 · Schlüssel ✓';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it('uses the v1 format with a random IV per call', () => {
    const a = encrypt('same');
    const b = encrypt('same');
    expect(a).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(a).not.toBe(b);
  });

  it('never contains the plain text', () => {
    expect(encrypt('super-secret-key')).not.toContain('super-secret-key');
  });

  it('rejects tampered ciphertext', () => {
    const [v, iv, tag, ct] = encrypt('secret').split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  it('rejects unknown versions', () => {
    expect(() => decrypt(encrypt('x').replace(/^v1:/, 'v2:'))).toThrow(/unknown ciphertext version/);
  });
});

describe('encryptJson / decryptJson', () => {
  it('round-trips objects', () => {
    const secret = { accessKeyId: 'AKIA', secretAccessKey: 's3cr3t' };
    expect(decryptJson(encryptJson(secret), {})).toEqual(secret);
  });

  it('returns the fallback for empty values', () => {
    expect(decryptJson(null, { none: true })).toEqual({ none: true });
    expect(decryptJson(undefined, [])).toEqual([]);
    expect(decryptJson('', 'x')).toBe('x');
  });
});
