import { dirname, posix } from 'node:path';
import { matchPattern } from '../resolve-context.js';
import { type Extraction, type ImportedName, type ImportRef, type LanguageExtractor, mentionsIn, type Resolution, type ResolveContext, type SymbolRef } from './types.js';

/**
 * TS/JS extractor without dependencies: a small lexer (comments, strings,
 * templates and regex literals handled so their contents never look like
 * code) and pattern matching over the token stream.
 *
 * It records which names each import binds and which of them the file really
 * uses, and re-exports (`export { a } from`, `export * from`), so the graph can
 * follow a symbol through barrels to the file that defines it (MEJORAS 5.2).
 * Resolution understands tsconfig `paths`/`baseUrl`, package.json `imports`
 * and workspace packages with their `exports` (MEJORAS 5.3).
 *
 * Known limits (reported, not hidden): `import(expr)` with a non-literal is
 * only noted, and calls are tracked per file (who uses a symbol), not per
 * function body.
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

/** `{ a, b as c, type d }` → entries; `imported` is the name before `as`. */
function braceList(clause: Tok[], start: number): { names: ImportedName[]; end: number } {
  const names: ImportedName[] = [];
  let k = start + 1;
  while (k < clause.length && clause[k]!.v !== '}') {
    if (clause[k]!.v === 'type' && clause[k + 1]?.t === 'id' && clause[k + 1]!.v !== 'as') k++;
    const first = clause[k];
    if (first?.t === 'id' || first?.t === 'str') {
      let local = first.v;
      if (clause[k + 1]?.v === 'as' && clause[k + 2]) {
        local = clause[k + 2]!.v;
        k += 2;
      }
      names.push({ imported: first.v, local });
    }
    k++;
    if (clause[k]?.v === ',') k++;
  }
  return { names, end: k };
}

function importNames(clause: Tok[]): { names: ImportedName[]; all: boolean } {
  const names: ImportedName[] = [];
  let k = clause[0]?.v === 'type' ? 1 : 0;
  if (clause[k]?.t === 'id' && clause[k]!.v !== 'as') {
    names.push({ imported: 'default', local: clause[k]!.v });
    k++;
    if (clause[k]?.v === ',') k++;
  }
  if (clause[k]?.v === '*' && clause[k + 1]?.v === 'as' && clause[k + 2]?.t === 'id') names.push({ imported: '*', local: clause[k + 2]!.v });
  else if (clause[k]?.v === '{') names.push(...braceList(clause, k).names);
  return { names, all: false };
}

function exportNames(clause: Tok[]): { names: ImportedName[]; all: boolean } {
  const k = clause[0]?.v === 'type' ? 1 : 0;
  if (clause[k]?.v === '*') {
    if (clause[k + 1]?.v === 'as' && clause[k + 2]) return { names: [{ imported: '*', local: clause[k + 2]!.v }], all: false };
    return { names: [], all: true };
  }
  if (clause[k]?.v === '{') return { names: braceList(clause, k).names, all: false };
  return { names: [], all: false };
}

export function extractTs(src: string): Extraction {
  const toks = tokenize(src);
  const imports: Extraction['imports'] = [];
  const symbols: SymbolRef[] = [];
  const notes: string[] = [];
  /** Token ranges of import/export-from statements: names there are bindings, not uses. */
  const skip: [number, number][] = [];
  const exportedNames = new Set<string>();
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
    // import … from 'x' | import 'x' | export … from 'x' | export { a, b }
    if ((t.v === 'import' || t.v === 'export') && next && next.v !== '(' && next.v !== '.') {
      if (t.v === 'import' && next.t === 'str') {
        imports.push({ specifier: next.v, confidence: 'seguro', line: t.line });
        skip.push([i, i + 1]);
        continue;
      }
      // Scan to the end of the statement for `from 'x'`.
      let j = i + 1;
      let braces = 0;
      let from = -1;
      for (; j < toks.length && j < i + 400; j++) {
        const u = toks[j]!;
        if (u.v === '{') braces++;
        else if (u.v === '}') braces--;
        if (
          braces === 0 &&
          (u.v === ';' ||
            // Without semicolons the next statement starts the next import/export.
            (u.t === 'id' && (u.v === 'import' || u.v === 'export') && j > i + 1) ||
            (u.t === 'id' &&
              ['function', 'class', 'const', 'let', 'var', 'interface', 'type', 'enum', 'async', 'default', 'abstract', 'declare', 'namespace'].includes(u.v) &&
              t.v === 'export' &&
              j === i + 1))
        )
          break;
        if (u.t === 'id' && u.v === 'from' && toks[j + 1]?.t === 'str') {
          from = j;
          break;
        }
      }
      const clause = toks.slice(i + 1, from >= 0 ? from : j);
      if (from >= 0) {
        const ref: ImportRef = { specifier: toks[from + 1]!.v, confidence: 'seguro', line: t.line };
        const parsed = t.v === 'import' ? importNames(clause) : exportNames(clause);
        if (parsed.names.length) ref.names = parsed.names;
        if (t.v === 'export') ref.reexport = parsed.all ? 'all' : 'names';
        imports.push(ref);
        skip.push([i, from + 1]);
      } else if (t.v === 'export' && next.v === '{') {
        // export { a, b as c }: local declarations become exported.
        for (const n of exportNames(clause).names) exportedNames.add(n.imported);
        skip.push([i, j]);
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
  for (const name of exportedNames) {
    const sym = unique.get(name);
    if (sym) unique.set(name, { ...sym, exported: true });
  }
  // Which imported bindings are really used (a name after `.` is a property, not a use).
  const locals = new Set(imports.filter((r) => !r.reexport).flatMap((r) => (r.names ?? []).map((n) => n.local)));
  const used = new Set<string>();
  let s = 0;
  for (let k = 0; k < toks.length; k++) {
    while (s < skip.length && skip[s]![1] < k) s++;
    if (s < skip.length && k >= skip[s]![0] && k <= skip[s]![1]) continue;
    const tok = toks[k]!;
    if (tok.t === 'id' && locals.has(tok.v) && toks[k - 1]?.v !== '.') used.add(tok.v);
  }
  return { imports, symbols: [...unique.values()], mentions: mentionsIn(src), notes, used: [...used].sort() };
}

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** The file a module path points to: TS sources import './x.js' that exists as x.ts, or a folder's index. */
function fileFor(base: string, files: ReadonlySet<string>): string | null {
  const stem = base.replace(/\.(m|c)?(j|t)sx?$/, '');
  const candidates = [base, ...EXTS.map((e) => `${stem}${e}`), ...EXTS.map((e) => `${base}/index${e}`), ...EXTS.map((e) => `${base}/src/index${e}`)];
  return candidates.find((c) => files.has(c)) ?? null;
}

export function resolveTs(specifier: string, fromPath: string, files: ReadonlySet<string>, ctx?: ResolveContext): Resolution {
  if (specifier.startsWith('node:')) return { package: specifier };
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const hit = fileFor(posix.normalize(posix.join(dirname(fromPath), specifier)), files);
    return hit ? { path: hit, confidence: 'seguro' } : null;
  }
  if (ctx) {
    // package.json "imports" (#x) of the project.
    for (const [key, t] of Object.entries(ctx.packageImports)) {
      const m = matchPattern(key, specifier);
      const hit = m !== null ? fileFor(t.replace('*', m), files) : null;
      if (hit) return { path: hit, confidence: 'seguro' };
    }
    // tsconfig paths, longest pattern first (like tsc).
    for (const a of [...ctx.aliases].sort((x, y) => y.pattern.length - x.pattern.length)) {
      const m = matchPattern(a.pattern, specifier);
      if (m === null) continue;
      for (const t of a.targets) {
        const hit = fileFor(t.replace('*', m), files);
        if (hit) return { path: hit, confidence: 'seguro' };
      }
    }
    // Workspace packages of a monorepo, through their "exports".
    const pkgName = Object.keys(ctx.workspaces)
      .filter((n) => specifier === n || specifier.startsWith(`${n}/`))
      .sort((x, y) => y.length - x.length)[0];
    if (pkgName) {
      const ws = ctx.workspaces[pkgName]!;
      const sub = specifier === pkgName ? '.' : `.${specifier.slice(pkgName.length)}`;
      for (const [key, t] of Object.entries(ws.exports)) {
        const m = matchPattern(key, sub);
        const hit = m !== null ? fileFor(t.replace('*', m), files) : null;
        if (hit) return { path: hit, confidence: 'seguro' };
      }
      const hit = fileFor(posix.join(ws.dir, sub === '.' ? 'index' : sub.slice(2)), files) ?? fileFor(posix.join(ws.dir, 'src', sub === '.' ? 'index' : sub.slice(2)), files);
      if (hit) return { path: hit, confidence: 'posible' };
    }
    if (ctx.baseUrl !== null) {
      const hit = fileFor(posix.normalize(posix.join(ctx.baseUrl, specifier)), files);
      if (hit) return { path: hit, confidence: 'seguro' };
    }
  }
  // Still an alias-looking specifier: unresolved (reported), never a fake package.
  if (/^(@\/|~\/|#)/.test(specifier)) return null;
  const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
  return { package: pkg };
}

export const typescriptExtractor: LanguageExtractor = {
  id: 'ts-js',
  version: 'ts-lexer-2',
  extensions: EXTS,
  extract: extractTs,
  resolve: resolveTs,
};
