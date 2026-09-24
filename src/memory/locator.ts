import type { GraphStore } from './graph-store.js';

/**
 * Entry-point locator (MEJORAS 5.9). Given a task's words, which files look
 * like where the work happens? A port with a local implementation: BM25 over
 * the identifiers, comments and path of each file, indexed at build time. It
 * needs no network, costs nothing and sends nothing anywhere.
 *
 * Embeddings would plug in behind the same `EntryPointFinder` port; they stay
 * unimplemented on purpose until provider, privacy (code leaves the machine)
 * and cost are decided (v2/08).
 */

export interface EntryPointFinder {
  find(query: string, limit: number): { path: string; score: number }[];
}

const STOP = new Set([
  'the',
  'and',
  'for',
  'que',
  'con',
  'los',
  'las',
  'del',
  'una',
  'para',
  'por',
  'const',
  'let',
  'var',
  'function',
  'return',
  'import',
  'export',
  'from',
  'async',
  'await',
  'new',
  'this',
  'true',
  'false',
  'null',
  'undefined',
  'type',
  'interface',
  'class',
  'public',
  'private',
  'static',
  'void',
  'string',
  'number',
  'boolean',
  'def',
  'self',
  'none',
  'func',
  'package',
  'use',
  'mod',
  'pub',
  'impl',
  'struct',
  'else',
  'while',
  'case',
  'break',
  'default',
]);

/** Words of code and text: identifiers split on camelCase/snake_case, accents folded, short and common words out. */
export function terms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && w.length <= 40 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** Term frequencies of one file (path words count double: names matter). */
export function fileTerms(path: string, text: string, max = 300): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of terms(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const t of terms(path.replace(/[/._-]/g, ' '))) tf.set(t, (tf.get(t) ?? 0) + 2);
  return new Map([...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, max));
}

export class LexicalFinder implements EntryPointFinder {
  constructor(private readonly graph: GraphStore) {}

  find(query: string, limit: number): { path: string; score: number }[] {
    const q = [...new Set(terms(query))];
    if (!q.length) return [];
    const db = this.graph.db;
    const n = (db.prepare('SELECT COUNT(DISTINCT path) AS n FROM terms').get() as { n: number }).n;
    if (n === 0) return [];
    const lengths = new Map((db.prepare('SELECT path, SUM(tf) AS len FROM terms GROUP BY path').all() as { path: string; len: number }[]).map((r) => [r.path, r.len]));
    const avg = [...lengths.values()].reduce((a, b) => a + b, 0) / Math.max(1, lengths.size);
    const k1 = 1.2;
    const b = 0.75;
    const scores = new Map<string, number>();
    for (const term of q) {
      const rows = db.prepare('SELECT path, tf FROM terms WHERE term = ?').all(term) as { path: string; tf: number }[];
      if (!rows.length) continue;
      const idf = Math.log(1 + (n - rows.length + 0.5) / (rows.length + 0.5));
      for (const r of rows) {
        const len = lengths.get(r.path) ?? avg;
        scores.set(r.path, (scores.get(r.path) ?? 0) + (idf * (r.tf * (k1 + 1))) / (r.tf + k1 * (1 - b + (b * len) / avg)));
      }
    }
    return [...scores.entries()]
      .map(([path, score]) => ({ path, score: Math.round(score * 100) / 100 }))
      .sort((x, y) => y.score - x.score || x.path.localeCompare(y.path))
      .slice(0, limit);
  }
}
