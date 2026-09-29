import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { decryptLocal, encryptLocal } from '../security/local-secret.js';
import { git } from './git.js';

/**
 * Publishing a sprint's delivery to GitHub (v3 · V3-620), with fixed limits:
 *  - only Forja's own branches (`<prefijo>…`, e.g. `forja/entrega/<sprint>`) are pushed;
 *  - never the main branch, never `--force`, never a merge: at most a pull request;
 *  - the token is stored encrypted and travels only in the git process environment.
 */
export class PublishError extends Error {}

const Stored = z
  .object({
    token_cifrado: z.string().nullable(),
    usuario: z.string().nullable().default(null),
    /** When a sprint is delivered: push its branch and open the PR, without asking. */
    publicar_al_entregar: z.boolean().default(true),
    abrir_pr: z.boolean().default(true),
  })
  .strict();
type Stored = z.infer<typeof Stored>;

export type GitHubView = { configurado: boolean; usuario: string | null; publicar_al_entregar: boolean; abrir_pr: boolean; desde_entorno: boolean };

export type Fetcher = (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const API = 'https://api.github.com';

export class GitHubSettings {
  private readonly file: string;

  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
  ) {
    this.file = join(home, 'github.json');
  }

  private stored(): Stored | null {
    if (!existsSync(this.file)) return null;
    try {
      return Stored.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return null;
    }
  }

  private write(s: Stored): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** The token to use: FORJA_GITHUB_TOKEN wins over the saved one. */
  token(): string | null {
    if (this.env.FORJA_GITHUB_TOKEN) return this.env.FORJA_GITHUB_TOKEN;
    const s = this.stored();
    return s?.token_cifrado ? decryptLocal(this.home, s.token_cifrado) : null;
  }

  view(): GitHubView {
    const s = this.stored();
    return {
      configurado: Boolean(this.token()),
      usuario: s?.usuario ?? null,
      publicar_al_entregar: s?.publicar_al_entregar ?? true,
      abrir_pr: s?.abrir_pr ?? true,
      desde_entorno: Boolean(this.env.FORJA_GITHUB_TOKEN),
    };
  }

  /** Who the token belongs to: proves it works before saving it. */
  async whoami(token: string): Promise<string> {
    const r = await this.fetcher(`${API}/user`, { headers: headers(token) });
    if (!r.ok) throw new PublishError(r.status === 401 ? 'GitHub rechazó el token (401): revisa que esté bien copiado y no haya vencido' : `GitHub respondió ${r.status}`);
    return String(((await r.json()) as { login?: string }).login ?? '?');
  }

  /** Saves the options; a new token is checked against GitHub first. Empty token = keep the saved one; `borrar` removes it. */
  async save(input: { token?: string | null; borrar?: boolean; publicar_al_entregar?: boolean; abrir_pr?: boolean }): Promise<GitHubView> {
    const prev = this.stored() ?? { token_cifrado: null, usuario: null, publicar_al_entregar: true, abrir_pr: true };
    const next: Stored = { ...prev };
    if (input.borrar) {
      next.token_cifrado = null;
      next.usuario = null;
    } else if (input.token?.trim()) {
      const token = input.token.trim();
      if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new PublishError('ese token no tiene el formato de GitHub (ghp_…, github_pat_…)');
      next.usuario = await this.whoami(token);
      next.token_cifrado = encryptLocal(this.home, token);
    }
    if (input.publicar_al_entregar !== undefined) next.publicar_al_entregar = input.publicar_al_entregar;
    if (input.abrir_pr !== undefined) next.abrir_pr = input.abrir_pr;
    this.write(next);
    return this.view();
  }
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'forja' };
}

/** owner/repo of a GitHub remote, in https or ssh form; null for any other host. */
export function githubRepo(remote: string): { owner: string; repo: string } | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** The ONLY branches Forja may push: its own, never the main one. */
export function checkPublishable(branch: string, opts: { prefix: string; main: string }): void {
  const reserved = new Set([opts.main, 'main', 'master', 'develop', 'production', 'produccion']);
  if (reserved.has(branch)) throw new PublishError(`Forja nunca sube a «${branch}»: sólo publica sus propias ramas`);
  if (!branch.startsWith(opts.prefix) || branch.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new PublishError(`sólo se publican ramas de Forja (${opts.prefix}…), no «${branch}»`);
}

export type PublishResult = { rama: string; commit: string; repositorio: string; pr: { url: string; numero: number; nuevo: boolean } | null };

/**
 * Pushes `branch` (fast-forward only: no --force) and, if asked, opens a PR against `base`
 * or returns the one already open. Never merges and never touches `base`.
 */
export async function publishBranch(input: {
  repoPath: string;
  branch: string;
  base: string;
  prefix: string;
  token: string;
  openPr: boolean;
  title: string;
  body: string;
  fetcher?: Fetcher;
  /** Where to push (tests); by default the GitHub https address of `origin`. */
  pushUrl?: string;
}): Promise<PublishResult> {
  checkPublishable(input.branch, { prefix: input.prefix, main: input.base });
  const fetcher = input.fetcher ?? ((u, i) => fetch(u, i));
  const origin = (await git(input.repoPath, ['remote', 'get-url', 'origin'], { allowFail: true })).stdout.trim();
  const gh = githubRepo(origin);
  if (!gh && !input.pushUrl) throw new PublishError(origin ? `el remoto origin (${origin}) no es de GitHub` : 'el repositorio no tiene remoto origin');
  const commit = (await git(input.repoPath, ['rev-parse', '--verify', `refs/heads/${input.branch}`], { allowFail: true })).stdout.trim();
  if (!commit) throw new PublishError(`no existe la rama ${input.branch}`);
  const url = input.pushUrl ?? `https://github.com/${gh!.owner}/${gh!.repo}.git`;
  const env = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.token}`).toString('base64')}`,
  };
  // Exactly one refspec, this branch onto the same name: nothing else can be pushed.
  const push = await git(input.repoPath, ['push', '--porcelain', url, `refs/heads/${input.branch}:refs/heads/${input.branch}`], { allowFail: true, env });
  if (push.code !== 0) {
    const why = `${push.stderr}${push.stdout}`;
    if (/non-fast-forward|rejected|fetch first/i.test(why)) throw new PublishError(`GitHub ya tiene la rama ${input.branch} con otros cambios: Forja no la sobrescribe (nunca usa --force)`);
    if (/403|denied|Authentication|could not read Username/i.test(why))
      throw new PublishError('GitHub no aceptó el token para subir: necesita permiso de «Contents: read and write» en ese repositorio');
    throw new PublishError(`git push falló: ${why.trim().split('\n').at(-1)?.slice(0, 200) ?? ''}`);
  }
  if (!input.openPr || !gh) return { rama: input.branch, commit, repositorio: gh ? `${gh.owner}/${gh.repo}` : url, pr: null };
  const base = `${API}/repos/${gh.owner}/${gh.repo}/pulls`;
  const open = await fetcher(`${base}?state=open&head=${encodeURIComponent(`${gh.owner}:${input.branch}`)}`, { headers: headers(input.token) });
  if (open.ok) {
    const list = (await open.json()) as { html_url: string; number: number }[];
    if (list[0]) return { rama: input.branch, commit, repositorio: `${gh.owner}/${gh.repo}`, pr: { url: list[0].html_url, numero: list[0].number, nuevo: false } };
  }
  const created = await fetcher(base, {
    method: 'POST',
    headers: { ...headers(input.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: input.title.slice(0, 250), head: input.branch, base: input.base, body: input.body.slice(0, 60_000), maintainer_can_modify: true }),
  });
  if (!created.ok) {
    const detail = (await created.json().catch(() => ({}))) as { message?: string; errors?: { message?: string }[] };
    throw new PublishError(
      `la rama se subió, pero GitHub no creó el PR (${created.status}): ${detail.errors?.[0]?.message ?? detail.message ?? ''}. Revisa el permiso «Pull requests: read and write» del token`,
    );
  }
  const pr = (await created.json()) as { html_url: string; number: number };
  return { rama: input.branch, commit, repositorio: `${gh.owner}/${gh.repo}`, pr: { url: pr.html_url, numero: pr.number, nuevo: true } };
}
