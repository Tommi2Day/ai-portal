import crypto from 'node:crypto';
import { config } from './config.js';

const key = Buffer.from(config.ENCRYPTION_KEY, 'base64');

/** AES-256-GCM. Output: v1:<iv>:<tag>:<ciphertext> (base64). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(enc: string): string {
  const [v, iv, tag, ct] = enc.split(':');
  if (v !== 'v1') throw new Error('unknown ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export const encryptJson = (o: unknown) => encrypt(JSON.stringify(o));
export const decryptJson = <T>(s: string | null | undefined, fallback: T): T => (s ? (JSON.parse(decrypt(s)) as T) : fallback);
