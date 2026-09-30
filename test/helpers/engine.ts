import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine, type Engine, type Simulation } from '../../src/core/engine.js';
import { newId } from '../../src/domain/ids.js';
import { SimulatedAdapter } from '../../src/providers/adapters.js';
import { ForjaConfig } from '../../src/registry/config.js';
import { EventStore } from '../../src/store/event-store.js';

export const ROOT = resolve(import.meta.dirname, '../..');
export const RUNNER = join(ROOT, 'dist/runtime/runner-main.js');
export const HAS_BWRAP = spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status === 0;

/** dist/ is built once by test/global-setup.ts; this only checks it is there. */
export function ensureBuilt(): void {
  if (!existsSync(join(ROOT, 'dist/cli/main.js'))) execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
}

export function testEngine(simulation: Simulation, roles: Partial<ForjaConfig['roles']> = {}): { engine: Engine; dir: string; cleanup(): void } {
  ensureBuilt();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forja-eng-')));
  const store = EventStore.open(join(dir, 'estado.db'), 'chk_test');
  const sim = ['simulado:sim'];
  const config = ForjaConfig.parse({
    schema_version: 1,
    project_id: newId('prj'),
    nombre: 'prueba',
    roles: { planeador: sim, trabajador: sim, complejo: sim, revisor: sim, integrador: sim, auditor: sim, qa: sim, ...roles },
  });
  const engine = createEngine({
    store,
    dataDir: dir,
    config,
    runnerScript: RUNNER,
    simulation,
    adapters: { simulado: new SimulatedAdapter({ agentDir: join(ROOT, 'dist/providers'), sandbox: HAS_BWRAP }) },
  });
  return {
    engine,
    dir,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
