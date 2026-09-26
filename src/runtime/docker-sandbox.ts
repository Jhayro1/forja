import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SANDBOX_HELPER_DIR, SANDBOX_PROXY_SOCKET, type SandboxSpec } from './sandbox.js';

const DOCKERFILE_DIR = fileURLToPath(new URL('../../docker/', import.meta.url));

/**
 * Docker sandbox (ADR-012-aislamiento-docker.md): same isolation contract as `bwrapArgs`,
 * chosen for any host where bwrap isn't available (macOS, Windows with Docker Desktop, or
 * Linux with a broken bwrap). Unlike the Seatbelt and Windows prototypes, this one is real
 * and tested: bind-mounting the host's own Node and provider binaries (`claude`, `codex`)
 * read-only into a plain `debian:bookworm-slim` container and running them directly works
 * (verified by hand: `node --version`, `claude --version`), because a container never sees
 * the host filesystem at all except what's explicitly bound — stronger than bwrap's
 * "mount everything, then hide HOME again", not weaker.
 *
 * `--network none` (only added when a proxy socket is set, exactly like bwrap's
 * `--unshare-net`) plus a bind-mounted unix socket reproduces the "no network except the
 * proxy" contract; both were confirmed working end to end (blocked DNS with `--network
 * none`, a real connect-and-echo through the bind-mounted socket).
 */
export const DEFAULT_SANDBOX_IMAGE = 'forja-sandbox:latest';

/** Real uid/gid of this process, when POSIX ids exist (Linux/macOS host; absent on native Windows). */
export function hostIds(): { uid: number; gid: number } | null {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid !== undefined && gid !== undefined ? { uid, gid } : null;
}

/**
 * `docker run` arguments, ready to run: `-e` per environment variable and the image
 * come last, then the caller only needs to append the inner argv.
 */
export function dockerArgs(spec: SandboxSpec, env: Record<string, string> = {}, image = DEFAULT_SANDBOX_IMAGE): string[] {
  const ids = hostIds();
  const args = ['run', '--rm', '-i', '--init', '--read-only'];
  if (ids) args.push('--user', `${ids.uid}:${ids.gid}`);
  const tmpfsOpts = ids ? `rw,exec,uid=${ids.uid},gid=${ids.gid}` : 'rw,exec';
  args.push('--tmpfs', `/tmp:${tmpfsOpts}`);
  if (spec.home !== '/tmp') args.push('--tmpfs', `${spec.home}:${tmpfsOpts}`);
  for (const dir of spec.readOnly) args.push('-v', `${dir}:${dir}:ro`);
  for (const m of spec.mounts) args.push('-v', `${m.src}:${m.dest}:${m.rw ? 'rw' : 'ro'}`);
  args.push('-v', `${spec.workspace}:${spec.workspace}:${spec.workspaceReadOnly ? 'ro' : 'rw'}`);
  args.push('-v', `${spec.helperDir}:${SANDBOX_HELPER_DIR}:ro`);
  if (spec.proxySocket) args.push('-v', `${spec.proxySocket}:${SANDBOX_PROXY_SOCKET}`, '--network', 'none');
  args.push('-w', spec.workspace);
  args.push(...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]));
  args.push(image);
  return args;
}

/** True once `docker inspect` finds the image (doesn't rebuild every launch). */
export function imageExists(exec: (file: string, args: string[]) => Promise<{ code: number }> = execFileP, image = DEFAULT_SANDBOX_IMAGE): Promise<boolean> {
  return exec('docker', ['image', 'inspect', image]).then((r) => r.code === 0);
}

/** Builds the sandbox image from `docker/sandbox.Dockerfile` if it isn't there yet. */
export async function ensureSandboxImage(
  exec: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = execFileP,
  image = DEFAULT_SANDBOX_IMAGE,
): Promise<{ ok: boolean; detail: string }> {
  if (await imageExists(exec, image)) return { ok: true, detail: 'ya existe' };
  const result = await exec('docker', ['build', '-t', image, '-f', `${DOCKERFILE_DIR}sandbox.Dockerfile`, DOCKERFILE_DIR]);
  return result.code === 0 ? { ok: true, detail: 'construida' } : { ok: false, detail: result.stderr.trim().split('\n').at(-1) ?? 'fallo desconocido' };
}

function execFileP(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 127) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** What this backend cannot guarantee, always returned, never assumed. */
export function dockerLimitations(hasHostIds = hostIds() !== null): string[] {
  const limitations: string[] = [];
  if (!hasHostIds) {
    limitations.push('sin uid/gid de host: el contenedor corre con el usuario por defecto de la imagen, no con tu usuario del sistema');
  }
  limitations.push(
    'depende de que la imagen del sandbox (debian:bookworm-slim) tenga una libc igual o más nueva que la del binario montado; una distro host mucho más nueva que la imagen podría fallar',
  );
  return limitations;
}
