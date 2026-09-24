import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, matchesGlob } from 'node:path';
import type { Redactor } from '../security/redact.js';
import { FORJA_AUTHOR, git, gitOut } from './git.js';

export const runBranch = (prefix: string, runId: string) => `${prefix}run/${runId}/integracion`;
/** Where a completed change is delivered; main is never touched. */
export const deliveryBranch = (prefix: string, changeId: string) => `${prefix}entrega/${changeId}`;
export const taskBranch = (prefix: string, runId: string, taskId: string) => `${prefix}run/${runId}/tareas/${taskId}`;

/** Creates the run's integration branch at the approved base if it does not exist. */
export async function ensureIntegrationBranch(repo: string, branch: string, baseSha: string): Promise<string> {
  const existing = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true });
  if (existing.code === 0) return existing.stdout.trim();
  await git(repo, ['branch', branch, baseSha]);
  return baseSha;
}

export async function refSha(repo: string, branch: string): Promise<string> {
  return gitOut(repo, ['rev-parse', `refs/heads/${branch}`]);
}

/**
 * Worktree for one task attempt, born from the integrated SHA (I04). Reused when it
 * already exists (recovery keeps the agent's work).
 */
export async function taskWorktree(repo: string, path: string, branch: string, baseSha: string): Promise<{ path: string; reused: boolean }> {
  if (existsSync(join(path, '.git'))) return { path, reused: true };
  mkdirSync(dirname(path), { recursive: true });
  const exists = (await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true })).code === 0;
  if (exists) await git(repo, ['branch', '-f', branch, baseSha]);
  await git(repo, ['worktree', 'add', '-q', ...(exists ? [] : ['-b', branch]), path, ...(exists ? [branch] : [baseSha])]);
  return { path, reused: false };
}

/** Detached worktree at an exact commit, for verification or integration. */
export async function detachedWorktree(repo: string, path: string, sha: string): Promise<string> {
  if (existsSync(join(path, '.git'))) {
    await git(path, ['checkout', '-q', '--detach', '--force', sha]);
    await git(path, ['clean', '-q', '-fdx', '-e', 'node_modules']);
    return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  await git(repo, ['worktree', 'add', '-q', '--detach', path, sha]);
  return path;
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  if (!existsSync(path)) return;
  await git(repo, ['worktree', 'remove', '--force', path], { allowFail: true });
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune'], { allowFail: true });
}

export type Change = { status: string; path: string; from?: string };

export type Capture = {
  sha: string | null;
  changes: Change[];
  violations: string[];
  secretFindings: string[];
};

/** Paths Forja never accepts from a task, whatever its globs say. */
const ALWAYS_FORBIDDEN = ['.git', '.git/**', '.forja/**', 'forja.yaml', '.github/**'];

export function pathAllowed(path: string, allow: string[], protectedPaths: string[]): string | null {
  if (ALWAYS_FORBIDDEN.some((g) => matchesGlob(path, g))) return `${path}: ruta reservada de Forja o de git`;
  if (protectedPaths.some((g) => matchesGlob(path, g))) return `${path}: archivo protegido (pruebas o configuración de verificación)`;
  if (!allow.some((g) => matchesGlob(path, g) || path === g)) return `${path}: fuera de los archivos permitidos de la tarea`;
  return null;
}

/**
 * Captures what the agent changed. MUST only be called when the runner has
 * finished (no writers): never `git add -A` under an active process (v2 · H08).
 */
export async function captureTask(worktree: string, opts: { baseSha: string; allow: string[]; protectedPaths: string[]; message: string; redactor: Redactor }): Promise<Capture> {
  await git(worktree, ['add', '-A', '--', '.', ':(exclude)node_modules']);
  const nameStatus = (await git(worktree, ['diff', '--cached', '--name-status', '--no-renames', opts.baseSha])).stdout.trim();
  const changes: Change[] = nameStatus
    ? nameStatus.split('\n').map((line) => {
        const [status, ...paths] = line.split('\t');
        return { status: status!, path: paths.at(-1)! };
      })
    : [];
  const violations: string[] = [];
  for (const c of changes) {
    const why = pathAllowed(c.path, opts.allow, opts.protectedPaths);
    if (why) violations.push(why);
  }
  // Symlinks pointing outside the repo, mode changes to executables are reviewed too.
  const modes = (await git(worktree, ['diff', '--cached', '--summary', opts.baseSha])).stdout;
  for (const line of modes.split('\n')) if (/mode 120000/.test(line)) violations.push(`enlace simbólico nuevo: ${line.trim()}`);
  const secretFindings: string[] = [];
  for (const c of changes.filter((x) => x.status !== 'D')) {
    const full = join(worktree, c.path);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
    if (opts.redactor.containsSecret(text)) secretFindings.push(`${c.path}: contiene algo con forma de credencial`);
  }
  if (changes.length === 0 || violations.length > 0 || secretFindings.length > 0) {
    return { sha: null, changes, violations, secretFindings };
  }
  // A retry can reproduce exactly the previous candidate: nothing new to commit, keep HEAD.
  const staged = await git(worktree, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (staged.code !== 0) await git(worktree, ['commit', '-q', '--no-verify', '-m', opts.message], { env: FORJA_AUTHOR });
  return { sha: await gitOut(worktree, ['rev-parse', 'HEAD']), changes, violations, secretFindings };
}

/** Reverts the working tree of a task to its base (after a rejected capture it stays for evidence). */
export async function resetWorktree(worktree: string, sha: string): Promise<void> {
  await git(worktree, ['reset', '-q', '--hard', sha]);
  await git(worktree, ['clean', '-q', '-fd', '-e', 'node_modules']);
}

export async function diffStat(repo: string, from: string, to: string): Promise<string> {
  return (await git(repo, ['diff', '--stat', from, to])).stdout.trim();
}

export async function diffText(repo: string, from: string, to: string, maxBytes = 60_000): Promise<string> {
  const out = (await git(repo, ['diff', from, to, '--', '.', ':(exclude)package-lock.json'])).stdout;
  return out.length > maxBytes ? `${out.slice(0, maxBytes)}\n… [diff recortado]` : out;
}

/**
 * Integration: merge the task commit onto the integration SHA in a private
 * worktree. Returns the merge commit or the conflict list (nothing published yet).
 */
export async function mergeCandidate(worktree: string, targetSha: string, taskSha: string, message: string): Promise<{ sha: string } | { conflicts: string[] }> {
  await git(worktree, ['checkout', '-q', '--detach', '--force', targetSha]);
  await git(worktree, ['clean', '-q', '-fd', '-e', 'node_modules']);
  const merge = await git(worktree, ['merge', '--no-ff', '--no-edit', '-m', message, taskSha], { allowFail: true, env: FORJA_AUTHOR });
  if (merge.code !== 0) {
    const conflicts = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout.split('\n').filter(Boolean);
    await git(worktree, ['merge', '--abort'], { allowFail: true });
    return { conflicts: conflicts.length ? conflicts : [merge.stderr.trim().split('\n')[0] ?? 'conflicto'] };
  }
  return { sha: await gitOut(worktree, ['rev-parse', 'HEAD']) };
}

/** Compare-and-swap of the integration ref: only moves if it still points to `expected`. */
export async function publishRef(repo: string, branch: string, newSha: string, expected: string): Promise<boolean> {
  const r = await git(repo, ['update-ref', `refs/heads/${branch}`, newSha, expected], { allowFail: true });
  return r.code === 0;
}

export async function isAncestor(repo: string, ancestor: string, of: string): Promise<boolean> {
  return (await git(repo, ['merge-base', '--is-ancestor', ancestor, of], { allowFail: true })).code === 0;
}
