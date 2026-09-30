import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

/**
 * Cloning a repository into Forja's projects folder (v3: «Clonar desde GitHub»).
 * Only HTTPS remotes: on a server the `forja` user has no SSH keys. A token for a private
 * repository travels ONLY in the git process environment (GIT_CONFIG_*), never in the
 * command line, the job files on disk or the repository's config.
 */
export class CloneError extends Error {}

const SHORT = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;
const HTTPS = /^https:\/\/([A-Za-z0-9.-]+(?::\d{1,5})?)\/([A-Za-z0-9._\-/]+?)(?:\.git)?\/?$/;

export type RepoRef = { url: string; host: string; name: string };

/** `usuario/repo`, `https://github.com/usuario/repo` or `…/repo.git`. */
export function parseRepo(input: string): RepoRef {
  const text = input.trim();
  const short = SHORT.exec(text);
  if (short) {
    const name = short[2]!.replace(/\.git$/, '');
    return { url: `https://github.com/${short[1]}/${name}.git`, host: 'github.com', name };
  }
  if (/^https:\/\/[^/]*@/.test(text)) throw new CloneError('no pongas usuario ni token dentro de la dirección: usa el campo del token');
  const m = HTTPS.exec(text);
  if (!m) throw new CloneError('usa una dirección https (https://github.com/usuario/repo) o usuario/repo; las direcciones SSH (git@…) no sirven en el servidor');
  const path = m[2]!;
  if (path.split('/').includes('..')) throw new CloneError('dirección no válida');
  const name = path.split('/').filter(Boolean).at(-1)!;
  return { url: `https://${m[1]}/${path}.git`, host: m[1]!, name };
}

/** Environment for git: never prompts, and authenticates only this host with the token (if any). */
export function cloneEnv(ref: RepoRef, token: string | null | undefined): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    if (!/^[A-Za-z0-9_\-.]{10,255}$/.test(token)) throw new CloneError('el token no tiene el formato esperado');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.https://${ref.host}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

export function checkDestination(dest: string): void {
  if (existsSync(dest) && readdirSync(dest).length > 0) throw new CloneError(`${dest} ya existe y no está vacía: elige otra carpeta o impórtala como proyecto existente`);
}

/** `git clone` streaming its progress to `onLine`; resolves when it succeeds. */
export function cloneRepo(ref: RepoRef, dest: string, env: Record<string, string>, onLine: (line: string) => void = () => {}): Promise<void> {
  checkDestination(dest);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--progress', ref.url, dest], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/[\r\n]+/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.on('error', (e) => reject(new CloneError(`no se pudo ejecutar git: ${e.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new CloneError(code === 128 ? 'git no pudo clonar: revisa la dirección, y si el repositorio es privado, el token' : `git terminó con código ${code}`)),
    );
  });
}
