import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPublishable, type Fetcher, GitHubSettings, githubRepo, PublishError, publishBranch } from '../../src/git/publish.js';

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'forja-publicar-'));
  const remote = join(root, 'remoto.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'uno');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'push', '-q', remote, 'main');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/Jhayro1/demo.git');
  git(repo, 'switch', '-q', '-c', 'forja/entrega/cam_1');
  writeFileSync(join(repo, 'a.txt'), 'dos');
  git(repo, 'commit', '-qam', 'entrega');
  git(repo, 'switch', '-q', 'main');
  return { root, remote, repo };
}

/** A fake GitHub API: records the calls and answers like the real one. */
function fakeGitHub(existing: { html_url: string; number: number }[] = []) {
  const calls: { url: string; method: string; body?: string; auth?: string }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', ...(init.body ? { body: init.body } : {}), ...(init.headers.Authorization ? { auth: init.headers.Authorization } : {}) });
    if (url.endsWith('/user')) return { ok: init.headers.Authorization === 'Bearer github_pat_valido1234567890', status: 401, json: async () => ({ login: 'Jhayro1' }) };
    if ((init.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => existing };
    return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/Jhayro1/demo/pull/7', number: 7 }) };
  };
  return { fetcher, calls };
}

describe('publicar en GitHub: sólo ramas de Forja, a lo sumo un PR', () => {
  it('nunca publica la rama principal ni ramas que no sean de Forja', () => {
    const opts = { prefix: 'forja/', main: 'main' };
    expect(() => checkPublishable('forja/entrega/cam_1', opts)).not.toThrow();
    for (const b of ['main', 'master', 'develop', 'production', 'feature/x', 'forja/../main', 'forja/entrega/a b']) expect(() => checkPublishable(b, opts)).toThrow(PublishError);
    expect(() => checkPublishable('trunk', { prefix: 'forja/', main: 'trunk' })).toThrow(/nunca sube/);
  });

  it('reconoce el repositorio de GitHub en https y ssh', () => {
    expect(githubRepo('https://github.com/Jhayro1/winkstec-erp.git')).toEqual({ owner: 'Jhayro1', repo: 'winkstec-erp' });
    expect(githubRepo('git@github.com:Jhayro1/doko.git')).toEqual({ owner: 'Jhayro1', repo: 'doko' });
    expect(githubRepo('https://gitlab.com/a/b.git')).toBeNull();
  });

  it('sube sólo la rama de entrega, no toca main y abre el PR contra main', async () => {
    const { remote, repo } = setup();
    const mainBefore = git(remote, 'rev-parse', 'main');
    const gh = fakeGitHub();
    const r = await publishBranch({
      repoPath: repo,
      branch: 'forja/entrega/cam_1',
      base: 'main',
      prefix: 'forja/',
      token: 'github_pat_valido1234567890',
      openPr: true,
      title: 'T',
      body: 'B',
      fetcher: gh.fetcher,
      pushUrl: remote,
    });
    expect(git(remote, 'rev-parse', 'forja/entrega/cam_1')).toBe(git(repo, 'rev-parse', 'forja/entrega/cam_1'));
    expect(git(remote, 'rev-parse', 'main')).toBe(mainBefore);
    expect(
      git(remote, 'branch', '--list')
        .split('\n')
        .map((b) => b.replace(/^[* ]+/, ''))
        .sort(),
    ).toEqual(['forja/entrega/cam_1', 'main']);
    expect(r.pr).toEqual({ url: 'https://github.com/Jhayro1/demo/pull/7', numero: 7, nuevo: true });
    const post = gh.calls.find((c) => c.method === 'POST')!;
    expect(JSON.parse(post.body!)).toMatchObject({ head: 'forja/entrega/cam_1', base: 'main' });
    // Nothing in the API calls merges.
    expect(gh.calls.some((c) => /merge/.test(c.url))).toBe(false);
  });

  it('si ya hay un PR abierto lo reutiliza, y nunca sobrescribe cambios ajenos (sin --force)', async () => {
    const { remote, repo, root } = setup();
    const gh = fakeGitHub([{ html_url: 'https://github.com/Jhayro1/demo/pull/3', number: 3 }]);
    const base = {
      repoPath: repo,
      branch: 'forja/entrega/cam_1',
      base: 'main',
      prefix: 'forja/',
      token: 'github_pat_valido1234567890',
      openPr: true,
      title: 'T',
      body: 'B',
      fetcher: gh.fetcher,
      pushUrl: remote,
    };
    expect((await publishBranch(base)).pr).toMatchObject({ numero: 3, nuevo: false });
    // Someone else adds a commit to the remote branch: Forja's next push is refused, not forced.
    const other = join(root, 'otro');
    execFileSync('git', ['clone', '-q', '-b', 'forja/entrega/cam_1', remote, other]);
    writeFileSync(join(other, 'b.txt'), 'ajeno');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'ajeno');
    git(other, 'push', '-q');
    git(repo, 'switch', '-q', 'forja/entrega/cam_1');
    git(repo, 'commit', '-q', '--amend', '-m', 'reescrita');
    git(repo, 'switch', '-q', 'main');
    await expect(publishBranch(base)).rejects.toThrow(/nunca usa --force/);
  });

  it('el token se guarda cifrado, se prueba antes y la variable de entorno manda', async () => {
    const home = mkdtempSync(join(tmpdir(), 'forja-gh-'));
    const gh = fakeGitHub();
    const settings = new GitHubSettings(home, {}, gh.fetcher);
    await expect(settings.save({ token: 'github_pat_invalido123456789' })).rejects.toThrow(/401/);
    const view = await settings.save({ token: 'github_pat_valido1234567890', publicar_al_entregar: false });
    expect(view).toMatchObject({ configurado: true, usuario: 'Jhayro1', publicar_al_entregar: false, abrir_pr: true });
    expect(readFileSync(join(home, 'github.json'), 'utf8')).not.toContain('github_pat_valido1234567890');
    expect(settings.token()).toBe('github_pat_valido1234567890');
    expect(new GitHubSettings(home, { FORJA_GITHUB_TOKEN: 'ghp_env' }).token()).toBe('ghp_env');
    expect((await settings.save({ borrar: true })).configurado).toBe(false);
  });
});
