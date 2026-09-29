import { describe, expect, it } from 'vitest';
import type { RunSnapshot, TaskView } from '../../src/run/snapshot.js';
import { fit, painter, sanitize, stripAnsi, visibleWidth, wrap } from '../../src/tui/ansi.js';
import { BoardApp, type BoardSource, hitsOf, type PendingAction } from '../../src/tui/app.js';
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
      account: null,
      summary: null,
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
    eta: null,
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
  planApprovals = 0;
  planSummary() {
    return ['Plan de prueba', 'Ola 1: T-001'];
  }
  approvePlan() {
    this.planApprovals++;
    return 'plan aprobado';
  }
  actions: PendingAction[] = [];
  approvedActions: [string, string][] = [];
  pendingActions() {
    return this.actions;
  }
  approveAction(id: string, hash: string) {
    this.approvedActions.push([id, hash]);
    return `${id} aprobada`;
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
    filter: 'todas',
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

describe('tablero: filtro, búsqueda, diff, dependencias y aprobaciones (MEJORAS 6.x)', () => {
  const setup = (snap = snapshot(TASKS)) => {
    const source = new FakeSource(snap);
    const app = new BoardApp(
      source,
      () => ({ width: 100, height: 30 }),
      () => NOW,
    );
    return { source, app };
  };
  const key = (app: BoardApp, ch: string) => app.handleKey(ch, ch.length === 1 && /[a-z]/i.test(ch) ? { name: ch.toLowerCase() } : {});

  it('el filtro recorre los grupos y la selección indexa la lista filtrada', async () => {
    const { app } = setup();
    await app.refresh();
    await key(app, 'f');
    expect(app.model.filter).toBe('activas');
    let text = app.render(plain).join('\n');
    expect(text).toContain('Tareas (1 de 34) · filtro: en curso');
    await key(app, 'f');
    expect(app.model.filter).toBe('para_ti');
    await app.handleKey(undefined, { name: 'down' });
    await app.handleKey(undefined, { name: 'return' });
    expect(app.model.screen).toMatchObject({ lines: ['detalle T-004'] });
    await key(app, 'q');
    await key(app, 'f');
    await key(app, 'f');
    expect(app.model.filter).toBe('terminadas');
    text = app.render(plain).join('\n');
    const list = text.slice(text.indexOf('Tareas ('), text.indexOf('├', text.indexOf('Tareas (')));
    expect(list).toContain('T-001');
    expect(list).not.toContain('T-002');
  });

  it('responder quita un filtro que esconde la tarea con la pregunta', async () => {
    const { app } = setup();
    await app.refresh();
    for (let i = 0; i < 4; i++) await key(app, 'f');
    expect(app.model.filter).toBe('terminadas');
    await key(app, 'r');
    expect(app.model.filter).toBe('todas');
    expect(app.model.selected).toBe(2);
  });

  it('el diff se colorea y ] [ saltan entre archivos; / busca y n N recorren coincidencias', async () => {
    const { app, source } = setup();
    const diff = ['diff --git a/x.ts b/x.ts', '@@ -1 +1 @@', '-viejo', '+nuevo', ...Array.from({ length: 80 }, (_, i) => ` contexto ${i}`), 'diff --git a/y.ts b/y.ts', '+otro nuevo'];
    source.taskDiff = async () => diff;
    await app.refresh();
    await key(app, 'd');
    const colored = app.render(painter(true)).join('\n');
    expect(colored).toContain('\x1b[32m');
    expect(colored).toContain('\x1b[31m');
    for (const l of app.render(painter(true))) expect(visibleWidth(l)).toBeLessThanOrEqual(100);
    await key(app, ']');
    expect(app.model.screen).toMatchObject({ scroll: 59 }); // clamped: the second file is on the last page;
    await key(app, '[');
    expect(app.model.screen).toMatchObject({ scroll: 0 });

    await key(app, '/');
    await type(app, 'NUEVO');
    await app.handleKey(undefined, { name: 'return' });
    expect(app.model.screen).toMatchObject({ search: 'NUEVO', hits: [3, 85] });
    expect(app.render(plain)[0]).toContain('«NUEVO»: 2');
    await key(app, 'n');
    await key(app, 'n');
    expect(app.model.screen).toMatchObject({ scroll: 3 });
    await key(app, 'N');
    expect((app.model.screen as { scroll: number }).scroll).toBeGreaterThan(3);
  });

  it('hitsOf no distingue mayúsculas', () => {
    expect(hitsOf(['Hola', 'nada', 'HOLA mundo'], 'hola')).toEqual([0, 2]);
  });

  it('g muestra olas, camino crítico y qué espera a qué', async () => {
    const def = (id: string, depende_de: string[] = [], complejidad: 'baja' | 'media' | 'alta' = 'media') => ({
      id,
      titulo: `Tarea ${id}`,
      objetivo: '',
      tipo: 'implementacion' as const,
      criterios: [],
      requisitos: [],
      depende_de,
      escribe: ['src/**'],
      lee: [],
      recursos_exclusivos: [],
      complejidad,
      red: false,
      notas: '',
    });
    const snap = snapshot([task('T-001', 'integrada'), task('T-002', 'ejecutando'), task('T-003', 'pendiente'), task('T-004', 'pendiente')]);
    snap.plan = {
      perfil: null,
      supuestos: [],
      spec_hash: 'h',
      tareas: [def('T-001'), def('T-002', ['T-001']), def('T-003', ['T-002'], 'alta'), def('T-004', ['T-001'], 'baja')],
    } as unknown as RunSnapshot['plan'];
    const { app } = setup(snap);
    await app.refresh();
    await key(app, 'g');
    const text = (app.model.screen as { lines: string[] }).lines.join('\n');
    expect(text).toContain('Ola 1: ✔ T-001');
    expect(text).toMatch(/Camino crítico de lo que falta: T-002 → T-003/);
    expect(text).toContain('T-003 espera a T-002');
    expect(text).toContain('  T-002 → T-003');
  });

  it('muestra el tiempo restante estimado en el progreso', () => {
    const snap = snapshot(TASKS);
    snap.eta = { minutos: 42.4, factor: 1.3, medidas: 3, paralelo: 2 };
    const m: BoardModel = { project: 'p', snapshot: snap, selected: 0, runLog: [], runnerAlive: true, screen: { kind: 'principal' }, prompt: null, flash: null, now: NOW, filter: 'todas' };
    expect(renderBoard(m, 140, 40, plain).join('\n')).toContain('≈42 min restantes (estimación ×1.3 según 3 tareas medidas)');
  });

  it('aprobar el plan muestra el resumen y pide confirmación escrita', async () => {
    const snap = snapshot([]);
    snap.pending = [];
    const { app, source } = setup(snap);
    await app.refresh();
    await key(app, 'a');
    expect(app.model.flash).toMatch(/no hay un plan esperando/);
    snap.pending = [{ kind: 'aprobacion', id: 'plan', text: 'el plan espera tu aprobación', action: 'forja aprobar plan' }];
    await key(app, 'a');
    expect(app.model.screen).toMatchObject({ title: 'Plan · aprobar', lines: ['Plan de prueba', 'Ola 1: T-001'] });
    await type(app, 'no');
    await app.handleKey(undefined, { name: 'return' });
    expect(source.planApprovals).toBe(0);
    await key(app, 'a');
    await type(app, 'si');
    await app.handleKey(undefined, { name: 'return' });
    expect(source.planApprovals).toBe(1);
    expect(app.model.screen.kind).toBe('principal');
    expect(app.model.flash).toBe('plan aprobado');
  });

  it('x recorre las acciones propuestas y aprueba sólo lo confirmado, con el hash visto', async () => {
    const { app, source } = setup();
    source.actions = [
      { id: 'acc_1', hash: 'h1', title: 'http.json en tienda', preview: ['peticion: POST https://x/pedidos'] },
      { id: 'acc_2', hash: 'h2', title: 'correo.enviar en correo', preview: ['para: a@b.co'] },
    ];
    await app.refresh();
    await key(app, 'x');
    expect(app.model.screen).toMatchObject({ lines: ['peticion: POST https://x/pedidos'] });
    await type(app, 'si');
    await app.handleKey(undefined, { name: 'return' });
    expect(app.model.screen).toMatchObject({ lines: ['para: a@b.co'] });
    await type(app, 'luego');
    await app.handleKey(undefined, { name: 'return' });
    expect(source.approvedActions).toEqual([['acc_1', 'h1']]);
    expect(app.model.screen.kind).toBe('principal');
    source.actions = [];
    await key(app, 'x');
    expect(app.model.flash).toMatch(/no hay acciones externas/);
  });

  it('p pausa o reanuda la tarea elegida', async () => {
    const { app, source } = setup();
    await app.refresh();
    await app.handleKey(undefined, { name: 'down' });
    await key(app, 'p');
    expect(source.toggles).toEqual(['T-002']);
    expect(app.model.flash).toBe('⏸ T-002');
  });
});
