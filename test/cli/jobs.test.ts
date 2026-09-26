import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobRunner } from '../../src/cli/jobs.js';
import { ensureBuilt, ROOT } from '../helpers/engine.js';

const WATCHER = join(ROOT, 'dist/cli/job-main.js');
let dir = '';
let runner: JobRunner;
const node = (code: string, title = 'prueba') => ({ title, file: process.execPath, args: ['-e', code], cwd: dir });

async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('no se cumplió a tiempo');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(() => ensureBuilt());
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'forja-jobs-')));
  runner = new JobRunner(join(dir, 'trabajos'), WATCHER);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('trabajos del panel', () => {
  it('corre un comando, guarda la salida sin colores y el resultado', async () => {
    const job = runner.start('prueba', node("console.log('\\x1b[32muno\\x1b[0m'); console.error('dos'); process.stdout.write('\\rtres\\n')"));
    expect(job.estado).toBe('corriendo');
    await until(() => runner.view(job.id)!.estado !== 'corriendo');
    expect(runner.view(job.id)).toMatchObject({ estado: 'ok', codigo: 0, ultima_linea: 'tres' });
    expect(runner.output(job.id)).toEqual(['uno', 'dos', 'tres']);
  });

  it('un código de salida distinto de cero es error', async () => {
    const job = runner.start('prueba', node('process.exit(3)'));
    await until(() => runner.view(job.id)!.estado !== 'corriendo');
    expect(runner.view(job.id)).toMatchObject({ estado: 'error', codigo: 3 });
  });

  it('un solo trabajo a la vez; cancelar pide un cierre ordenado (SIGINT)', async () => {
    const job = runner.start('largo', node("process.on('SIGINT', () => { console.log('cerrando en orden'); process.exit(0) }); setInterval(() => {}, 1000); console.log('listo')"));
    expect(() => runner.start('otro', node('0'))).toThrow(/ya hay un trabajo en curso/);
    await until(() => runner.output(job.id).includes('listo'));
    runner.cancel(job.id);
    await until(() => runner.view(job.id)!.estado !== 'corriendo');
    expect(runner.view(job.id)!.estado).toBe('cancelado');
    expect(runner.output(job.id)).toContain('cerrando en orden');
    expect(() => runner.cancel(job.id)).toThrow(/ya terminó/);
  });

  it('forzar mata al comando aunque ignore SIGINT', async () => {
    const job = runner.start('terco', node("process.on('SIGINT', () => {}); setInterval(() => {}, 1000); console.log('listo')"));
    await until(() => runner.output(job.id).includes('listo'));
    runner.cancel(job.id, true);
    await until(() => runner.view(job.id)!.estado !== 'corriendo');
    expect(runner.view(job.id)!.estado).toBe('cancelado');
  });

  it('otro panel (o el mismo reiniciado) ve el estado real desde los archivos', async () => {
    const job = runner.start('prueba', node("setTimeout(() => console.log('fin'), 300)"));
    const other = new JobRunner(join(dir, 'trabajos'), WATCHER);
    expect(other.list().map((j) => j.id)).toEqual([job.id]);
    await until(() => other.view(job.id)!.estado === 'ok');
    expect(() => other.view('../../etc')).toThrow(/inválido/);
  });
});
