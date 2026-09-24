import { randomBytes } from 'node:crypto';

// Crockford base32: sortable, case-insensitive, no ambiguous letters.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number, length: number): string {
  let out = '';
  let rest = ms;
  for (let i = 0; i < length; i++) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

/** Opaque, time-sortable id such as `run_01J9Z3K8Q2W7M4X6T5R1V0B8N3`. */
export function newId(prefix: string, now: number = Date.now()): string {
  if (!/^[a-z][a-z0-9]{1,15}$/.test(prefix)) throw new Error(`prefijo de id inválido: ${prefix}`);
  return `${prefix}_${encodeTime(now, 10)}${encodeRandom(16)}`;
}

const ID_RE = /^([a-z][a-z0-9]{1,15})_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isId(value: string, prefix?: string): boolean {
  const m = ID_RE.exec(value);
  return m !== null && (prefix === undefined || m[1] === prefix);
}
