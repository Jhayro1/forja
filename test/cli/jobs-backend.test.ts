import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type EngineContext, openEngine } from '../../src/cli/engine-context.js';
import { JobRunner } from '../../src/cli/jobs.js';
import { ProjectJobsBackend } from '../../src/cli/jobs-backend.js';
import { createProject } from '../../src/registry/projects.js';
import { Registry } from '../../src/registry/registry.js';
import { ensureBuilt, ROOT } from '../helpers/engine.js';

let dir = '';
let ctx: EngineContext;
const prevHome = process.env.FORJA_HOME;

beforeAll(() => ensureBuilt());
beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'forja-jb-')));
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

describe('trabajos del proyecto', () => {
  it('arma comandos fijos contra este proyecto y no acepta otros', () => {
    const backend = new ProjectJobsBackend(ctx);
    const cmd = backend.command('dividir');
    expect(cmd.file).toBe(process.execPath);
    expect(cmd.args.slice(1)).toEqual(['--proyecto', ctx.checkout.checkout_id, 'dividir']);
    expect(cmd.cwd).toBe(ctx.checkout.path);
    expect(() => backend.command('rm -rf /')).toThrow(/desconocido/);
  });

  it('corre forja de verdad y la salida trae el motivo si falla', async () => {
    const backend = new ProjectJobsBackend(ctx, new JobRunner(join(ctx.dataDir, 'trabajos'), join(ROOT, 'dist/cli/job-main.js')), join(ROOT, 'dist/cli/bin.js'));
    const job = backend.start('dividir') as { id: string };
    const end = Date.now() + 20_000;
    let r = backend.get(job.id)!;
    while ((r.trabajo as { estado: string }).estado === 'corriendo' && Date.now() < end) {
      await new Promise((res) => setTimeout(res, 100));
      r = backend.get(job.id)!;
    }
    expect(r.trabajo).toMatchObject({ estado: 'error', titulo: 'Dividir en tareas' });
    expect(r.salida.join('\n')).toMatch(/no hay un cambio en curso/);
  });

  it('un bloque para un agente corre forja run --tareas con el modelo elegido', async () => {
    const backend = new ProjectJobsBackend(ctx, new JobRunner(join(ctx.dataDir, 'trabajos'), join(ROOT, 'dist/cli/job-main.js')), join(ROOT, 'dist/cli/bin.js'));
    const job = backend.startBlock(['T-001', 'T-003'], 'claude:sonnet') as { id: string; tipo: string; titulo: string };
    expect(job.tipo).toBe('run-bloque');
    expect(job.titulo).toContain('claude:sonnet');
    const end = Date.now() + 20_000;
    let r = backend.get(job.id)!;
    while ((r.trabajo as { estado: string }).estado === 'corriendo' && Date.now() < end) {
      await new Promise((res) => setTimeout(res, 100));
      r = backend.get(job.id)!;
    }
    // Without a plan it cannot run, but it reached «forja run» with the block's options.
    expect(r.salida.join('\n')).toMatch(/no hay un cambio en curso/);
  });
});
