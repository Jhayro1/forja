import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Engine } from '../core/engine.js';
import { hashJson } from '../domain/hash.js';
import { git, gitOut } from '../git/git.js';
import { approvePlan } from '../plan/approve.js';
import type { Plan } from '../plan/plan.js';
import { getRun, Orchestrator, startOrResumeRun } from '../run/orchestrator.js';
import type { Spec } from '../spec/spec.js';
import { EventStore } from '../store/event-store.js';
import { EV } from '../store/planning-projections.js';
import { type RunMetrics, runMetrics } from './metrics.js';

/**
 * Pilot corpus runner (MEJORAS 3.2, v2/09 · Experimento). Each change of the
 * corpus fixes a repository, a commit, and an already approved spec and plan,
 * so the only thing that varies between runs is the condition under test (N).
 * Jobs alternate the order of conditions between repetitions to spread
 * time-of-day and quota effects, and run without human intervention: a run that
 * needs the user counts as not accepted.
 */

const CorpusChange = z
  .object({
    id: z.string().regex(/^[\w-]{1,40}$/, 'id corto: letras, números, guion o guion bajo'),
    /** Git URL or local path. */
    repo: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/, 'SHA de commit'),
    /** spec.json and plan.json produced by Forja for this change (.forja/cambios/<id>/). */
    spec: z.string().min(1),
    plan: z.string().min(1),
  })
  .strict();
export type CorpusChange = z.infer<typeof CorpusChange>;

export const Corpus = z
  .object({
    repeticiones: z.number().int().min(1).max(10).default(3),
    paralelo: z.array(z.number().int().min(1).max(16)).min(1).default([2, 3, 4]),
    revisor: z.boolean().default(true),
    cambios: z.array(CorpusChange).min(1),
  })
  .strict();
export type Corpus = z.infer<typeof Corpus>;

export type CorpusJob = { cambio: CorpusChange; paralelo: number; repeticion: number };
export type JobResult = { job: CorpusJob; metrics: RunMetrics | null; error: string | null };
export type JobExecutor = (job: CorpusJob, workDir: string) => Promise<RunMetrics>;

export function loadCorpus(path: string): { corpus: Corpus; dir: string } {
  const raw = parse(readFileSync(path, 'utf8')) as unknown;
  const r = Corpus.safeParse(raw);
  if (!r.success) throw new Error(`${path} no es un corpus válido:\n${r.error.issues.map((i) => `  - ${i.path.join('.') || '(raíz)'}: ${i.message}`).join('\n')}`);
  return { corpus: r.data, dir: dirname(resolve(path)) };
}

const rotate = <T>(xs: readonly T[], k: number): T[] => xs.map((_, i) => xs[(i + k) % xs.length]!);

/** Every (change × N × repetition), rotating the order of N and of changes in each repetition. */
export function schedule(corpus: Corpus): CorpusJob[] {
  const jobs: CorpusJob[] = [];
  for (let rep = 0; rep < corpus.repeticiones; rep++) {
    for (const paralelo of rotate(corpus.paralelo, rep)) {
      for (const cambio of rotate(corpus.cambios, rep)) jobs.push({ cambio, paralelo, repeticion: rep + 1 });
    }
  }
  return jobs;
}

export async function runCorpus(corpus: Corpus, opts: { workDir: string; execute: JobExecutor; onJob?: (r: JobResult, index: number, total: number) => void }): Promise<JobResult[]> {
  const jobs = schedule(corpus);
  const results: JobResult[] = [];
  for (const [i, job] of jobs.entries()) {
    const dir = join(opts.workDir, `${String(i + 1).padStart(3, '0')}-${job.cambio.id}-n${job.paralelo}-r${job.repeticion}`);
    mkdirSync(dir, { recursive: true });
    let result: JobResult;
    try {
      result = { job, metrics: await opts.execute(job, dir), error: null };
    } catch (error) {
      // One broken job (a clone, a bad plan) must not stop the rest of the pilot.
      result = { job, metrics: null, error: (error as Error).message.slice(0, 500) };
    }
    results.push(result);
    opts.onJob?.(result, i, jobs.length);
  }
  return results;
}

/** Records a fixed, already approved spec + plan as a change of this engine (no planner call). */
export async function seedApprovedChange(engine: Engine, repoPath: string, spec: Spec, plan: Plan): Promise<string> {
  const changeId = spec.change_id;
  const specHash = hashJson(spec);
  const fixed: Plan = { ...plan, change_id: changeId, spec_hash: specHash, spec_revision: spec.revision, base_sha: await gitOut(repoPath, ['rev-parse', 'HEAD']) };
  const phase = (from: string, to: string) => ({ type: EV.changePhase, aggregate_type: 'cambio', aggregate_id: changeId, payload: { from, to } });
  engine.store.execute({ request_id: `piloto:${changeId}`, type: 'sembrar_cambio_piloto', input: { changeId } }, () => ({
    result: null,
    events: [
      { type: EV.changeCreated, aggregate_type: 'cambio', aggregate_id: changeId, payload: { title: spec.sistema.nombre, mode: 'mejora' } },
      phase('descubrir', 'especificar'),
      { type: EV.specRevised, aggregate_type: 'cambio', aggregate_id: changeId, payload: { revision: spec.revision, hash: specHash, spec: spec as unknown as Record<string, unknown> } },
      phase('especificar', 'dividir'),
      {
        type: EV.planProposed,
        aggregate_type: 'cambio',
        aggregate_id: changeId,
        payload: { plan_id: fixed.plan_id, revision: fixed.revision, hash: hashJson(fixed), plan: fixed as unknown as Record<string, unknown> },
      },
      phase('dividir', 'aprobar'),
    ],
  }));
  approvePlan(engine, changeId, 'piloto');
  return changeId;
}

/**
 * Real executor: clones the repository at the fixed commit into the job folder,
 * seeds the change in a private store and runs it with N agents in the sandbox.
 */
export function engineExecutor(opts: { corpusDir: string; review: boolean; sandbox: boolean; makeEngine: (store: EventStore, dataDir: string) => Engine }): JobExecutor {
  const file = (p: string) => (isAbsolute(p) ? p : join(opts.corpusDir, p));
  return async (job, dir) => {
    const repo = join(dir, 'repo');
    const source = existsSync(file(job.cambio.repo)) ? file(job.cambio.repo) : job.cambio.repo;
    await git(dir, ['clone', '--quiet', source, repo]);
    await git(repo, ['checkout', '--quiet', '--detach', job.cambio.sha]);
    const store = EventStore.open(join(dir, 'estado.db'), `chk_piloto_${job.cambio.id}`);
    try {
      const engine = opts.makeEngine(store, dir);
      const spec = JSON.parse(readFileSync(file(job.cambio.spec), 'utf8')) as Spec;
      const plan = JSON.parse(readFileSync(file(job.cambio.plan), 'utf8')) as Plan;
      const changeId = await seedApprovedChange(engine, repo, spec, plan);
      const { runId } = await startOrResumeRun(engine, { changeId, repoPath: repo });
      await new Orchestrator(engine, repo, runId, { parallel: job.paralelo, review: opts.review, sandbox: opts.sandbox }).loop();
      return runMetrics(engine, getRun(engine, runId)!);
    } finally {
      store.close();
    }
  };
}
