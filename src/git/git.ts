import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export type GitResult = { stdout: string; stderr: string; code: number };

/**
 * Runs git with structured arguments (never a shell string built from model output).
 * Hooks are disabled and the user's global config cannot inject aliases or fsmonitor.
 */
export function git(cwd: string, args: string[], options: { allowFail?: boolean; input?: string; env?: Record<string, string> } = {}): Promise<GitResult> {
  const safeArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=user', ...args];
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      safeArgs,
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...options.env },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        const result = { stdout: String(stdout), stderr: String(stderr), code };
        if (code !== 0 && !options.allowFail) reject(new GitError(`git ${args[0]} falló: ${String(stderr).trim().split('\n')[0]}`, code, String(stderr)));
        else resolve(result);
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export async function gitOut(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim();
}

/** Identity used by commits Forja creates on its own branches (never on the user's branch). */
export const FORJA_AUTHOR = { GIT_AUTHOR_NAME: 'Forja', GIT_AUTHOR_EMAIL: 'forja@localhost', GIT_COMMITTER_NAME: 'Forja', GIT_COMMITTER_EMAIL: 'forja@localhost' };
