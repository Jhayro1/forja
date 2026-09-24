import { posix } from 'node:path';
import { lineOf, stripComments } from './clike.js';
import { type Extraction, type LanguageExtractor, mentionsIn, type Resolution, type ResolveContext, type SymbolRef } from './types.js';

/**
 * Go extractor (MEJORAS 5.6). Imports are package paths: inside the module
 * they resolve to the package's folder, represented by its first source file
 * with confidence «posible» (a package is a folder, not one file).
 */
export function extractGo(src: string): Extraction {
  const code = stripComments(src);
  const imports: Extraction['imports'] = [];
  const add = (spec: string, index: number) => imports.push({ specifier: spec, confidence: 'seguro', line: lineOf(code, index) });
  for (const m of code.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) add(m[1]!, m.index);
  for (const block of code.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    for (const m of block[1]!.matchAll(/(?:^|\n)\s*(?:[\w.]+\s+)?"([^"]+)"/g)) add(m[1]!, block.index + block[0].indexOf(m[0]));
  }
  const symbols: SymbolRef[] = [];
  const sym = (name: string, kind: SymbolRef['kind'], index: number) => symbols.push({ name, kind, exported: /^[A-Z]/.test(name), line: lineOf(code, index) });
  for (const m of code.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm)) sym(m[1]!, 'funcion', m.index);
  for (const m of code.matchAll(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)?/gm)) sym(m[1]!, m[2] === 'struct' ? 'clase' : 'tipo', m.index);
  for (const m of code.matchAll(/^(?:var|const)\s+([A-Za-z_]\w*)/gm)) sym(m[1]!, 'variable', m.index);
  return { imports, symbols, mentions: mentionsIn(src), notes: [] };
}

export function resolveGo(specifier: string, _fromPath: string, files: ReadonlySet<string>, ctx?: ResolveContext): Resolution {
  const mod = ctx?.goModule;
  if (mod && (specifier === mod || specifier.startsWith(`${mod}/`))) {
    const dir = specifier === mod ? '' : specifier.slice(mod.length + 1);
    const inDir = [...files].filter((f) => f.endsWith('.go') && !f.endsWith('_test.go') && posix.dirname(f) === (dir || '.')).sort();
    return inDir[0] ? { path: inDir[0], confidence: 'posible' } : null;
  }
  const first = specifier.split('/')[0]!;
  // Standard library paths have no dot in their first element.
  if (!first.includes('.')) return { package: specifier };
  return { package: specifier.split('/').slice(0, 3).join('/') };
}

export const goExtractor: LanguageExtractor = { id: 'go', version: 'go-lexer-1', extensions: ['.go'], extract: extractGo, resolve: resolveGo };
