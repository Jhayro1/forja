import { createHash } from 'node:crypto';

export const CANONICALIZATION_VERSION = 'canon-v1';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Deterministic JSON: object keys sorted by code point, no whitespace,
 * arrays keep their order. Rejects values JSON cannot represent faithfully.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value as Json, '$');
}

function serialize(value: Json, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`número no representable en ${path}`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v, i) => serialize(v, `${path}[${i}]`)).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error(`objeto no plano en ${path}`);
      const keys = Object.keys(value).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const v = value[key];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${serialize(v, `${path}.${key}`)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`tipo no representable (${typeof value}) en ${path}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash with declared algorithm and canonicalization, e.g. `sha256:canon-v1:ab12…`. */
export function hashJson(value: unknown): string {
  return `sha256:${CANONICALIZATION_VERSION}:${sha256Hex(canonicalJson(value))}`;
}

/** Hash of exact bytes (files, artifacts). */
export function hashBytes(data: string | Uint8Array): string {
  return `sha256:${sha256Hex(data)}`;
}
