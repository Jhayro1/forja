import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { EnginePlanningBackend } from '../../src/cli/engine-backend.js';
import type { EngineContext } from '../../src/cli/engine-context.js';
import type { Simulation } from '../../src/core/engine.js';
import { ForjaConfig } from '../../src/registry/config.js';
import { testEngine } from '../helpers/engine.js';

const turn = (mensaje: string, extra: object = {}) => ({
  pasos: [],
  estructurado: {
    mensaje_usuario: mensaje,
    observaciones: [],
    propuestas: [],
    preguntas: [],
    preguntas_resueltas: [],
    propuestas_respondidas: [],
    decisiones_propuestas: [],
    cobertura: [],
    contradicciones: [],
    alcance: { incluye: [], excluye: [] },
    resumen_actualizado: '',
    siguiente_paso: 'continuar',
    ...extra,
  },
});

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function backend(sim: Simulation) {
  const t = testEngine(sim);
  cleanup = t.cleanup;
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: t.dir });
  const config = ForjaConfig.parse({ schema_version: 1, project_id: 'prj_01J9Z3K8Q2W7M4X6T5R1V0B8N3', nombre: 'demo', roles: { planeador: ['simulado:sim'] } });
  const ctx = { engine: t.engine, config, checkout: { path: t.dir, checkout_id: 'chk_x' } } as unknown as EngineContext;
  const busy: (string | null)[] = [];
  return { b: new EnginePlanningBackend(ctx, { set: (r) => busy.push(r) }), busy };
}

async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('no se cumplió a tiempo');
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Overview = { chat: { pensando: { texto: string } | null; error: string | null }; cambio: { titulo: string; fase: string } | null; conversacion?: { usuario: string | null; planeador: string }[] };

describe('chat del planeador desde el panel', () => {
  it('crea el cambio, responde en segundo plano y deja el proyecto libre al terminar', async () => {
    const { b, busy } = backend(() => turn('¿Quién registra los fiados?'));
    expect((b.overview() as Overview).cambio).toBeNull();
    expect(b.send('Quiero registrar fiados de clientes', { nuevo: false, cerrar: false })).toMatch(/cambio creado/);
    // The request returns right away; the turn keeps going.
    expect((b.overview() as Overview).chat.pensando?.texto).toBe('Quiero registrar fiados de clientes');
    expect(() => b.send('otra cosa', { nuevo: false, cerrar: false })).toThrow(/todavía está respondiendo/);
    expect(busy).toEqual(['el planeador está respondiendo']);
    await until(() => (b.overview() as Overview).chat.pensando === null);
    const o = b.overview() as Overview;
    expect(o.cambio).toMatchObject({ titulo: 'Quiero registrar fiados de clientes', fase: 'descubrir' });
    expect(o.conversacion?.at(-1)?.planeador).toContain('¿Quién registra los fiados?');
    expect(o.chat.error).toBeNull();
    expect(busy).toEqual(['el planeador está respondiendo', null]);

    b.send('Sólo el dueño', { nuevo: false, cerrar: false });
    await until(() => (b.overview() as Overview).chat.pensando === null);
    expect((b.overview() as Overview).conversacion?.at(-1)?.usuario).toBe('Sólo el dueño');
  });

  it('un error del planeador aparece en el chat y libera el proyecto', async () => {
    const { b, busy } = backend(() => ({ pasos: [], estructurado: { mensaje_usuario: 'incompleto' } }));
    b.send('Una idea', { nuevo: false, cerrar: false });
    await until(() => (b.overview() as Overview).chat.pensando === null);
    expect((b.overview() as Overview).chat.error).toBeTruthy();
    expect(busy.at(-1)).toBeNull();
  });
});
