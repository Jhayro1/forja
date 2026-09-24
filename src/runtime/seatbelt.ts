import { homedir } from 'node:os';
import { SANDBOX_HELPER_DIR, SANDBOX_PROXY_SOCKET, type SandboxSpec } from './sandbox.js';

/**
 * macOS PROTOTYPE (MEJORAS 7, docs/decisiones/ADR-010-aislamiento-macos.md): the same isolation
 * contract as `bwrapArgs`, expressed as a Seatbelt profile for `sandbox-exec`.
 * Not wired into the launcher: it has not been run on a Mac. What the profile
 * cannot guarantee is returned as `limitations`, never silently assumed.
 *
 * Differences that change the contract:
 *  - no mount namespace: paths cannot be remapped (helper dir, proxy socket,
 *    provider files keep their real paths; the agent gets them by env);
 *  - no pid namespace: the runner must kill the process group, and a process
 *    that calls setsid escapes that kill;
 *  - no tmpfs: the fake HOME must be a real, fresh directory per launch.
 */
export type SeatbeltPlan = {
  profile: string;
  /** Paths the agent must receive instead of the fixed Linux ones. */
  env: Record<string, string>;
  limitations: string[];
};

/** SBPL string literal. */
export const sbplString = (s: string): string => `"${s.replace(/(["\\])/g, '\\$1')}"`;

const subpath = (p: string) => `(subpath ${sbplString(p)})`;

export function seatbeltProfile(spec: SandboxSpec, realHome = homedir()): SeatbeltPlan {
  const limitations: string[] = [
    'sin espacio de nombres de procesos: un proceso que llame a setsid sobrevive a la detención del grupo',
    'sin tmpfs: el HOME falso debe ser una carpeta nueva y privada por lanzamiento',
  ];
  const readable = [spec.workspace, spec.home, spec.helperDir, ...spec.readOnly, ...spec.mounts.map((m) => m.src)];
  const writable = [...(spec.workspaceReadOnly ? [] : [spec.workspace]), spec.home, ...spec.mounts.filter((m) => m.rw).map((m) => m.src), '/private/tmp', '/private/var/folders'];
  for (const m of spec.mounts) if (m.src !== m.dest) limitations.push(`no se puede montar ${m.src} en ${m.dest}: el agente usa la ruta real`);

  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    // Reads: the whole system, except the real HOME (other projects, keys, other logins)…
    '(allow file-read*)',
    `(deny file-read* ${subpath(realHome)})`,
    // …where only what the launch needs is visible again.
    `(allow file-read* ${[...new Set(readable)].map(subpath).join(' ')})`,
    `(allow file-write* ${[...new Set(writable)].map(subpath).join(' ')})`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/tty"))',
  ];
  const env: Record<string, string> = { FORJA_HELPER_DIR: spec.helperDir };
  if (spec.proxySocket) {
    // No network except the pinned proxy's unix socket (bwrap: --unshare-net + bind).
    lines.push(`(allow network-outbound (remote unix-socket (path-literal ${sbplString(spec.proxySocket)})))`);
    env.FORJA_PROXY_SOCKET = spec.proxySocket;
    limitations.push(`el socket del proxy queda en ${spec.proxySocket}, no en ${SANDBOX_PROXY_SOCKET}`);
  } else {
    lines.push('(allow network*)');
  }
  limitations.push(`las ayudas de Forja quedan en ${spec.helperDir}, no en ${SANDBOX_HELPER_DIR}`);
  return { profile: `${lines.join('\n')}\n`, env, limitations };
}

/** `sandbox-exec` invocation for `argv` (prototype: see seatbeltProfile). */
export function seatbeltArgs(spec: SandboxSpec, argv: string[]): string[] {
  return ['-p', seatbeltProfile(spec).profile, ...argv];
}
