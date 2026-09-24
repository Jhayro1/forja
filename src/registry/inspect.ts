import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git/git.js';

export type RepoInspection = {
  root: string;
  hasCommits: boolean;
  head: string | null;
  branch: string | null;
  dirtyFiles: number;
  submodules: boolean;
  lfs: boolean;
  symlinks: number;
  trackedFiles: number;
  languages: string[];
  manifests: string[];
  /** Conditions that block execution until resolved (v2/03 · Importación y confianza). */
  blockers: string[];
  warnings: string[];
};

const MANIFESTS = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'bun.lockb',
  'tsconfig.json',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'Makefile',
  'Dockerfile',
];

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  php: 'php',
  rb: 'ruby',
  cs: 'csharp',
};

/**
 * Static inspection only: reads files and git metadata. Never runs install scripts,
 * hooks, MCP servers or detected commands.
 */
export async function inspectRepo(path: string): Promise<RepoInspection> {
  const top = await git(path, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (top.code !== 0) throw new Error(`${path} no es un repositorio git`);
  const root = top.stdout.trim();
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  const branch = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true });
  const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  const files = await git(root, ['ls-files', '-s', '-z']);
  const entries = files.stdout.split('\0').filter(Boolean);
  const symlinks = entries.filter((e) => e.startsWith('120000 ')).length;
  const paths = entries.map((e) => e.slice(e.indexOf('\t') + 1));

  const langCount = new Map<string, number>();
  for (const p of paths) {
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    const lang = EXT_LANG[ext];
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
  }
  const languages = [...langCount.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const manifests = MANIFESTS.filter((m) => existsSync(join(root, m)));
  const gitattributes = existsSync(join(root, '.gitattributes')) ? readFileSync(join(root, '.gitattributes'), 'utf8') : '';

  const inspection: RepoInspection = {
    root,
    hasCommits: head.code === 0,
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    dirtyFiles: status.stdout.split('\n').filter(Boolean).length,
    submodules: existsSync(join(root, '.gitmodules')),
    lfs: /filter=lfs/.test(gitattributes),
    symlinks,
    trackedFiles: paths.length,
    languages,
    manifests,
    blockers: [],
    warnings: [],
  };
  if (!inspection.hasCommits) inspection.blockers.push('el repositorio no tiene commits: haz un primer commit para tener una base');
  if (inspection.submodules) inspection.blockers.push('submódulos de git todavía no están soportados');
  if (inspection.lfs) inspection.blockers.push('Git LFS todavía no está soportado');
  if (inspection.dirtyFiles > 0) {
    inspection.warnings.push(`${inspection.dirtyFiles} archivos con cambios sin commit: Forja trabaja desde el último commit y no los incluye`);
  }
  if (symlinks > 0) inspection.warnings.push(`${symlinks} enlaces simbólicos: se revisan para que no apunten fuera del repo`);
  return inspection;
}
