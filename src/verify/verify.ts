import { existsSync, readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { z } from 'zod';
import { callRole, type Engine } from '../core/engine.js';
import { git } from '../git/git.js';
import type { Plan, PlanTask } from '../plan/plan.js';
import { llmSchema } from '../planner/session.js';
import { compose, loadPrompt } from '../planner/prompts.js';
import type { Spec } from '../spec/spec.js';
import { runCommand, type CommandContext } from './commands.js';

export const ReviewOutput = z
  .object({
    criterios: z.array(z.object({ id: z.string(), veredicto: z.enum(['cumple', 'no_cumple', 'no_verificable']), evidencia: z.string() }).strict()),
    hallazgos: z.array(z.object({ severidad: z.enum(['alta', 'media', 'baja']), ubicacion: z.string(), motivo: z.string() }).strict()),
    veredicto: z.enum(['aprobado', 'rechazado']),
    resumen: z.string(),
  })
  .strict();
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export type StepResult = { paso: string; ok: boolean; detalle: string };

export type Verification = {
  ok: boolean;
  steps: StepResult[];
  /** What the next attempt must fix (quality failures only). */
  feedback: string;
  /** Failure caused by the environment, not by the agent's work: does not escalate. */
  environmentFailure: boolean;
  review?: ReviewOutput;
};

const TEST_DECL = /\b(it|test|describe)\s*\(/;
const CHEATS = /\.(skip|only|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/;

/** Acceptance test files written by the plan's test tasks for a task's criteria. */
export function acceptanceFilesFor(plan: Plan, task: PlanTask): string[] {
  return plan.tareas.filter((t) => t.tipo === 'pruebas' && t.criterios.some((c) => task.criterios.includes(c))).flatMap((t) => t.escribe);
}

/** Expands globs against files present in the worktree. */
async function existing(worktree: string, globs: string[]): Promise<string[]> {
  const files = (await git(worktree, ['ls-files'])).stdout.split('\n').filter(Boolean);
  return files.filter((f) => globs.some((g) => f === g || matchesGlob(f, g)));
}

/**
 * Verification pipeline of one task candidate (v2/09): install, typecheck/build,
 * lint, tests (own + already green ones), anti-cheat, then an independent review.
 * Stops at the first failure; the reviewer only sees code that builds and passes.
 */
export async function verifyTask(
  engine: Engine,
  input: {
    plan: Plan;
    spec: Spec;
    task: PlanTask;
    worktree: string;
    baseSha: string;
    candidateSha: string;
    changedFiles: string[];
    greenTests: string[];
    cmd: CommandContext;
    runId: string;
    review: boolean;
    /** The agent changed nothing: the task passes only if checks prove the code already meets it. */
    noChanges?: boolean;
  },
): Promise<Verification> {
  const { plan, task, worktree } = input;
  const steps: StepResult[] = [];
  const fail = (paso: string, detalle: string, environmentFailure = false): Verification => {
    steps.push({ paso, ok: false, detalle });
    return { ok: false, steps, feedback: `Falló «${paso}»:\n${detalle.slice(-4000)}`, environmentFailure };
  };
  const c = plan.perfil.comandos;
  let evidence = false;

  // Anti-cheat on every test file the task touched (v2/09 · paso 6).
  for (const f of input.changedFiles.filter((x) => /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(x))) {
    const full = join(worktree, f);
    if (existsSync(full) && CHEATS.test(readFileSync(full, 'utf8'))) return fail('antitrampas', `${f} usa .skip/.only/.todo: no se aceptan pruebas desactivadas`);
  }
  steps.push({ paso: 'antitrampas', ok: true, detalle: 'sin pruebas desactivadas' });

  if (c.instalar && existsSync(join(worktree, 'package.json'))) {
    const r = await runCommand({ ...input.cmd, networkHosts: plan.perfil.red_instalar }, worktree, c.instalar);
    if (!r.ok) return fail('instalar', r.output, true);
    steps.push({ paso: 'instalar', ok: true, detalle: `${Math.round(r.durationMs / 1000)}s` });
  }
  for (const name of ['typecheck', 'build', 'lint'] as const) {
    const recipe = c[name];
    if (!recipe) continue;
    const r = await runCommand(input.cmd, worktree, recipe);
    if (!r.ok) return fail(name, r.output);
    steps.push({ paso: name, ok: true, detalle: `${Math.round(r.durationMs / 1000)}s` });
  }

  if (task.tipo === 'pruebas') {
    // Red phase: the tests must exist and declare tests; they may fail until implemented.
    const files = await existing(worktree, task.escribe);
    if (files.length === 0) return fail('pruebas', `la tarea no creó archivos de prueba en ${task.escribe.join(', ')}`);
    for (const f of files) {
      if (!TEST_DECL.test(readFileSync(join(worktree, f), 'utf8'))) return fail('pruebas', `${f} no declara pruebas`);
    }
    steps.push({ paso: 'pruebas', ok: true, detalle: `${files.length} archivo(s) de prueba (fase roja)` });
  } else if (c.test) {
    const own = await existing(worktree, acceptanceFilesFor(plan, task));
    const written = input.changedFiles.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
    const selection = [...new Set([...input.greenTests, ...own, ...written])].filter((f) => existsSync(join(worktree, f)));
    if (selection.length > 0) {
      const r = await runCommand(input.cmd, worktree, c.test, selection);
      if (!r.ok) return fail('pruebas', r.output);
      evidence = true;
      steps.push({ paso: 'pruebas', ok: true, detalle: `${selection.length} archivo(s): ${selection.slice(0, 6).join(', ')}${selection.length > 6 ? '…' : ''}` });
    } else {
      steps.push({ paso: 'pruebas', ok: true, detalle: 'no hay pruebas que ejecutar todavía' });
    }
  }

  const reviews = input.review && task.tipo !== 'pruebas' && task.tipo !== 'infraestructura';
  if (input.noChanges && !evidence && !reviews) {
    return fail('sin_cambios', 'El agente no cambió nada y no hay pruebas ni revisión que demuestren que la tarea ya se cumple. Implementa lo que pide la tarea.');
  }
  const done = (): Verification => {
    if (input.noChanges) steps.push({ paso: 'sin_cambios', ok: true, detalle: 'el código ya cumplía la tarea: se integra sin cambios' });
    return { ok: true, steps, feedback: '', environmentFailure: false };
  };
  if (!reviews) return done();

  // Independent review on a read-only copy (another provider when configured).
  const diff = (await git(worktree, ['diff', input.baseSha, input.candidateSha, '--', '.', ':(exclude)package-lock.json'])).stdout;
  const criteria = input.spec.criterios.filter((x) => task.criterios.includes(x.id));
  const { prompt } = compose([loadPrompt('trabajo/revisor')], {
    tarea: { id: task.id, titulo: task.titulo, objetivo: task.objetivo, notas: task.notas },
    criterios: criteria,
    diff: input.noChanges
      ? '(sin cambios: el agente no modificó nada. Comprueba en el código del directorio si los criterios YA se cumplen; si no hay evidencia clara, recházalo.)'
      : diff.length > 60_000
        ? `${diff.slice(0, 60_000)}\n… [recortado]`
        : diff,
  });
  const call = await callRole(engine, {
    role: 'revisor',
    prompt,
    tools: 'lectura',
    workspace: worktree,
    workspaceReadOnly: true,
    outputSchema: llmSchema(ReviewOutput),
    scope: { run_id: input.runId, task_id: task.id },
  });
  const parsed = ReviewOutput.safeParse(call.outcome.summary.structured);
  if (!parsed.success) {
    // A broken review is not an approval (v2/formatos).
    steps.push({ paso: 'revision', ok: false, detalle: 'el revisor no devolvió un resultado válido' });
    return { ok: false, steps, feedback: '', environmentFailure: true };
  }
  const review = parsed.data;
  const serious = review.hallazgos.filter((h) => h.severidad === 'alta');
  const unmet = review.criterios.filter((x) => x.veredicto === 'no_cumple');
  if (review.veredicto === 'rechazado' && (serious.length > 0 || unmet.length > 0)) {
    steps.push({ paso: 'revision', ok: false, detalle: review.resumen });
    return {
      ok: false,
      steps,
      review,
      environmentFailure: false,
      feedback: `La revisión rechazó el cambio:\n${[...unmet.map((u) => `- ${u.id}: ${u.evidencia}`), ...serious.map((h) => `- ${h.ubicacion}: ${h.motivo}`)].join('\n')}`,
    };
  }
  steps.push({ paso: 'revision', ok: true, detalle: review.resumen });
  return { ...done(), review };
}
