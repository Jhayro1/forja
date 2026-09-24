import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createEngine } from '../../src/core/engine.js';
import { readConfig } from '../../src/registry/config.js';
import { checkoutDir } from '../../src/registry/home.js';
import { EventStore } from '../../src/store/event-store.js';
import { HAS_BWRAP, ROOT, ensureBuilt } from '../helpers/engine.js';
import { FILES, seedApprovedPlanIn, sh } from '../run/fixture.js';

/**
 * The real binary, end to end: run → question → estado/preguntas → responder →
 * run again → delivered, with scripted agents in the real sandbox. The same
 * flow as the bodega demo, without spending quota.
 */
const CLI = join(ROOT, 'dist/cli/main.js');
let dir = '';
let home = '';
let repo = '';
let changeId = '';
let simFile = '';

function forja(...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], {
    cwd: repo || dir,
    env: { ...process.env, FORJA_HOME: home, FORJA_SIMULACION: simFile, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 240_000,
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const json = (r: { out: string }) => JSON.parse(r.out) as Record<string, any>;

describe.skipIf(!HAS_BWRAP)('forja run por el CLI (agentes simulados en sandbox)', () => {
  beforeAll(async () => {
    ensureBuilt();
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'forja-cli-')));
    home = join(dir, 'home');
    simFile = join(dir, 'guion.json');
    const write = (taskId: string) => ({ pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' });
    writeFileSync(
      simFile,
      JSON.stringify({
        tareas: {
          'T-001': [write('T-001')],
          'T-002': [write('T-002')],
          'T-003': [{ cuando_contiene: 'Sí, con dos decimales', ...write('T-003') }, { pasos: [], resultado: 'NECESITA_ACLARACION: ¿Se permiten montos con decimales?' }],
          'T-004': [write('T-004')],
          'T-005': [write('T-005')],
        },
      }),
    );
    const created = forja('nuevo', 'bodega', '--ruta', join(dir, 'bodega'), '--json');
    expect(created.code, created.err).toBe(0);
    repo = json(created).proyecto.path;
    const checkoutId = json(created).proyecto.checkout_id;
    // Every role on the scripted provider (a real user would keep claude/codex).
    const yamlPath = join(repo, 'forja.yaml');
    const cfg = YAML.parse(readFileSync(yamlPath, 'utf8'));
    cfg.roles = { planeador: ['simulado:sim'], trabajador: ['simulado:sim'], complejo: ['simulado:sim'], revisor: ['simulado:sim'] };
    writeFileSync(yamlPath, YAML.stringify(cfg));
    const store = EventStore.open(join(checkoutDir(home, checkoutId), 'estado.db'), checkoutId);
    const engine = createEngine({ store, dataDir: checkoutDir(home, checkoutId), config: readConfig(repo) });
    ({ changeId } = await seedApprovedPlanIn(engine, repo));
    store.close();
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('estima sin ejecutar y muestra el estado antes de empezar', () => {
    const est = forja('run', '--estimar');
    expect(est.code, est.err).toBe(0);
    expect(est.out).toContain('no se ejecutó nada');
    expect(est.out).toMatch(/Ola 1:\n\s+T-001/);
    const st = json(forja('--json', 'estado'));
    expect(st.run).toBeNull();
    expect(st.siguiente).toBe('forja run');
    expect(forja('run', '--paralelo', '0').code).toBe(2);
  });

  it('una pregunta detiene sólo su tarea; se ve en estado y preguntas; se responde y se entrega', () => {
    const main = sh(repo, 'rev-parse', 'main');
    const solo = forja('run', '--solo', 'T-003');
    expect(solo.code).toBe(3);
    expect(solo.err).toContain('T-003 depende de tareas sin integrar (T-002)');
    const paused = forja('pausar', 'T-002');
    expect(paused.code, paused.err).toBe(0);
    expect(paused.out).toContain('⏸ T-002 pausada.');
    expect(forja('preguntas').out).toContain('T-002 · tarea pausada');
    expect(forja('reanudar', 'T-002').out).toContain('▶ T-002 reanudada (pendiente).');
    expect(forja('reanudar', 'T-002').code).toBe(3);
    expect(forja('reasignar', 'T-002', 'claude:opus').err).toContain('no está permitido por la política');
    expect(forja('reasignar', 'T-002', 'simulado:sim').code).toBe(0);
    expect(forja('reasignar', 'T-002', '--quitar').out).toContain('vuelve al orden de su rol');
    expect(forja('proveedores').out).toContain('Ningún proveedor en pausa.');
    const first = forja('run', '--paralelo', '2');
    expect(first.code, `${first.out}\n${first.err}`).toBe(3);
    expect(first.out).toMatch(/\? T-003 pregunta: ¿Se permiten montos con decimales\?/);
    expect(first.out).toContain('Pendiente de ti (1)');
    expect(first.out).toContain('forja responder T-003');
    expect(first.out).toContain('Siguiente paso: atiende lo pendiente (forja preguntas)');

    const st = json(forja('--json', 'estado'));
    expect(st.run.estado).toBe('bloqueado');
    expect(st.run.activo).toBe(false);
    expect(st.progreso.por_estado).toEqual({ integrada: 4, esperando_respuesta: 1 });
    expect(st.tareas.find((t: { id: string }) => t.id === 'T-003').pregunta).toBe('¿Se permiten montos con decimales?');

    const text = forja('estado');
    expect(text.out).toMatch(/\? T-003 +Registrar fiado +pregunta para ti/);
    expect(text.out).toContain('Siguiente paso: atiende lo pendiente');

    const q = forja('preguntas');
    expect(q.out).toContain('T-003 · pregunta de un agente');
    expect(forja('tarea', 't-003').out).toContain('Pregunta del agente:');
    expect(forja('logs', 'T-001').out).toMatch(/⚙ Write src\/contratos\.mjs/);
    expect(forja('reintentar', 'T-003').code).toBe(3);
    expect(forja('detener').code).toBe(3);
    expect(forja('informe').code).toBe(3);
    expect(forja('tarea', 'T-999').code).toBe(2);

    const answered = forja('responder', 'T-003', 'Sí,', 'con', 'dos', 'decimales');
    expect(answered.code, answered.err).toBe(0);
    expect(answered.out).toContain('Retoma la ejecución con: forja run');
    expect(json(forja('--json', 'preguntas')).pendientes).toEqual([]);

    const second = forja('run');
    expect(second.code, `${second.out}\n${second.err}`).toBe(0);
    expect(second.out).toContain('↺ se retoma el run');
    expect(second.out).toContain(`5/5 tareas integradas en forja/entrega/${changeId}`);
    expect(sh(repo, 'rev-parse', 'main')).toBe(main);
    expect(sh(repo, 'show', `forja/entrega/${changeId}:src/uc-001.mjs`)).toContain('saldo + monto');

    const done = json(forja('--json', 'estado'));
    expect(done.cambio.fase).toBe('entregado');
    expect(done.entrega).toBe(`forja/entrega/${changeId}`);
    expect(forja('informe').out).toContain('| T-003 Registrar fiado | integrada |');
    expect(forja('run').code).toBe(3);
  }, 300_000);
});
