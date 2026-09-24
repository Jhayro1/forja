import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine } from '../../src/core/engine.js';
import { hashJson } from '../../src/domain/hash.js';
import { approvePlan } from '../../src/plan/approve.js';
import type { Plan, PlanTask } from '../../src/plan/plan.js';
import { EV } from '../../src/store/planning-projections.js';
import { sampleSpec } from '../spec/fixture.js';

export const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();

const t = (id: string, p: Partial<PlanTask>): PlanTask => ({
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

export const TASKS: PlanTask[] = [
  t('T-001', { tipo: 'contrato', titulo: 'Contratos', escribe: ['src/contratos.mjs'] }),
  t('T-002', { tipo: 'pruebas', titulo: 'Pruebas UC-001', depende_de: ['T-001'], criterios: ['CA-UC-001-01'], escribe: ['test/uc-001.test.mjs'] }),
  t('T-003', { tipo: 'implementacion', titulo: 'Registrar fiado', depende_de: ['T-002'], criterios: ['CA-UC-001-01'], escribe: ['src/uc-001.mjs'] }),
  t('T-004', { tipo: 'pruebas', titulo: 'Pruebas UC-002', depende_de: ['T-001'], criterios: ['CA-UC-002-01'], escribe: ['test/uc-002.test.mjs'] }),
  t('T-005', { tipo: 'implementacion', titulo: 'Consultar saldo', depende_de: ['T-004'], criterios: ['CA-UC-002-01'], escribe: ['src/uc-002.mjs'] }),
];

/** Files each simulated agent writes, keyed by task. */
export const FILES: Record<string, Record<string, string>> = {
  'T-001': { 'src/contratos.mjs': 'export const MONEDA = "PEN";\n' },
  'T-002': {
    'test/uc-001.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { registrarFiado } from '../src/uc-001.mjs';\ntest('CA-UC-001-01', () => { assert.equal(registrarFiado(0, 10), 10); });\n",
  },
  'T-003': { 'src/uc-001.mjs': 'export function registrarFiado(saldo, monto) { return saldo + monto; }\n' },
  'T-004': {
    'test/uc-002.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { saldo } from '../src/uc-002.mjs';\ntest('CA-UC-002-01', () => { assert.equal(saldo([10, 15], [20]), 5); });\n",
  },
  'T-005': { 'src/uc-002.mjs': 'export function saldo(f, a) { return f.reduce((x, y) => x + y, 0) - a.reduce((x, y) => x + y, 0); }\n' },
};

/** Creates a repo, a change with spec + plan in phase «aprobar», and approves it. */
export async function seedApprovedPlan(engine: Engine, dir: string, tasks: PlanTask[] = TASKS): Promise<{ repo: string; changeId: string; plan: Plan }> {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'package.json'), '{ "type": "module" }\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  const changeId = 'cam_01M3AAPTCH0WXKXT8DQVWD75D6';
  const spec = sampleSpec();
  spec.change_id = changeId;
  const specHash = hashJson(spec);
  const plan: Plan = {
    schema_version: 1,
    plan_id: 'plan_1',
    change_id: changeId,
    revision: 1,
    spec_revision: 1,
    spec_hash: specHash,
    base_sha: sh(repo, 'rev-parse', 'HEAD'),
    perfil: { stack: ['node'], gestor: 'npm', comandos: { instalar: null, build: null, typecheck: null, lint: null, test: { executable: 'node', args: ['--test'] } }, red_instalar: [] },
    tareas: tasks,
    supuestos: [],
    recursos_implicitos: {},
  };
  const planHash = hashJson(plan);
  const phase = (from: string, to: string) => ({ type: EV.changePhase, aggregate_type: 'cambio', aggregate_id: changeId, payload: { from, to } });
  engine.store.execute({ request_id: 'seed', type: 'seed', input: null }, () => ({
    result: null,
    events: [
      { type: EV.changeCreated, aggregate_type: 'cambio', aggregate_id: changeId, payload: { title: 'Fiados', mode: 'idea' } },
      phase('descubrir', 'especificar'),
      { type: EV.specRevised, aggregate_type: 'cambio', aggregate_id: changeId, payload: { revision: 1, hash: specHash, spec: spec as unknown as Record<string, unknown> } },
      phase('especificar', 'dividir'),
      { type: EV.planProposed, aggregate_type: 'cambio', aggregate_id: changeId, payload: { plan_id: plan.plan_id, revision: 1, hash: planHash, plan: plan as unknown as Record<string, unknown> } },
      phase('dividir', 'aprobar'),
    ],
  }));
  approvePlan(engine, changeId);
  return { repo, changeId, plan };
}
