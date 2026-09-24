import { describe, expect, it } from 'vitest';
import type { RunSnapshot, TaskView } from '../../src/run/snapshot.js';
import { fit, painter, sanitize, stripAnsi, visibleWidth, wrap } from '../../src/tui/ansi.js';
import { BoardApp, type BoardSource } from '../../src/tui/app.js';
import { type BoardModel, renderBoard, windowAround } from '../../src/tui/board.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');

function task(id: string, state: TaskView['state'], extra: Partial<TaskView['exec']> = {}, activity: TaskView['activity'] = null): TaskView {
  return {
    id,
    title: `Tarea ${id}`,
    state,
    kind: 'implementacion',
    dependsOn: [],
    activity,
    exec: {
      run_id: 'run_1',
      task_id: id,
      attempt: 1,
      quality_failures: 0,
      env_failures: 0,
      level: 'trabajador',
      launch_id: null,
      launch_dir: null,
      worktree: null,
      provider: 'claude',
      model: 'haiku',
      base_sha: null,
      candidate_sha: null,
      integrated_sha: null,
      files: null,
      feedback: null,
      last_error: null,
      question: null,
      answer: null,
      steps: null,
      control: null,
      pinned_model: null,
      ...extra,
    },
  };
}

function snapshot(tasks: TaskView[]): RunSnapshot {
  const counts: RunSnapshot['counts'] = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return {
    change: { change_id: 'cam_1', title: 'Fiados de la bodega', mode: 'idea', phase: 'ejecutar', discovery_revision: 1, spec_revision: 2, plan_revision: 1, created_at: '' },
    plan: null,
    approved: true,
    run: {
      run_id: 'run_01ABCDEFGH',
      change_id: 'cam_1',
      plan_id: 'p',
      plan_revision: 1,
      plan_hash: 'h',
      approval_id: 'a',
      state: 'ejecutando',
      base_sha: 'b',
      branch: 'forja/run/x/integracion',
      detail: null,
      created_at: '',
    },
    tasks,
    counts,
    integrated: counts.integrada ?? 0,
    total: tasks.length,
    pending: tasks
      .filter((t) => t.state === 'esperando_respuesta')
      .map((t) => ({ kind: 'pregunta_tarea' as const, id: t.id, text: t.exec.question ?? '', action: `forja responder ${t.id} "<respuesta>"` })),
    usage: [{ role: 'trabajador', calls: 4, tokens: 96_000, costMicro: null, costKind: 'desconocido' }],
    deliveryBranch: null,
    providerPauses: [],
    demo: false,
    nextStep: 'mira el avance con forja tablero',
  };
}

const TASKS = [
  task('T-001', 'integrada', { integrated_sha: 'abcdef1234567' }),
  task('T-002', 'ejecutando', {}, { current: 'Write src/api.ts', startedAt: '2026-09-24T11:57:46Z', lastAt: null, tokens: 8100, tokensKind: 'medido' }),
  task('T-003', 'esperando_respuesta', { question: '¿Redondeo a dos decimales?' }),
  task('T-004', 'bloqueada', { last_error: 'falló 3 veces: pruebas' }),
  ...Array.from({ length: 30 }, (_, i) => task(`T-${String(10 + i).padStart(3, '0')}`, 'pendiente')),
];

class FakeSource implements BoardSource {
  readonly project = 'mi-bodega';
  answers: [string, string][] = [];
  retries: [string, string | null][] = [];
  stops = 0;
  alive = true;
  constructor(public snap: RunSnapshot) {}
  snapshot() {
    return this.snap;
  }
  runLog() {
    return ['12:00:00 ▶ T-002 empezó'];
  }
  runnerAlive() {
    return this.alive;
  }
  taskDetail(t: TaskView) {
    return [`detalle ${t.id}`];
  }
  taskLog(t: TaskView) {
    return Array.from({ length: 100 }, (_, i) => `${t.id} línea ${i}`);
  }
  taskContext() {
    return ['instrucciones'];
  }
  async taskDiff() {
    return ['diff'];
  }
  answer(t: TaskView, text: string) {
    this.answers.push([t.id, text]);
  }
  retry(t: TaskView, note: string | null) {
    this.retries.push([t.id, note]);
  }
  toggles: string[] = [];
  togglePause(t: TaskView) {
    this.toggles.push(t.id);
    return `⏸ ${t.id}`;
  }
  stop() {
    this.stops++;
    return 'detenido';
  }
}

const plain = painter(false);
const type = async (app: BoardApp, text: string) => {
  for (const ch of text) await app.handleKey(ch, {});
};

describe('utilidades de terminal', () => {
  it('ajusta al ancho visible sin romper colores', () => {
    const colored = painter(true)('hola mundo', 'green');
    expect(visibleWidth(colored)).toBe(10);
    expect(stripAnsi(fit(colored, 6))).toBe('hola …');
    expect(fit(colored, 6).endsWith('\x1b[0m')).toBe(true);
    expect(fit('abc', 5)).toBe('abc  ');
    expect(fit('abcdef', 0)).toBe('');
    expect(wrap('abcdef\n\nxy', 4)).toEqual(['abcd', 'ef', '', 'xy']);
  });

  it('limpia secuencias de control de textos ajenos (logs, preguntas)', () => {
    expect(sanitize('ok\x1b[2J\x1b[Hfalso\x07\tfin')).toBe('okfalso  fin');
  });

  it('mantiene visible la fila elegida', () => {
    expect(windowAround(5, 3, 10)).toEqual([0, 5]);
    expect(windowAround(100, 0, 10)).toEqual([0, 10]);
    expect(windowAround(100, 50, 10)).toEqual([45, 55]);
    expect(windowAround(100, 99, 10)).toEqual([90, 100]);
  });
});

describe('tablero', () => {
  const model = (over: Partial<BoardModel> = {}): BoardModel => ({
    project: 'mi-bodega',
    snapshot: snapshot(TASKS),
    selected: 0,
    runLog: ['12:00:00 ▶ T-002 empezó'],
    runnerAlive: true,
    screen: { kind: 'principal' },
    prompt: null,
    flash: null,
    now: NOW,
    ...over,
  });

  it.each([
    [80, 24],
    [120, 40],
    [40, 12],
  ])('ocupa exactamente la pantalla (%ix%i)', (w, h) => {
    for (const m of [model(), model({ screen: { kind: 'ayuda' } }), model({ prompt: { label: 'Respuesta:', value: 'sí' } })]) {
      const lines = renderBoard(m, w, h, plain);
      expect(lines).toHaveLength(h);
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
    }
  });

  it('muestra agentes, estados con texto, lo pendiente y el consumo', () => {
    const text = renderBoard(model(), 120, 40, plain).join('\n');
    expect(text).toContain('Forja · mi-bodega · Fiados de la bodega');
    expect(text).toContain('Ejecutar ●');
    expect(text).toContain('1/34 integradas · 1 agente(s) trabajando');
    expect(text).toMatch(/▶ T-002 .*claude:haiku .*2m14s 8\.1k tok › Write src\/api\.ts/);
    expect(text).toMatch(/\? pregunta para ti/);
    expect(text).toMatch(/✘ bloqueada/);
    expect(text).toContain('Pendiente de ti (1)');
    expect(text).toContain('forja responder T-003');
    expect(text).toContain('trabajador 96.0k tok (4)');
    expect(text).toContain('[q] salir');
  });

  it('en 80 columnas las teclas esenciales siguen visibles', () => {
    const footer = renderBoard(model(), 80, 24, plain).at(-1)!;
    expect(footer).toContain('[q] salir');
    expect(footer).toContain('[?] ayuda');
  });

  it('sin cambios invita a planear', () => {
    const text = renderBoard(model({ snapshot: null }), 80, 24, plain).join('\n');
    expect(text).toContain('forja planear');
  });
});

describe('teclado del tablero', () => {
  const setup = () => {
    const source = new FakeSource(snapshot(TASKS));
    const app = new BoardApp(
      source,
      () => ({ width: 100, height: 30 }),
      () => NOW,
    );
    return { source, app };
  };

  it('navega, abre detalle y logs que siguen el final, y vuelve', async () => {
    const { app } = setup();
    await app.refresh();
    await app.handleKey(undefined, { name: 'down' });
    await app.handleKey(undefined, { name: 'return' });
    expect(app.model.screen).toMatchObject({ kind: 'texto', lines: ['detalle T-002'] });
    await app.handleKey('q', { name: 'q' });
    expect(app.model.screen.kind).toBe('principal');
    await app.handleKey('l', { name: 'l' });
    const logs = app.model.screen;
    expect(logs).toMatchObject({ kind: 'texto', follow: true });
    expect(app.render(plain).join('\n')).toContain('T-002 línea 99');
    await app.handleKey(undefined, { name: 'pageup' });
    expect(logs).toMatchObject({ follow: false });
    await app.handleKey('g', { name: 'g' });
    expect(app.render(plain).join('\n')).toContain('T-002 línea 0');
    await app.handleKey('G', { name: 'g' });
    expect(logs).toMatchObject({ follow: true });
    await app.handleKey(undefined, { name: 'escape' });
    expect(await app.handleKey('q', { name: 'q' })).toBe(false);
  });

  it('responde la pregunta pendiente aunque la fila elegida sea otra', async () => {
    const { app, source } = setup();
    await app.refresh();
    await app.handleKey('r', { name: 'r' });
    expect(app.model.prompt?.label).toMatch(/Respuesta para T-003/);
    expect(app.model.selected).toBe(2);
    await type(app, 'Sí, dos');
    await app.handleKey(undefined, { name: 'backspace' });
    await type(app, 's');
    await app.handleKey(undefined, { name: 'return' });
    expect(source.answers).toEqual([['T-003', 'Sí, dos']]);
    expect(app.model.flash).toMatch(/respuesta enviada/);
  });

  it('una respuesta vacía no se envía y el error se ve', async () => {
    const { app, source } = setup();
    await app.refresh();
    await app.handleKey('r', { name: 'r' });
    await app.handleKey(undefined, { name: 'return' });
    expect(source.answers).toEqual([]);
    expect(app.model.flash).toMatch(/✘ respuesta vacía/);
  });

  it('reintenta sólo tareas bloqueadas, con nota opcional', async () => {
    const { app, source } = setup();
    await app.refresh();
    await app.handleKey('t', { name: 't' });
    expect(app.model.flash).toMatch(/elige una tarea bloqueada/);
    for (let i = 0; i < 3; i++) await app.handleKey(undefined, { name: 'down' });
    await app.handleKey('t', { name: 't' });
    await app.handleKey(undefined, { name: 'return' });
    expect(source.retries).toEqual([['T-004', null]]);
  });

  it('detener pide confirmación escrita y no hace nada sin run activo', async () => {
    const { app, source } = setup();
    await app.refresh();
    await app.handleKey('s', { name: 's' });
    await type(app, 'no');
    await app.handleKey(undefined, { name: 'return' });
    expect(source.stops).toBe(0);
    await app.handleKey('s', { name: 's' });
    await type(app, 'si');
    await app.handleKey(undefined, { name: 'return' });
    expect(source.stops).toBe(1);
    source.alive = false;
    await app.refresh();
    await app.handleKey('s', { name: 's' });
    expect(app.model.prompt).toBeNull();
    expect(app.model.flash).toMatch(/no hay un forja run activo/);
  });

  it('esc cancela la entrada sin ejecutar nada', async () => {
    const { app, source } = setup();
    await app.refresh();
    await app.handleKey('r', { name: 'r' });
    await type(app, 'algo');
    await app.handleKey(undefined, { name: 'escape' });
    expect(app.model.prompt).toBeNull();
    expect(source.answers).toEqual([]);
    // Ctrl-C always closes, even with a prompt open.
    await app.handleKey('r', { name: 'r' });
    expect(await app.handleKey(undefined, { name: 'c', ctrl: true })).toBe(false);
  });
});
