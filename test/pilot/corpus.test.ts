import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine, type Simulation } from '../../src/core/engine.js';
import { type Corpus, engineExecutor, runCorpus, schedule } from '../../src/pilot/corpus.js';
import { pilotReport } from '../../src/pilot/report.js';
import { SimulatedAdapter } from '../../src/providers/adapters.js';
import { latestSpec } from '../../src/spec/generate.js';
import { HAS_BWRAP, ROOT, RUNNER, testEngine } from '../helpers/engine.js';
import { FILES, seedApprovedPlan, sh } from '../run/fixture.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const change = (id: string) => ({ id, repo: 'r', sha: 'abcdef1', spec: 's.json', plan: 'p.json' });

describe('corpus del piloto (MEJORAS 3.2)', () => {
  it('programa cambio × N × repetición alternando el orden en cada repetición', () => {
    const corpus: Corpus = { repeticiones: 3, paralelo: [2, 3, 4], revisor: true, cambios: [change('A'), change('B')] };
    const jobs = schedule(corpus);
    expect(jobs).toHaveLength(18);
    const order = (rep: number) => [...new Set(jobs.filter((j) => j.repeticion === rep).map((j) => j.paralelo))];
    expect([order(1), order(2), order(3)]).toEqual([
      [2, 3, 4],
      [3, 4, 2],
      [4, 2, 3],
    ]);
    expect(
      jobs
        .filter((j) => j.repeticion === 2)
        .map((j) => j.cambio.id)
        .slice(0, 2),
    ).toEqual(['B', 'A']);
  });

  it('corre cada condición sobre un clon en el commit fijo, sin intervención, y un error no detiene el resto', async () => {
    const t = testEngine(() => ({}));
    cleanup = t.cleanup;
    const { repo, changeId, plan } = await seedApprovedPlan(t.engine, t.dir);
    const dir = t.dir;
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(latestSpec(t.engine, changeId)!.spec));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
    const sha = sh(repo, 'rev-parse', 'HEAD');
    const corpus: Corpus = {
      repeticiones: 1,
      paralelo: [1, 2],
      revisor: false,
      cambios: [
        { id: 'fiados', repo, sha, spec: 'spec.json', plan: 'plan.json' },
        { id: 'roto', repo, sha, spec: 'no-existe.json', plan: 'plan.json' },
      ],
    };
    const agents: Simulation = ({ taskId }) => ({ pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' });
    const seen: string[] = [];
    const results = await runCorpus(corpus, {
      workDir: join(dir, 'corpus'),
      execute: engineExecutor({
        corpusDir: dir,
        review: false,
        sandbox: HAS_BWRAP,
        makeEngine: (store, dataDir) =>
          createEngine({
            store,
            dataDir,
            config: t.engine.config,
            runnerScript: RUNNER,
            simulation: agents,
            adapters: { simulado: new SimulatedAdapter({ agentDir: join(ROOT, 'dist/providers'), sandbox: HAS_BWRAP }) },
          }),
      }),
      onJob: (r) => seen.push(`${r.job.cambio.id}/${r.job.paralelo}:${r.error ? 'error' : r.metrics!.estado}`),
    });
    expect(seen).toEqual(['fiados/1:completado', 'roto/1:error', 'fiados/2:completado', 'roto/2:error']);
    const ok = results.flatMap((r) => (r.metrics ? [r.metrics] : []));
    expect(ok.map((m) => m.paralelo)).toEqual([1, 2]);
    expect(ok.every((m) => m.aceptado && m.integradas === 5)).toBe(true);
    expect(pilotReport(ok).condiciones.map((c) => c.clave)).toEqual(['N=1 · simulado:sim', 'N=2 · simulado:sim']);
  }, 300_000);
});
