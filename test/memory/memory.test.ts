import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import { buildGraph, fileId } from '../../src/memory/build.js';
import { evaluateSelectors } from '../../src/memory/evaluate.js';
import { extractPython, resolvePython } from '../../src/memory/extract/python.js';
import { extractTs, resolveTs } from '../../src/memory/extract/typescript.js';
import { GraphStore } from '../../src/memory/graph-store.js';
import { LessonService } from '../../src/memory/lessons.js';
import { graphSelection, simpleSelection } from '../../src/memory/selector.js';
import type { Plan, PlanTask } from '../../src/plan/plan.js';
import { buildWorkerPrompt } from '../../src/run/context.js';
import { Orchestrator, startOrResumeRun } from '../../src/run/orchestrator.js';
import type { Spec } from '../../src/spec/spec.js';
import { EventStore } from '../../src/store/event-store.js';
import { HAS_BWRAP, testEngine } from '../helpers/engine.js';
import { FILES, seedApprovedPlan } from '../run/fixture.js';
import { sampleSpec } from '../spec/fixture.js';

let dir: string;
let closers: (() => void)[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-mem-'));
});
afterEach(() => {
  for (const c of closers.reverse()) c();
  closers = [];
  rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();

function repo(files: Record<string, string>): string {
  const r = join(dir, 'repo');
  mkdirSync(r, { recursive: true });
  git(r, 'init', '-q');
  write(r, files);
  return r;
}
function write(r: string, files: Record<string, string>): void {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(r, p)), { recursive: true });
    writeFileSync(join(r, p), c);
  }
  git(r, 'add', '-A');
}

const TS_APP: Record<string, string> = {
  'src/contratos.ts': 'export type Fiado = { monto: number };\nexport const MONEDA = "PEN";\n',
  'src/dominio/saldo.ts': "import type { Fiado } from '../contratos.js';\nexport function saldo(f: Fiado[]) { return f.reduce((a, x) => a + x.monto, 0); }\n",
  'src/uc-001.ts':
    "// R-001: no se fía a quien debe más de 100\nimport { saldo } from './dominio/saldo.js';\nimport { MONEDA } from './contratos';\nexport async function registrarFiado() { return saldo([]) + MONEDA; }\nclass Interna {}\n",
  'src/api.ts':
    "import express from 'express';\nimport { registrarFiado } from './uc-001.js';\nimport { util } from '@/util';\nimport { nuevo } from './nuevo.js';\nconst m = await import(nombre);\nexport { registrarFiado };\n",
  'src/trampas.ts':
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test, not a template
    "const s = \"import x from 'falso'\";\n// import y from 'comentario'\n/* import z from 'bloque' */\nconst re = /import 'regex'/g;\nconst t = `import w from 'plantilla' ${s}`;\nexport const listo = true;\n",
  'test/uc-001.test.ts': "import { test } from 'node:test';\nimport { registrarFiado } from '../src/uc-001.js';\ntest('CA-UC-001-01', () => { registrarFiado(); });\n",
  '.env': 'SECRET=no-leer\n',
  'app/__init__.py': '',
  'app/modelos.py': 'class Fiado:\n    pass\n\ndef saldo(fiados):\n    return 0\n_privado = 1\n',
  'app/servicio.py':
    '"""\nimport os  (esto es texto)\n"""\nfrom .modelos import Fiado, saldo\nimport json\n\ndef registrar():\n    import importlib\n    importlib.import_module("x")\n    return Fiado()\n',
  'tests/test_servicio.py': '# CA-UC-002-01\nfrom app.servicio import registrar\n\ndef test_registrar():\n    registrar()\n',
};

describe('extractores (V2-060, V2-062)', () => {
  it('TS/JS: imports reales, símbolos y menciones; strings, comentarios, regex y plantillas no engañan', () => {
    const x = extractTs(TS_APP['src/api.ts']!);
    expect(x.imports.map((i) => i.specifier)).toEqual(['express', './uc-001.js', '@/util', './nuevo.js']);
    expect(x.notes[0]).toMatch(/import\(\) con expresión/);
    expect(extractTs(TS_APP['src/trampas.ts']!).imports).toEqual([]);
    const uc = extractTs(TS_APP['src/uc-001.ts']!);
    expect(uc.symbols).toEqual([
      { name: 'registrarFiado', kind: 'funcion', exported: true, line: 4 },
      { name: 'Interna', kind: 'clase', exported: false, line: 5 },
    ]);
    expect(uc.mentions).toEqual(['R-001']);
    expect(extractTs("export * from './a';\nexport { b } from \"./b\";\nconst c = require('./c');\n").imports.map((i) => i.specifier)).toEqual(['./a', './b', './c']);
    expect(extractTs('export interface A {}\nexport type B = string;\nexport enum C { X }\nexport default function () {}\n').symbols.map((s) => s.name)).toEqual(['A', 'B', 'C']);
    const files = new Set(['src/contratos.ts', 'src/dominio/index.ts']);
    expect(resolveTs('../contratos.js', 'src/dominio/saldo.ts', files)).toEqual({ path: 'src/contratos.ts', confidence: 'seguro' });
    expect(resolveTs('./dominio', 'src/x.ts', files)).toEqual({ path: 'src/dominio/index.ts', confidence: 'seguro' });
    expect(resolveTs('@scope/pkg/sub', 'src/x.ts', files)).toEqual({ package: '@scope/pkg' });
    expect(resolveTs('@/util', 'src/x.ts', files)).toBeNull();
  });

  it('Python: imports relativos y absolutos, símbolos de nivel superior, docstrings no cuentan', () => {
    const x = extractPython(TS_APP['app/servicio.py']!);
    expect(x.imports.map((i) => i.specifier)).toEqual(['.modelos', 'json', 'importlib']);
    expect(x.notes.join(' ')).toMatch(/import dinámico/);
    expect(x.notes.join(' ')).toMatch(/dentro de un bloque/);
    expect(extractPython(TS_APP['app/modelos.py']!).symbols.map((s) => `${s.name}:${s.exported}`)).toEqual(['Fiado:true', 'saldo:true', '_privado:false']);
    const files = new Set(['app/__init__.py', 'app/modelos.py', 'app/servicio.py']);
    expect(resolvePython('.modelos', 'app/servicio.py', files)).toEqual({ path: 'app/modelos.py', confidence: 'seguro' });
    expect(resolvePython('app.servicio', 'tests/test_servicio.py', files)).toEqual({ path: 'app/servicio.py', confidence: 'seguro' });
    expect(resolvePython('json', 'app/servicio.py', files)).toEqual({ package: 'json' });
  });
});

describe('grafo incremental (V2-060, V2-061)', () => {
  it('construye con procedencia y confianza, excluye secretos y sólo reanaliza lo que cambió', async () => {
    const r = repo(TS_APP);
    const graph = GraphStore.open(dir);
    closers.push(() => graph.close());
    const first = await buildGraph(graph, { repoPath: r });
    expect(first).toMatchObject({ archivos: 10, analizados: 10, reutilizados: 0 });
    expect(graph.node(fileId('.env'))).toBeNull();
    expect(graph.out(fileId('src/dominio/saldo.ts'), ['importa'])).toEqual([expect.objectContaining({ dst: fileId('src/contratos.ts'), confidence: 'seguro' })]);
    expect(graph.in('criterio:CA-UC-001-01', ['verifica']).map((e) => e.src)).toEqual([fileId('test/uc-001.test.ts')]);
    expect(graph.out(fileId('src/uc-001.ts'), ['menciona']).map((e) => [e.dst, e.confidence])).toEqual([['regla:R-001', 'posible']]);
    expect(graph.out(fileId('tests/test_servicio.py'), ['importa']).map((e) => e.dst)).toEqual([fileId('app/servicio.py')]);
    expect(first.sin_resolver.map((s) => s.importa).sort()).toEqual(['./nuevo.js', '@/util']);
    expect(first.limitaciones.some((l) => l.archivo === 'src/api.ts')).toBe(true);

    const again = await buildGraph(graph, { repoPath: r });
    expect(again).toMatchObject({ analizados: 0, reutilizados: 10 });

    // A new file resolves an import of an UNCHANGED file; a change reparses only that file.
    write(r, { 'src/nuevo.ts': 'export const nuevo = 1;\n', 'src/contratos.ts': 'export const MONEDA = "USD";\n' });
    const third = await buildGraph(graph, { repoPath: r });
    expect(third).toMatchObject({ analizados: 2, reutilizados: 9 });
    expect(graph.out(fileId('src/api.ts'), ['importa']).map((e) => e.dst)).toContain(fileId('src/nuevo.ts'));
    expect(graph.node('simbolo:src/contratos.ts#Fiado')).toBeNull();

    unlinkSync(join(r, 'src/trampas.ts'));
    git(r, 'add', '-A');
    const fourth = await buildGraph(graph, { repoPath: r });
    expect(fourth.eliminados).toBe(1);
    expect(graph.node(fileId('src/trampas.ts'))).toBeNull();

    // A new extractor version invalidates everything.
    graph.setMeta('version', 'viejo');
    expect((await buildGraph(graph, { repoPath: r })).analizados).toBe(10);
    GraphStore.reset(dir);
  });
});

const task = (id: string, p: Partial<PlanTask>): PlanTask => ({
  id,
  titulo: id,
  objetivo: 'x',
  tipo: 'implementacion',
  criterios: [],
  requisitos: [],
  depende_de: [],
  escribe: [],
  lee: [],
  recursos_exclusivos: [],
  complejidad: 'baja',
  red: false,
  notas: '',
  ...p,
});

describe('selector de contexto y evaluación (V2-061)', () => {
  it('el grafo agrega lo que la tarea realmente necesita, con motivo; mejora al simple en el corpus sin perder reglas', async () => {
    const r = repo(TS_APP);
    const graph = GraphStore.open(dir);
    closers.push(() => graph.close());
    const t1 = task('T-001', { tipo: 'contrato', escribe: ['src/contratos.ts', 'src/dominio/*.ts'] });
    const t2 = task('T-002', { tipo: 'pruebas', criterios: ['CA-UC-001-01'], escribe: ['test/uc-001.test.ts'] });
    const t3 = task('T-003', { criterios: ['CA-UC-001-01'], depende_de: ['T-001', 'T-002'], escribe: ['src/uc-001.ts'] });
    const plan = { tareas: [t1, t2, t3] } as unknown as Plan;
    await buildGraph(graph, { repoPath: r, plan });
    const tree = git(r, 'ls-files').split('\n').filter(Boolean);

    expect(simpleSelection(t3, plan, tree).map((f) => f.path)).toEqual(['test/uc-001.test.ts']);
    const g = graphSelection(graph, t3, plan, tree);
    const by = Object.fromEntries(g.map((f) => [f.path, f.reason]));
    expect(by['test/uc-001.test.ts']).toBe('declarado por la tarea');
    expect(by['src/uc-001.ts']).toBe('la tarea lo modifica');
    expect(by['src/dominio/saldo.ts']).toMatch(/escrito por T-001|lo importa/);
    expect(by['src/contratos.ts']).toMatch(/escrito por T-001|lo importa/);
    expect(by['src/api.ts']).toBe('importa src/uc-001.ts, que la tarea cambia');
    expect(by['src/trampas.ts']).toBeUndefined();

    const report = evaluateSelectors(graph, plan, tree, [{ task: t3, needed: ['test/uc-001.test.ts', 'src/dominio/saldo.ts', 'src/contratos.ts'], source: 'corpus' }]);
    expect(report.simple.recall).toBe(0.33);
    expect(report.grafo.recall).toBe(1);
    expect(report.recomendacion).toBe('grafo');
    expect(evaluateSelectors(graph, plan, tree, []).recomendacion).toBe('sin_datos');

    // Mandatory content is never traded for related files.
    const spec = sampleSpec() as Spec;
    const crit = spec.criterios[0]!;
    const rule = spec.reglas[0]!;
    const uc = spec.casos_uso.find((u) => u.id === crit.caso_uso_id)!;
    uc.reglas = [rule.id];
    const bigRelated = Array.from({ length: 30 }, (_, i) => ({ path: `src/uc-001.ts`, reason: `r${i}` }));
    const { prompt, manifest } = await buildWorkerPrompt({
      plan: { ...plan, perfil: { stack: [], gestor: 'npm', comandos: {}, red_instalar: [] }, tareas: [t1, t2, { ...t3, criterios: [crit.id] }] } as unknown as Plan,
      spec,
      task: { ...t3, criterios: [crit.id] },
      worktree: r,
      attempt: 1,
      feedback: null,
      question: null,
      answer: null,
      related: [...g.map((f) => ({ path: f.path, reason: f.reason })), ...bigRelated],
      lessons: [{ id: 'lec_1', text: 'usa saldo() del dominio' }],
    });
    expect(prompt).toContain(crit.id);
    expect(prompt).toContain(rule.texto);
    expect(prompt).toContain('usa saldo() del dominio');
    expect(manifest.fragments.some((f) => f.reason.startsWith('grafo: '))).toBe(true);
  });
});

describe('lecciones revisadas (V2-062)', () => {
  it('se proponen una sola vez por evidencia, no se autopromueven y sólo las aprobadas aplican a su ámbito', () => {
    const store = EventStore.open(join(dir, 'e.db'), 'chk');
    closers.push(() => store.close());
    const svc = new LessonService(store);
    const id = svc.propose('usa saldo()', { tipo: 'implementacion', archivos: ['src/uc-001.ts'] }, { run: 'r' }, 'r:T-003');
    expect(svc.propose('usa saldo()', { tipo: 'implementacion', archivos: ['src/uc-001.ts'] }, { run: 'r' }, 'r:T-003')).toBe(id);
    expect(svc.list()).toHaveLength(1);
    const t = task('T-009', { tipo: 'pruebas', escribe: ['src/uc-001.ts'] });
    expect(svc.forTask(t)).toEqual([]);
    svc.review(id, true, 'yo', 'correcta');
    expect(svc.forTask(t).map((l) => l.lesson_id)).toEqual([id]);
    expect(svc.forTask(task('T-010', { tipo: 'contrato', escribe: ['otra/*.ts'] }))).toEqual([]);
    expect(() => svc.review(id, false, 'yo', '')).toThrow(/ya está aprobada/);
    // Replay rebuilds lessons from events.
    store.rebuildProjections();
    expect(svc.get(id).state).toBe('aprobada');
  });
});

describe.skipIf(!HAS_BWRAP)('run con contexto de grafo', () => {
  it('ejecuta con contexto.modo = grafo, construye el índice y propone la lección del reintento', async () => {
    const simulation: Simulation = ({ role, taskId, attempt }) => {
      if (role === 'revisor') return { pasos: [], estructurado: { criterios: [], hallazgos: [], veredicto: 'aprobado', resumen: 'ok' } };
      if (taskId === 'T-005' && attempt === 1) return { pasos: [{ escribir: { ruta: 'src/uc-002.mjs', contenido: 'export function saldo() { return 999; }\n' } }] };
      return { pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' };
    };
    const t = testEngine(simulation);
    closers.push(t.cleanup);
    t.engine.config.contexto.modo = 'grafo';
    const { repo: r, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: r });
    const log: string[] = [];
    const summary = await new Orchestrator(t.engine, r, runId, { sandbox: HAS_BWRAP, pollMs: 100, onLog: (l) => log.push(l) }).loop();
    expect(summary.state, log.join('\n')).toBe('completado');
    expect(log.some((l) => l.includes('sin contexto del grafo'))).toBe(false);
    expect(existsSync(join(t.dir, 'grafo.db'))).toBe(true);
    const lessons = new LessonService(t.engine.store).list('propuesta');
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.evidence).toMatchObject({ tarea: 'T-005', intentos: 2, fallos: 1 });
  }, 300_000);
});
