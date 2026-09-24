import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import { latestBaseline, preexistingFailures, runBaseline } from '../../src/profile/baseline.js';
import { detectProfile, profileCommands, toConfigProfile } from '../../src/profile/detect.js';
import { getExec, Orchestrator, startOrResumeRun } from '../../src/run/orchestrator.js';
import { HAS_BWRAP, testEngine } from '../helpers/engine.js';
import { FILES, seedApprovedPlan } from '../run/fixture.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'forja-perfil-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  return dir;
}

describe('detección estática del perfil (V2-030)', () => {
  it('Node: gestor por lockfile, scripts reales y sin el test de relleno de npm', () => {
    const root = repoWith({
      'package.json': JSON.stringify({ scripts: { build: 'tsc', lint: 'eslint .', test: 'vitest run' }, devDependencies: { typescript: '5', vitest: '3' } }),
      'pnpm-lock.yaml': '',
      'tsconfig.json': '{}',
    });
    const p = detectProfile(root)!;
    expect(p.gestor).toBe('pnpm');
    expect(p.comandos.instalar).toEqual({ executable: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts'] });
    expect(p.comandos.build).toEqual({ executable: 'pnpm', args: ['run', 'build'] });
    expect(p.comandos.typecheck).toEqual({ executable: 'npx', args: ['--no-install', 'tsc', '--noEmit'] });
    expect(p.comandos.test).toEqual({ executable: 'pnpm', args: ['test'] });
    expect(p.stack).toEqual(['node', 'typescript', 'vitest']);
    expect(toConfigProfile(p).comandos.lint).toEqual({ executable: 'pnpm', args: ['run', 'lint'], cwd: '.' });

    const npm = detectProfile(repoWith({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), 'package-lock.json': '{}' }))!;
    expect(npm.comandos.instalar!.args).toEqual(['ci', '--ignore-scripts']);
    expect(npm.comandos.test).toBeUndefined();
    expect(npm.evidencia.join(' ')).toMatch(/sin script de pruebas/);
  });

  it('Python, Go y Rust; y nada cuando no reconoce el ecosistema', () => {
    const py = detectProfile(repoWith({ 'pyproject.toml': '[project]\ndependencies = ["fastapi"]\n[dependency-groups]\ndev = ["pytest", "ruff"]\n', 'uv.lock': '' }))!;
    expect(py.comandos.instalar).toEqual({ executable: 'uv', args: ['sync', '--frozen'] });
    expect(py.comandos.test).toEqual({ executable: 'uv', args: ['run', 'pytest', '-q'] });
    expect(py.comandos.lint).toEqual({ executable: 'uv', args: ['run', 'ruff', 'check', '.'] });
    expect(py.comandos.typecheck).toBeUndefined();
    expect(detectProfile(repoWith({ 'go.mod': 'module x' }))!.comandos.test).toEqual({ executable: 'go', args: ['test', './...'] });
    expect(detectProfile(repoWith({ 'Cargo.toml': '[package]' }))!.comandos.typecheck).toEqual({ executable: 'cargo', args: ['check'] });
    expect(detectProfile(repoWith({ 'README.md': 'hola' }))).toBeNull();
  });
});

const APPROVE_REVIEW = { pasos: [], estructurado: { criterios: [], hallazgos: [], veredicto: 'aprobado', resumen: 'correcto' } };
const agents: Simulation = ({ role, taskId }) =>
  role === 'revisor' ? APPROVE_REVIEW : { pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' };

describe('línea base en el sandbox', () => {
  it('registra lo que ya fallaba y la verificación no se lo cobra a las tareas', async () => {
    const t = testEngine(agents);
    cleanup = t.cleanup;
    const broken = { executable: 'node', args: ['-e', 'console.error("error TS2304 previo"); process.exit(2)'] };
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir, undefined, { comandos: { typecheck: broken } });
    const perfil = { comandos: { typecheck: broken, test: { executable: 'node', args: ['--test'] } } };
    const b = await runBaseline(t.engine, {
      repoPath: repo,
      comandos: profileCommands(perfil),
      red_instalar: [],
      cmd: { dataDir: t.dir, sandbox: HAS_BWRAP, timeoutMs: 60_000, runnerScript: t.engine.runnerScript! },
    });
    expect(b.pasos.map((s) => [s.paso, s.ok])).toEqual([
      ['typecheck', false],
      ['test', true],
    ]);
    expect(b.pasos[0]!.detalle).toContain('error TS2304 previo');
    expect(latestBaseline(t.engine)!.sha).toBe(b.sha);
    t.engine.store.rebuildProjections();
    expect([...preexistingFailures(t.engine, perfil)]).toEqual(['typecheck']);

    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const summary = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 50 }).loop();
    expect(summary.state).toBe('completado');
    const steps = JSON.parse(getExec(t.engine, runId, 'T-003').steps!) as { paso: string; detalle: string }[];
    expect(steps.find((s) => s.paso === 'typecheck')!.detalle).toMatch(/ya fallaba en la línea base/);
  }, 300_000);
});
