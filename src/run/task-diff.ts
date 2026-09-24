import { existsSync } from 'node:fs';
import { git } from '../git/git.js';
import { diffText } from '../git/workspace.js';
import type { ExecRow } from './orchestrator.js';

/**
 * Diff of a task for review: the captured candidate if there is one, otherwise
 * the live worktree of a working agent (read-only: never touches its index).
 */
export async function taskDiff(repoPath: string, exec: ExecRow, maxBytes = 200_000): Promise<string> {
  if (exec.base_sha && exec.candidate_sha) return (await diffText(repoPath, exec.base_sha, exec.candidate_sha, maxBytes)) || '(el candidato no tiene diferencias)';
  if (exec.worktree && exec.base_sha && existsSync(exec.worktree)) {
    const tracked = (await git(exec.worktree, ['diff', exec.base_sha, '--', '.', ':(exclude)package-lock.json'], { allowFail: true })).stdout;
    const untracked = (await git(exec.worktree, ['ls-files', '--others', '--exclude-standard'], { allowFail: true })).stdout.split('\n').filter(Boolean);
    const text = [tracked.trim(), untracked.length ? `Archivos nuevos todavía sin capturar:\n${untracked.map((f) => `  + ${f}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n… [diff recortado]` : text || '(todavía no hay cambios)';
  }
  return '(esta tarea todavía no tiene cambios)';
}
