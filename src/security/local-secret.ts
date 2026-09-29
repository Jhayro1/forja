import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Small secrets Forja keeps outside the vault (an SMTP app password, a GitHub token):
 * AES-256-GCM with a random local key in `<home>/clave-local` (0600). They never go back
 * to the browser; the panel only sees whether one is saved.
 */
export class LocalSecretError extends Error {}

function localKey(home: string): Buffer {
  const path = join(home, 'clave-local');
  if (!existsSync(path)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new LocalSecretError(`${path} no es una clave válida`);
  return key;
}

export function encryptLocal(home: string, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', localKey(home), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decryptLocal(home: string, sealed: string): string {
  const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !data) throw new LocalSecretError('la clave guardada está dañada');
  const decipher = createDecipheriv('aes-256-gcm', localKey(home), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
