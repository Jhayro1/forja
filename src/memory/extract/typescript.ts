import { dirname, posix } from 'node:path';
import { type Extraction, type LanguageExtractor, mentionsIn, type Resolution, type SymbolRef } from './types.js';

/**
 * TS/JS extractor without dependencies: a small lexer (comments, strings,
 * templates and regex literals handled so their contents never look like
 * code) and pattern matching over the token stream.
 *
 * Known limits (reported, not hidden): path aliases from tsconfig are not
 * resolved (edge «posible» to the raw specifier), `import(expr)` with a
 * non-literal is only noted, re-exports through barrels are not followed to
 * the final symbol, and calls between functions are not extracted.
 */

type Tok = { t: 'id' | 'str' | 'p'; v: string; line: number };

const REGEX_PREV = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
]);

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const last = () => out[out.length - 1];
  while (i < n) {
    const c = src[i]!;
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          v += src[j + 1] ?? '';
          j += 2;
        } else v += src[j++];
      }
      out.push({ t: 'str', v, line });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      // Template literal: skipped entirely (including ${} blocks, tracked by depth).
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const d = src[j]!;
        if (d === '\n') line++;
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (depth === 0 && d === '`') break;
        if (d === '$' && src[j + 1] === '{') {
          depth++;
          j += 2;
          continue;
        }
        if (depth > 0 && d === '}') depth--;
        j++;
      }
      out.push({ t: 'str', v: '', line });
      i = j + 1;
      continue;
    }
    if (c === '/') {
      const prev = last();
      if (!prev || (prev.t === 'p' && REGEX_PREV.has(prev.v)) || (prev.t === 'id' && REGEX_PREV.has(prev.v))) {
        let j = i + 1;
        let cls = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') {
            j += 2;
            continue;
          }
          if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(src[j]!)) j++;
        out.push({ t: 'str', v: '', line });
        i = j;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j]!)) j++;
      out.push({ t: 'id', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j]!)) j++;
      i = j;
      continue;
    }
    out.push({ t: 'p', v: c, line });
    i++;
  }
  return out;
}

export function extractTs(src: string): Extraction {
  const toks = tokenize(src);
  const imports: Extraction['imports'] = [];
  const symbols: SymbolRef[] = [];
  const notes: string[] = [];
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t === 'p') {
      if (t.v === '{') depth++;
      else if (t.v === '}') depth = Math.max(0, depth - 1);
      continue;
    }
    if (t.t !== 'id') continue;
    const next = toks[i + 1];
    const prevIsDot = toks[i - 1]?.v === '.';
    if (prevIsDot) continue;

    // import(…) and require(…)
    if ((t.v === 'import' || t.v === 'require') && next?.v === '(') {
      const arg = toks[i + 2];
      if (arg?.t === 'str' && toks[i + 3]?.v === ')') imports.push({ specifier: arg.v, confidence: 'seguro', line: t.line });
      else if (t.v === 'import') notes.push(`línea ${t.line}: import() con expresión: el destino no se puede saber sin ejecutar`);
      continue;
    }
    // import … from 'x' | import 'x' | export … from 'x'
    if ((t.v === 'import' || t.v === 'export') && next && next.v !== '(' && next.v !== '.') {
      if (t.v === 'import' && next.t === 'str') {
        imports.push({ specifier: next.v, confidence: 'seguro', line: t.line });
        continue;
      }
      // Scan to the end of the statement for `from 'x'`.
      let j = i + 1;
      let braces = 0;
      for (; j < toks.length && j < i + 400; j++) {
        const u = toks[j]!;
        if (u.v === '{') braces++;
        else if (u.v === '}') braces--;
        if (
          braces === 0 &&
          (u.v === ';' ||
            (u.t === 'id' && ['function', 'class', 'const', 'let', 'var', 'interface', 'type', 'enum', 'async', 'default', 'abstract', 'declare', 'namespace'].includes(u.v) && t.v === 'export'))
        )
          break;
        if (u.t === 'id' && u.v === 'from' && toks[j + 1]?.t === 'str') {
          imports.push({ specifier: toks[j + 1]!.v, confidence: 'seguro', line: t.line });
          break;
        }
      }
    }
    // Top-level declarations (inside `export {…}` lists nothing is declared).
    if (depth === 0) {
      const exported = toks[i - 1]?.v === 'export' || (toks[i - 1]?.v === 'default' && toks[i - 2]?.v === 'export') || (toks[i - 1]?.v === 'async' && toks[i - 2]?.v === 'export');
      const name = (k: number) => (toks[k]?.t === 'id' ? toks[k]!.v : null);
      if (t.v === 'function') {
        const n = name(i + 1) ?? (toks[i + 1]?.v === '*' ? name(i + 2) : null);
        if (n) symbols.push({ name: n, kind: 'funcion', exported, line: t.line });
      } else if (t.v === 'class') {
        const n = name(i + 1);
        if (n && n !== 'extends') symbols.push({ name: n, kind: 'clase', exported, line: t.line });
      } else if (t.v === 'const' || t.v === 'let' || t.v === 'var') {
        const n = name(i + 1);
        if (n && n !== 'enum') symbols.push({ name: n, kind: 'variable', exported, line: t.line });
      } else if ((t.v === 'interface' || t.v === 'enum' || (t.v === 'type' && toks[i + 2] && ['=', '<'].includes(toks[i + 2]!.v))) && name(i + 1)) {
        symbols.push({ name: name(i + 1)!, kind: 'tipo', exported, line: t.line });
      }
    }
  }
  const unique = new Map<string, SymbolRef>();
  for (const s of symbols) if (!unique.has(s.name) || s.exported) unique.set(s.name, s);
  return { imports, symbols: [...unique.values()], mentions: mentionsIn(src), notes };
}

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function resolveTs(specifier: string, fromPath: string, files: ReadonlySet<string>): Resolution {
  if (specifier.startsWith('node:')) return { package: specifier };
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    // Bare specifier: a package, unless it looks like a tsconfig alias (@/x, ~/x, #x).
    if (/^(@\/|~\/|#)/.test(specifier)) return null;
    const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
    return { package: pkg };
  }
  const base = posix.normalize(posix.join(dirname(fromPath), specifier));
  // TS sources import './x.js' that exists as x.ts: try the stem with every extension.
  const stem = base.replace(/\.(m|c)?(j|t)sx?$/, '');
  const candidates = [base, ...EXTS.map((e) => `${stem}${e}`), ...EXTS.map((e) => `${base}/index${e}`)];
  const hit = candidates.find((c) => files.has(c));
  return hit ? { path: hit, confidence: 'seguro' } : null;
}

export const typescriptExtractor: LanguageExtractor = {
  id: 'ts-js',
  version: 'ts-lexer-1',
  extensions: EXTS,
  extract: extractTs,
  resolve: resolveTs,
};
