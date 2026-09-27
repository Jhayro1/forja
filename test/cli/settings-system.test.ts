import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settingsModule } from '../../src/api/modules/settings.js';
import { type EngineContext, openEngine } from '../../src/cli/engine-context.js';
import { JobRunner } from '../../src/cli/jobs.js';
import { ProviderLogins } from '../../src/cli/provider-login.js';
import { ProjectSettingsBackend } from '../../src/cli/settings-backend.js';
import { MachineSystemBackend } from '../../src/cli/system-backend.js';
import type { Exec } from '../../src/doctor/checks.js';
import { readConfig } from '../../src/registry/config.js';
import { createProject } from '../../src/registry/projects.js';
import { Registry } from '../../src/registry/registry.js';
import { ensureBuilt, ROOT } from '../helpers/engine.js';

let dir = '';
let ctx: EngineContext;
const prevHome = process.env.FORJA_HOME;

beforeAll(() => ensureBuilt());
beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'forja-cfg-')));
  process.env.FORJA_HOME = join(dir, 'home');
  const reg = Registry.open(process.env.FORJA_HOME);
  const { checkout } = await createProject(reg, 'demo', join(dir, 'demo'));
  reg.close();
  ctx = openEngine({ proyecto: checkout.checkout_id });
});
afterEach(() => {
  ctx.close();
  if (prevHome === undefined) delete process.env.FORJA_HOME;
  else process.env.FORJA_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('configuración del proyecto desde el panel', () => {
  it('guarda modelos y paralelo en forja.yaml sin borrar tus comentarios, y reabre el proyecto', () => {
    const path = join(ctx.checkout.path, 'forja.yaml');
    writeFileSync(path, `# mi nota sobre este proyecto\n${readFileSync(path, 'utf8')}`);
    let reloads = 0;
    const b = new ProjectSettingsBackend(ctx, () => reloads++);
    const read = b.read() as { roles: { rol: string; modelos: string[] }[]; paralelo: number; sugerencias: string[] };
    expect(read.roles.map((r) => r.rol)).toEqual(['planeador', 'trabajador', 'complejo', 'revisor']);
    expect(read.sugerencias).toContain('claude:opus');
    b.save({
      roles: { planeador: ['claude:opus[1m]'], trabajador: ['claude:haiku'], complejo: ['claude:sonnet'], revisor: ['claude:sonnet'] },
      esfuerzo: { planeador: 'max', revisor: 'high' },
      paralelo: 5,
    });
    expect(reloads).toBe(1);
    expect(readFileSync(path, 'utf8')).toContain('# mi nota sobre este proyecto');
    const cfg = readConfig(ctx.checkout.path);
    expect(cfg.roles.planeador).toEqual(['claude:opus[1m]']);
    expect(cfg.roles.revisor).toEqual(['claude:sonnet']);
    expect(cfg.esfuerzo).toEqual({ planeador: 'max', revisor: 'high' });
    expect(cfg.ejecucion.paralelo).toBe(5);
    // Sin esfuerzos, la clave desaparece y cada CLI usa su valor por defecto.
    b.save({ roles: cfg.roles, esfuerzo: {}, paralelo: 5 });
    expect(readConfig(ctx.checkout.path).esfuerzo).toEqual({});
    expect(readFileSync(path, 'utf8')).not.toContain('esfuerzo');
  });

  it('ofrece el catálogo completo con los esfuerzos de cada modelo', () => {
    const read = new ProjectSettingsBackend(ctx, () => {}).read() as {
      catalogo: { modelos: { ref: string; esfuerzos: string[]; estado: string }[]; esfuerzos: { id: string }[] };
      roles: { esfuerzo: string | null }[];
    };
    const refs = read.catalogo.modelos.map((m) => m.ref);
    expect(refs).toEqual(expect.arrayContaining(['claude:opus', 'claude:claude-fable-5-1', 'claude:sonnet[1m]', 'codex:gpt-6-sol', 'codex:gpt-6-astra', 'codex:gpt-6-luna']));
    expect(read.catalogo.modelos.find((m) => m.ref === 'codex:gpt-6-luna')!.esfuerzos).not.toContain('ultra');
    expect(read.catalogo.modelos.find((m) => m.ref === 'codex:gpt-5.5')!.estado).toBe('retirandose');
    expect(read.catalogo.esfuerzos.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(read.roles.every((r) => r.esfuerzo === null)).toBe(true);
  });

  it('rechaza modelos con formato inválido sin tocar el archivo', async () => {
    const path = join(ctx.checkout.path, 'forja.yaml');
    const before = readFileSync(path, 'utf8');
    const b = new ProjectSettingsBackend(ctx, () => {});
    expect(() => b.save({ roles: { planeador: ['gpt'], trabajador: ['claude:haiku'], complejo: ['claude:sonnet'], revisor: ['claude:sonnet'] }, esfuerzo: {}, paralelo: 3 })).toThrow(
      /proveedor:modelo/,
    );
    expect(readFileSync(path, 'utf8')).toBe(before);
    // El módulo valida la forma antes de llegar al backend.
    const route = settingsModule(b).routes.find((r) => r.method === 'POST')!;
    const call = (body: object) => route.handler({ body: async () => body } as never);
    await expect(call({ roles: { planeador: [] }, paralelo: 3 })).rejects.toThrow();
    await expect(call({ roles: { planeador: ['a:b'], trabajador: ['a:b'], complejo: ['a:b'], revisor: ['a:b'] }, paralelo: 40 })).rejects.toThrow(/entre 1 y 16/);
    await expect(call({ roles: { planeador: ['a:b'], trabajador: ['a:b'], complejo: ['a:b'], revisor: ['a:b'] }, esfuerzo: { planeador: 'turbo' }, paralelo: 3 })).rejects.toThrow(
      /esfuerzo de «planeador»/,
    );
  });
});

describe('sistema: diagnóstico, instalación e inicio de sesión', () => {
  const exec =
    (logged: () => boolean): Exec =>
    async (file, args) => {
      const k = [file, ...args].join(' ');
      if (k === 'git --version') return { code: 0, stdout: 'git version 2.4', stderr: '' };
      if (k === 'bwrap --version') return { code: 0, stdout: 'bubblewrap 0.9', stderr: '' };
      if (k === 'claude --version') return { code: 0, stdout: '2.1 (Claude Code)', stderr: '' };
      if (k === 'claude auth status') return { code: 0, stdout: JSON.stringify({ loggedIn: logged(), authMethod: 'claude.ai' }), stderr: '' };
      return { code: 127, stdout: '', stderr: '' };
    };

  it('diagnostica, instala con el npm de este Node y refresca tras iniciar sesión', async () => {
    let logged = false;
    const npmFake = join(dir, 'npm-falso.sh');
    writeFileSync(npmFake, '#!/bin/sh\necho "instalando $@"\n', { mode: 0o755 });
    const jobs = new JobRunner(join(dir, 'trabajos'), join(ROOT, 'dist/cli/job-main.js'));
    const logins = new ProviderLogins({ claude: { file: process.execPath, args: ['-e', 'process.exit(0)'], asksCode: true }, codex: { file: 'no-existe', args: [], asksCode: false } });
    const sys = new MachineSystemBackend(
      dir,
      logins,
      exec(() => logged),
      jobs,
      npmFake,
    );
    const first = (await sys.overview(false)) as { estado: string; checks: { id: string; level: string }[] };
    expect(first.checks.find((c) => c.id === 'claude')?.level).toBe('aviso');

    const job = sys.install('claude') as { id: string };
    const end = Date.now() + 8000;
    while ((sys.job(job.id) as { trabajo: { estado: string } }).trabajo.estado === 'corriendo' && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect((sys.job(job.id) as { salida: string[] }).salida.join(' ')).toContain('install -g --no-audit --no-fund @anthropic-ai/claude-code');

    sys.login('claude');
    logged = true;
    const until = Date.now() + 3000;
    while (logins.get('claude')?.estado !== 'listo' && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    const after = (await sys.overview(false)) as { checks: { id: string; level: string }[] };
    expect(after.checks.find((c) => c.id === 'claude')?.level).toBe('ok');
    sys.close();
  });
});
