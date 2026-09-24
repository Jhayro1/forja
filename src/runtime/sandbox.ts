import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, sep } from 'node:path';

export type Mount = { src: string; dest: string; rw: boolean };

export type SandboxSpec = {
  /** The task workspace: the only writable project path. */
  workspace: string;
  /** Fake HOME inside the sandbox (a tmpfs). */
  home: string;
  /** Provider config dir inside the sandbox (persistent per checkout) and the files bound into it. */
  mounts: Mount[];
  /** Read-only binds for binaries that live under a hidden HOME. */
  readOnly: string[];
  /** When set, the sandbox has no network; the proxy socket is its only way out. */
  proxySocket?: string;
  /** Directory with Forja helper scripts (bridge), mounted read-only at /run/forja. */
  helperDir: string;
};

export const SANDBOX_HELPER_DIR = '/run/forja';
export const SANDBOX_PROXY_SOCKET = '/run/forja-proxy.sock';

/**
 * bubblewrap arguments. Everything is read-only except the workspace, the provider's
 * own state dir and tmpfs. `--unshare-pid` makes the whole process tree die with the
 * sandbox (M0: Claude's setsid shells survived a kill -9 of the CLI otherwise);
 * `--die-with-parent` ties the sandbox to its runner.
 */
export function bwrapArgs(spec: SandboxSpec): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run'];
  // Hide the real home (other projects, SSH keys, other providers' logins).
  const realHome = homedir();
  args.push('--tmpfs', realHome);
  if (spec.home !== realHome) args.push('--tmpfs', spec.home);
  for (const dir of spec.readOnly) args.push('--ro-bind', dir, dir);
  for (const m of spec.mounts) args.push(m.rw ? '--bind' : '--ro-bind', m.src, m.dest);
  args.push('--bind', spec.workspace, spec.workspace);
  args.push('--ro-bind', spec.helperDir, SANDBOX_HELPER_DIR);
  if (spec.proxySocket) args.push('--bind', spec.proxySocket, SANDBOX_PROXY_SOCKET, '--unshare-net');
  args.push('--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session', '--chdir', spec.workspace);
  return args;
}

/**
 * Directory to bind read-only so an executable installed under HOME (or via npm)
 * still runs when HOME is hidden. System paths are already visible through `/`.
 */
export function installRoot(executable: string): string | null {
  const real = realpathSync(executable);
  const home = homedir();
  const nm = real.lastIndexOf(`${sep}node_modules${sep}`);
  if (nm >= 0) {
    // Keep node_modules/<pkg> or node_modules/@scope/<pkg>.
    const rest = real.slice(nm + '/node_modules/'.length).split(sep);
    const depth = rest[0]?.startsWith('@') ? 2 : 1;
    return real.slice(0, nm) + sep + 'node_modules' + sep + rest.slice(0, depth).join(sep);
  }
  if (!real.startsWith(home + sep)) return null;
  // Codex standalone: …/.codex/packages/standalone/current/bin/codex → bind …/.codex/packages
  const packages = real.indexOf(`${sep}packages${sep}`);
  if (packages >= 0) return real.slice(0, packages + '/packages'.length);
  return dirname(real);
}

/** Read-only binds needed to run `executable` and Node itself inside the sandbox. */
export function binaryBinds(executables: string[]): string[] {
  const dirs = new Set<string>();
  for (const exe of executables) {
    if (!existsSync(exe)) continue;
    const root = installRoot(exe);
    if (root) dirs.add(root);
  }
  return [...dirs];
}
