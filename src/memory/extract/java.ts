import { posix } from 'node:path';
import { blankCLike, lineOf } from './clike.js';
import { type Extraction, type LanguageExtractor, mentionsIn, type Resolution, type SymbolRef } from './types.js';

/**
 * Java extractor (MEJORAS 5.6). Imports name classes (`a.b.C`), resolved to
 * the file whose path ends in a/b/C.java under any source root; wildcards and
 * static imports resolve to their class or package folder.
 */
export function extractJava(src: string): Extraction {
  const code = blankCLike(src);
  const imports: Extraction['imports'] = [];
  for (const m of code.matchAll(/^\s*import\s+(static\s+)?([\w.]+)(\.\*)?\s*;/gm)) {
    imports.push({ specifier: `${m[1] ? 'static:' : ''}${m[2]}${m[3] ?? ''}`, confidence: 'seguro', line: lineOf(code, m.index) });
  }
  const symbols: SymbolRef[] = [];
  const re = /^((?:public|protected|private|abstract|final|sealed|non-sealed|static|strictfp)\s+)*(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of code.matchAll(re)) symbols.push({ name: m[3]!, kind: m[2] === 'class' || m[2] === 'record' ? 'clase' : 'tipo', exported: /\bpublic\b/.test(m[0]), line: lineOf(code, m.index) });
  return { imports, symbols, mentions: mentionsIn(src), notes: [] };
}

const byClassPath = (classPath: string, files: ReadonlySet<string>) => [...files].find((f) => f === `${classPath}.java` || f.endsWith(`/${classPath}.java`)) ?? null;

export function resolveJava(specifier: string, _fromPath: string, files: ReadonlySet<string>): Resolution {
  const isStatic = specifier.startsWith('static:');
  const name = specifier.replace(/^static:/, '');
  if (/^(java|javax|jdk|sun)\./.test(name)) return { package: name.split('.')[0]! };
  if (name.endsWith('.*')) {
    const dir = name.slice(0, -2).replace(/\./g, '/');
    const hit = [...files].filter((f) => f.endsWith('.java') && (posix.dirname(f) === dir || posix.dirname(f).endsWith(`/${dir}`))).sort()[0];
    if (hit) return { path: hit, confidence: 'posible' };
  } else {
    const segments = name.split('.');
    // A static import names a member: its class is one segment up.
    for (const cut of isStatic ? [1] : [0, 1]) {
      const hit = byClassPath(segments.slice(0, segments.length - cut).join('/'), files);
      if (hit) return { path: hit, confidence: cut === 0 || isStatic ? 'seguro' : 'posible' };
    }
  }
  return { package: name.split('.').slice(0, 2).join('.') };
}

export const javaExtractor: LanguageExtractor = { id: 'java', version: 'java-lexer-1', extensions: ['.java'], extract: extractJava, resolve: (s, f, files) => resolveJava(s, f, files) };
