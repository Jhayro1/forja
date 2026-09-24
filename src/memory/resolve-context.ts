import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, matchesGlob, posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EMPTY_RESOLVE_CONTEXT, type ResolveContext } from './extract/types.js';

/**
 * Project resolution data read from versioned files only (MEJORAS 5.3): never
 * runs a bundler or the package manager. What cannot be read stays unresolved
 * and is reported by `forja memoria construir`, as before.
 */

/** JSON with comments and trailing commas (tsconfig style). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as unknown;
}

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return parseJsonc(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** A package.json "exports"/"imports" target: a string, or the first usable condition. */
function target(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ['import', 'module', 'default', 'require', 'node', 'types']) {
      const t = target(o[k]);
      if (t) return t;
    }
  }
  return null;
}

function tsconfig(root: string, file: string, seen = new Set<string>()): { baseUrl: string | null; paths: Record<string, string[]> } {
  const path = join(root, file);
  if (seen.has(path) || !existsSync(path)) return { baseUrl: null, paths: {} };
  seen.add(path);
  const cfg = readJson(path) ?? {};
  // One `extends` chain of relative files (packages in node_modules are not read).
  const ext =
    typeof cfg.extends === 'string' && cfg.extends.startsWith('.')
      ? tsconfig(root, posix.join(posix.dirname(file), cfg.extends.endsWith('.json') ? cfg.extends : `${cfg.extends}.json`), seen)
      : { baseUrl: null, paths: {} };
  const co = (cfg.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
  const dir = posix.dirname(file);
  const baseUrl = co.baseUrl !== undefined ? posix.normalize(posix.join(dir, co.baseUrl)) : ext.baseUrl;
  return { baseUrl, paths: { ...ext.paths, ...(co.paths ?? {}) } };
}

export function loadResolveContext(root: string, files: readonly string[]): ResolveContext {
  const ctx: ResolveContext = structuredClone(EMPTY_RESOLVE_CONTEXT);
  const ts = tsconfig(root, 'tsconfig.json');
  ctx.baseUrl = ts.baseUrl === '.' ? '' : ts.baseUrl;
  const base = ts.baseUrl ?? '.';
  for (const [pattern, targets] of Object.entries(ts.paths)) {
    ctx.aliases.push({ pattern, targets: targets.map((t) => posix.normalize(posix.join(base, t))) });
  }

  const pkg = readJson(join(root, 'package.json')) ?? {};
  for (const [k, v] of Object.entries((pkg.imports ?? {}) as Record<string, unknown>)) {
    const t = target(v);
    if (t) ctx.packageImports[k] = posix.normalize(t);
  }
  // Workspaces: package.json "workspaces" or pnpm-workspace.yaml.
  let globs: string[] = Array.isArray(pkg.workspaces)
    ? (pkg.workspaces as string[])
    : Array.isArray((pkg.workspaces as { packages?: string[] })?.packages)
      ? (pkg.workspaces as { packages: string[] }).packages
      : [];
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) {
    try {
      globs = [...globs, ...(((parseYaml(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as { packages?: string[] }) ?? {}).packages ?? [])];
    } catch {
      // Unreadable: no workspaces from it.
    }
  }
  for (const f of files.filter((x) => x.endsWith('/package.json'))) {
    const dir = dirname(f);
    if (!globs.some((g) => matchesGlob(dir, g))) continue;
    const p = readJson(join(root, f));
    if (!p || typeof p.name !== 'string') continue;
    const exports: Record<string, string> = {};
    const ex = p.exports;
    if (typeof ex === 'string') exports['.'] = posix.normalize(posix.join(dir, ex));
    else if (ex && typeof ex === 'object') {
      const entries = Object.entries(ex as Record<string, unknown>);
      // Conditions at the top level («import», «default»…) mean a single «.» entry.
      if (entries.every(([k]) => !k.startsWith('.'))) {
        const t = target(ex);
        if (t) exports['.'] = posix.normalize(posix.join(dir, t));
      } else {
        for (const [k, v] of entries) {
          const t = target(v);
          if (t) exports[k] = posix.normalize(posix.join(dir, t));
        }
      }
    }
    if (!exports['.'] && typeof p.main === 'string') exports['.'] = posix.normalize(posix.join(dir, p.main));
    ctx.workspaces[p.name] = { dir, exports };
  }

  const gomod = existsSync(join(root, 'go.mod')) ? readFileSync(join(root, 'go.mod'), 'utf8') : '';
  ctx.goModule = /^module\s+(\S+)/m.exec(gomod)?.[1] ?? null;
  return ctx;
}

/** Matches a pattern with at most one `*` and returns what the star captured. */
export function matchPattern(pattern: string, spec: string): string | null {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === spec ? '' : null;
  const pre = pattern.slice(0, star);
  const post = pattern.slice(star + 1);
  return spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length ? spec.slice(pre.length, spec.length - post.length) : null;
}
