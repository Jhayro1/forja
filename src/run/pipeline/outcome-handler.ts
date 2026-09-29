import { pauseProvider, type Role, recordUsage } from '../../core/engine.js';
import { captureTask, resetWorktree } from '../../git/workspace.js';
import { readOutcome } from '../../runtime/launch-service.js';
import { launchStatus, spawnRunner } from '../../runtime/launcher.js';
import { extractQuestion } from '../context.js';
import type { RunContext } from './run-context.js';

/**
 * Reads a finished launch and decides the task's next state: interrupted
 * (environment), provider unavailable (another model, no escalation), a
 * question for the user, a rejected change, no change at all, or a candidate
 * commit to verify.
 */
export class OutcomeHandler {
  constructor(private readonly ctx: RunContext) {}

  async poll(taskId: string): Promise<void> {
    const { ctx } = this;
    const { engine, run } = ctx;
    const exec = ctx.execOf(taskId);
    if (!exec.launch_dir) return;
    const status = launchStatus(exec.launch_dir);
    if (status.state === 'corriendo') return;
    if (status.state === 'sin_iniciar') {
      spawnRunner(exec.launch_dir, engine.runnerScript);
      return;
    }
    const outcome = await readOutcome(exec.launch_dir, exec.provider === 'codex' ? 'codex' : 'claude');
    recordUsage(engine, { role: (exec.level as Role) ?? 'trabajador', scope: { run_id: run.run_id, task_id: taskId } }, exec.launch_id!, exec.provider ?? '?', exec.model ?? '?', outcome);
    if (status.state === 'interrumpido') {
      // Interruption is not a quality failure (R09): relaunch on the same workspace.
      ctx.environmentFailure(taskId, 'el agente se interrumpió', { feedback: 'El proceso anterior se interrumpió. Tu trabajo parcial sigue en el directorio: revísalo y termina la tarea.' });
      return;
    }
    const err = outcome.summary.error;
    if (err && (err.category === 'quota' || err.category === 'auth')) {
      pauseProvider(engine, `${exec.provider}:${exec.model}`, err.message.slice(0, 100), err.retryAfterMs ?? 15 * 60_000, exec.account);
      ctx.move(taskId, 'lista', 'proveedor_no_disponible', err.message);
      ctx.log(
        `⏸ ${exec.provider}${exec.account && exec.account !== 'principal' ? `@${exec.account}` : ''}: ${err.category === 'quota' ? 'cuota agotada' : 'sin sesión'}; ${taskId} usará otra cuenta u otro modelo`,
      );
      return;
    }
    const question = extractQuestion(outcome.summary.text);
    if (question) {
      ctx.exec(taskId, { question, answer: null });
      ctx.move(taskId, 'esperando_respuesta', 'pregunta', question);
      ctx.log(`? ${taskId} pregunta: ${question.split('\n')[0]}`);
      return;
    }
    const task = ctx.task(taskId);
    const protectedPaths = ctx.plan.tareas.filter((t) => t.tipo === 'pruebas' && t.id !== taskId).flatMap((t) => t.escribe);
    const capture = await captureTask(exec.worktree!, {
      baseSha: exec.base_sha!,
      allow: task.escribe,
      protectedPaths,
      message: `forja(${taskId}): ${task.titulo}`,
      redactor: ctx.redactor,
    });
    const problems = [...capture.violations, ...capture.secretFindings];
    if (problems.length > 0) {
      await resetWorktree(exec.worktree!, exec.base_sha!);
      ctx.qualityFailure(taskId, `El cambio se rechazó antes de verificar:\n${problems.map((p) => `- ${p}`).join('\n')}\nModifica sólo ${task.escribe.join(', ')}.`);
      return;
    }
    if (!capture.sha) {
      // The code may already satisfy the task (e.g. after a replan): prove it with
      // the full verification on the current base instead of counting a failure (MEJORAS 2.1).
      if (!err && outcome.summary.status === 'completed' && task.tipo !== 'pruebas') {
        ctx.exec(taskId, { candidate_sha: exec.base_sha, files: '[]' });
        ctx.move(taskId, 'verificando', 'proceso_terminado', 'sin cambios: se verifica si ya se cumple');
        ctx.log(`≡ ${taskId}: el agente no cambió nada; se verifica si el código ya cumple la tarea`);
        return;
      }
      const why = err ? `${err.category}: ${err.message}` : outcome.summary.status === 'completed' ? 'terminó sin modificar ningún archivo' : 'terminó sin resultado';
      ctx.qualityFailure(taskId, `El intento no produjo cambios (${why}).`);
      return;
    }
    ctx.exec(taskId, { candidate_sha: capture.sha, files: JSON.stringify(capture.changes.map((c) => c.path)) });
    ctx.move(taskId, 'verificando', 'proceso_terminado');
    ctx.log(`✎ ${taskId}: ${capture.changes.length} archivo(s) cambiados; verificando`);
  }
}

/** A candidate equal to its base: the agent changed nothing and the task is verified as already met. */
export const isNoChangeCandidate = (exec: { candidate_sha: string | null; base_sha: string | null; files: string | null }): boolean =>
  exec.candidate_sha !== null && exec.candidate_sha === exec.base_sha && (exec.files ?? '[]') === '[]';
