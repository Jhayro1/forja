import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Private per-user data directory. Never inside a repo (ADR-008). */
export function forjaHome(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.FORJA_HOME ?? join(homedir(), '.forja');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function checkoutDir(home: string, checkoutId: string): string {
  const dir = join(home, 'checkouts', checkoutId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
