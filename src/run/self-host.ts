import { realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the running Forja installation (…/dist/run/self-host.js → …). */
export const RUNNING_FORJA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * True when the Forja that orchestrates lives inside the checkout it is about
 * to change (MEJORAS 7 · «Forja sobre Forja»). Agents work in worktrees, so the
 * running code is not edited under its feet, but a rebuild or a checkout of the
 * delivery branch would swap the supervisor mid-run: use a stable copy
 * (scripts/forja-estable.sh).
 */
export function supervisesItself(checkout: string, forjaRoot: string = RUNNING_FORJA_ROOT): boolean {
  const rel = relative(real(checkout), real(forjaRoot));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

export const SELF_HOST_WARNING = '⚠ este Forja se ejecuta desde el mismo repositorio que va a cambiar: instala una copia estable con bash scripts/forja-estable.sh y usa esa para supervisar';
