import { basename, dirname, posix } from 'node:path';
import { blankCLike, lineOf } from './clike.js';
import { type Extraction, type LanguageExtractor, mentionsIn, type Resolution, type SymbolRef } from './types.js';

/**
 * Rust extractor (MEJORAS 5.6). `mod x;` declares a file module (resolved like
 * rustc: x.rs or x/mod.rs next to the parent module); `use crate::a::b` maps to
 * the module file, «posible» when the last segment may be an item, not a module.
 */
export function extractRust(src: string): Extraction {
  const code = blankCLike(src, { rustRaw: true });
  const imports: Extraction['imports'] = [];
  for (const m of code.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm)) imports.push({ specifier: `mod:${m[1]}`, confidence: 'seguro', line: lineOf(code, m.index) });
  for (const m of code.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)(?:::\{[^}]*\}|::\*)?\s*(?:as\s+\w+)?\s*;/gm)) {
    imports.push({ specifier: m[1]!.replace(/::$/, ''), confidence: 'seguro', line: lineOf(code, m.index) });
  }
  const symbols: SymbolRef[] = [];
  const re = /^(pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*(fn|struct|enum|trait|type|const|static)\s+([A-Za-z_]\w*)/gm;
  for (const m of code.matchAll(re)) {
    const kind: SymbolRef['kind'] = m[2] === 'fn' ? 'funcion' : m[2] === 'struct' || m[2] === 'enum' || m[2] === 'trait' ? 'clase' : m[2] === 'type' ? 'tipo' : 'variable';
    symbols.push({ name: m[3]!, kind, exported: Boolean(m[1]), line: lineOf(code, m.index) });
  }
  return { imports, symbols, mentions: mentionsIn(src), notes: [] };
}

const ROOTS = new Set(['lib.rs', 'main.rs', 'mod.rs']);

/** Folder where the child modules of this file live (rustc rules). */
const childDir = (file: string) => (ROOTS.has(basename(file)) ? dirname(file) : posix.join(dirname(file), basename(file, '.rs')));

function crateRoot(from: string, files: ReadonlySet<string>): string | null {
  let dir = dirname(from);
  for (;;) {
    if (files.has(posix.join(dir, 'lib.rs')) || files.has(posix.join(dir, 'main.rs'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function moduleFile(dir: string, segments: string[], files: ReadonlySet<string>): Resolution {
  for (let k = segments.length; k > 0; k--) {
    const base = posix.join(dir, ...segments.slice(0, k));
    for (const c of [`${base}.rs`, `${base}/mod.rs`]) {
      if (files.has(c)) return { path: c, confidence: k === segments.length ? 'seguro' : 'posible' };
    }
  }
  return null;
}

export function resolveRust(specifier: string, fromPath: string, files: ReadonlySet<string>): Resolution {
  if (specifier.startsWith('mod:')) return moduleFile(childDir(fromPath), [specifier.slice(4)], files);
  const parts = specifier.split('::').filter(Boolean);
  if (parts[0] === 'crate') {
    const root = crateRoot(fromPath, files);
    return root === null ? null : moduleFile(root, parts.slice(1), files);
  }
  if (parts[0] === 'self') return moduleFile(childDir(fromPath), parts.slice(1), files);
  if (parts[0] === 'super') {
    let dir = childDir(fromPath);
    let k = 0;
    while (parts[k] === 'super') {
      dir = dirname(dir);
      k++;
    }
    return moduleFile(dir, parts.slice(k), files);
  }
  return { package: parts[0]! };
}

export const rustExtractor: LanguageExtractor = { id: 'rust', version: 'rs-lexer-1', extensions: ['.rs'], extract: extractRust, resolve: (s, f, files) => resolveRust(s, f, files) };
