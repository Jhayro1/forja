import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Builds dist/ once before any test file runs. Tests spawn the compiled CLI,
 * runner and agents; building from every worker at once let one worker rewrite
 * dist/ while another was executing it (an intermittent failure).
 */
export default function setup(): void {
  execFileSync('npm', ['run', 'build'], { cwd: resolve(import.meta.dirname, '..'), stdio: 'ignore' });
}
