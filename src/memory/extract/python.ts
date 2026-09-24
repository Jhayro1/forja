import { dirname, posix } from 'node:path';
import { mentionsIn, type Extraction, type LanguageExtractor, type Resolution, type SymbolRef } from './types.js';

/**
 * Python extractor (V2-062, second language). Line-based over code with
 * strings and comments blanked. Known limits: `importlib`/`__import__` and
 * conditional imports inside functions are only reported; symbols are
 * top-level `def`/`class` and simple assignments.
 */

/** Blanks comments and string contents (keeping line structure). */
function blank(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const triple = src.startsWith('"""', i) || src.startsWith("'''", i);
    if (triple || c === '"' || c === "'") {
      const q = triple ? src.slice(i, i + 3) : c;
      let j = i + q.length;
      while (j < src.length && !src.startsWith(q, j)) {
        if (src[j] === '\\') j++;
        else if (!triple && src[j] === '\n') break;
        j++;
      }
      const body = src.slice(i, Math.min(src.length, j + q.length));
      out += `${q}${body.slice(q.length, body.length - q.length).replace(/[^\n]/g, ' ')}${q}`;
      i = j + q.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function extractPython(src: string): Extraction {
  const code = blank(src);
  const imports: Extraction['imports'] = [];
  const symbols: SymbolRef[] = [];
  const notes: string[] = [];
  code.split('\n').forEach((raw, idx) => {
    const line = idx + 1;
    const indent = raw.length - raw.trimStart().length;
    const s = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(s))) {
      const mod = m[1]!;
      if (/^\.+$/.test(mod)) {
        // from . import a, b → each name is a module of the package
        for (const name of m[2]!.replace(/[()]/g, '').split(',').map((x) => x.trim().split(/\s+as\s+/)[0]!).filter(Boolean)) {
          imports.push({ specifier: `${mod}${name}`, confidence: 'seguro', line });
        }
      } else imports.push({ specifier: mod, confidence: 'seguro', line });
      if (indent > 0) notes.push(`línea ${line}: import dentro de un bloque: puede no ejecutarse siempre`);
    } else if ((m = /^import\s+(.+)$/.exec(s))) {
      for (const part of m[1]!.split(',')) imports.push({ specifier: part.trim().split(/\s+as\s+/)[0]!, confidence: 'seguro', line });
      if (indent > 0) notes.push(`línea ${line}: import dentro de un bloque: puede no ejecutarse siempre`);
    } else if (/\b(importlib\.import_module|__import__)\s*\(/.test(s)) {
      notes.push(`línea ${line}: import dinámico: el destino no se puede saber sin ejecutar`);
    }
    if (indent === 0) {
      if ((m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(s))) symbols.push({ name: m[1]!, kind: 'funcion', exported: !m[1]!.startsWith('_'), line });
      else if ((m = /^class\s+([A-Za-z_]\w*)/.exec(s))) symbols.push({ name: m[1]!, kind: 'clase', exported: !m[1]!.startsWith('_'), line });
      else if ((m = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(s))) symbols.push({ name: m[1]!, kind: 'variable', exported: !m[1]!.startsWith('_'), line });
    }
  });
  return { imports, symbols, mentions: mentionsIn(src), notes };
}

export function resolvePython(specifier: string, fromPath: string, files: ReadonlySet<string>): Resolution {
  let base: string;
  const dots = /^\.*/.exec(specifier)![0].length;
  const rest = specifier.slice(dots).replace(/\./g, '/');
  if (dots > 0) {
    let dir = dirname(fromPath);
    for (let k = 1; k < dots; k++) dir = dirname(dir);
    base = posix.normalize(posix.join(dir, rest));
  } else base = rest;
  for (const candidate of [`${base}.py`, `${base}/__init__.py`]) if (files.has(candidate)) return { path: candidate, confidence: 'seguro' };
  // Absolute import of something inside a source root (src/pkg/…): «posible», not proven.
  if (dots === 0) {
    const hit = [...files].find((f) => f.endsWith(`/${base}.py`) || f.endsWith(`/${base}/__init__.py`));
    if (hit) return { path: hit, confidence: 'posible' };
    return { package: specifier.split('.')[0]! };
  }
  return null;
}

export const pythonExtractor: LanguageExtractor = {
  id: 'python',
  version: 'py-lines-1',
  extensions: ['.py'],
  extract: extractPython,
  resolve: resolvePython,
};
