import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobRunner } from '../../src/cli/jobs.js';
import { CloneError, checkDestination, cloneEnv, cloneRepo, parseRepo } from '../../src/registry/clone.js';
import { ROOT } from '../helpers/engine.js';

describe('clonar desde GitHub', () => {
  it('acepta usuario/repo y https; rechaza SSH, credenciales en la dirección y rutas raras', () => {
    expect(parseRepo('Jhayro1/mi-bodega')).toEqual({ url: 'https://github.com/Jhayro1/mi-bodega.git', host: 'github.com', name: 'mi-bodega' });
    expect(parseRepo('https://github.com/Jhayro1/winkstec-erp.git')).toMatchObject({ url: 'https://github.com/Jhayro1/winkstec-erp.git', name: 'winkstec-erp' });
    expect(parseRepo('https://gitlab.com/grupo/sub/app/')).toMatchObject({ url: 'https://gitlab.com/grupo/sub/app.git', host: 'gitlab.com', name: 'app' });
    expect(() => parseRepo('git@github.com:Jhayro1/forja.git')).toThrow(CloneError);
    expect(() => parseRepo('https://user:token@github.com/a/b')).toThrow(/token/);
    expect(() => parseRepo('https://github.com/a/../b')).toThrow(CloneError);
    expect(() => parseRepo('file:///etc')).toThrow(CloneError);
  });

  it('el token sólo va en variables de git, para ese host, y nunca pregunta', () => {
    const ref = parseRepo('Jhayro1/privado');
    expect(cloneEnv(ref, null)).toEqual({ GIT_TERMINAL_PROMPT: '0' });
    const env = cloneEnv(ref, 'ghp_abcdefghijklmnop');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.split(' ').at(-1)!, 'base64').toString()).toBe('x-access-token:ghp_abcdefghijklmnop');
    expect(() => cloneEnv(ref, 'mal token;')).toThrow(/formato/);
  });

  it('clona sin tocar una carpeta que ya tiene contenido', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forja-clonar-'));
    const src = join(root, 'origen');
    mkdirSync(src);
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: src });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(src, 'a.txt'), 'hola');
    git('add', '-A');
    git('commit', '-qm', 'x');
    const ocupada = join(root, 'ocupada');
    mkdirSync(ocupada);
    writeFileSync(join(ocupada, 'x'), '1');
    expect(() => checkDestination(ocupada)).toThrow(/no está vacía/);
    const ref = { url: `file://${src}`, host: 'local', name: 'origen' };
    const lines: string[] = [];
    await cloneRepo(ref, join(root, 'destino'), { GIT_TERMINAL_PROMPT: '0' }, (l) => lines.push(l));
    expect(readFileSync(join(root, 'destino', 'a.txt'), 'utf8')).toBe('hola');
    await expect(cloneRepo({ ...ref, url: `file://${root}/no-existe` }, join(root, 'otro'), {})).rejects.toThrow(CloneError);
  });

  it('el token pasa al trabajo por el entorno y nunca queda en sus archivos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-trabajos-'));
    const jobs = new JobRunner(dir, join(ROOT, 'dist/cli/job-main.js'));
    const job = jobs.start(
      'clonar',
      { title: 'x', file: process.execPath, args: ['-e', 'console.log(process.env.FORJA_GIT_TOKEN ? "hay token" : "sin token")'], cwd: dir },
      { FORJA_GIT_TOKEN: 'ghp_secreto_de_prueba' },
    );
    for (let i = 0; i < 100 && jobs.view(job.id)?.estado === 'corriendo'; i++) await new Promise((r) => setTimeout(r, 100));
    expect(jobs.output(job.id)).toContain('hay token');
    const files = readdirSync(join(dir, job.id));
    for (const f of files) expect(readFileSync(join(dir, job.id, f), 'utf8')).not.toContain('ghp_secreto_de_prueba');
    expect(existsSync(join(dir, job.id, 'orden.json'))).toBe(true);
  });
});
