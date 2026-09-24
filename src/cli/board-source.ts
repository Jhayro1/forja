import { launchPrompt, readableLog, readSpoolTail } from '../run/activity.js';
import { taskDetailLines } from '../run/describe.js';
import { requestStop, runningOrchestrator } from '../run/process.js';
import { RunLog } from '../run/run-log.js';
import { currentChange, type RunSnapshot, runSnapshot, type TaskView } from '../run/snapshot.js';
import { answerTaskQuestion, applyTaskControls, reassignTask, requestPause, resumeTask, unblockTask } from '../run/task-control.js';
import { taskDiff } from '../run/task-diff.js';
import type { BoardSource } from '../tui/app.js';
import type { EngineContext } from './engine-context.js';

/** Log of a task's current launch, with time, ready to show. */
export function taskLogLines(task: TaskView, maxBytes = 512 * 1024): string[] {
  if (!task.exec.launch_dir) return ['(esta tarea todavía no tuvo un agente)'];
  const lines = readableLog(readSpoolTail(task.exec.launch_dir, maxBytes), task.exec.provider).map((l) => `${l.ts.slice(11, 19)} ${l.text}`);
  return lines.length ? lines : ['(el agente todavía no escribió nada)'];
}

/** Composition root of the board: wires the read model and domain commands. */
export class EngineBoardSource implements BoardSource {
  readonly project: string;
  private last: RunSnapshot | null = null;

  constructor(private readonly ctx: EngineContext) {
    this.project = ctx.config.nombre;
  }

  snapshot(): RunSnapshot | null {
    const change = currentChange(this.ctx.engine);
    this.last = change ? runSnapshot(this.ctx.engine, change) : null;
    return this.last;
  }

  runLog(runId: string): string[] {
    return RunLog.of(this.ctx.dataDir, runId).tail(50);
  }

  runnerAlive(): boolean {
    return runningOrchestrator(this.ctx.dataDir) !== null;
  }

  taskDetail(task: TaskView): string[] {
    const fresh = this.last?.tasks.find((t) => t.id === task.id) ?? task;
    return taskDetailLines(
      fresh,
      this.last?.plan?.tareas.find((t) => t.id === task.id),
    );
  }

  taskLog(task: TaskView): string[] {
    const fresh = this.last?.tasks.find((t) => t.id === task.id) ?? task;
    return taskLogLines(fresh);
  }

  taskContext(task: TaskView): string[] {
    return (launchPrompt(task.exec.launch_dir) ?? '(esta tarea todavía no recibió instrucciones)').split('\n');
  }

  async taskDiff(task: TaskView): Promise<string[]> {
    return (await taskDiff(this.ctx.checkout.path, task.exec)).split('\n');
  }

  answer(task: TaskView, text: string): void {
    answerTaskQuestion(this.ctx.engine, this.runId(), task.id, text);
  }

  retry(task: TaskView, note: string | null): void {
    unblockTask(this.ctx.engine, this.runId(), task.id, note);
  }

  /** Pauses a working task or resumes a paused one (the same commands as forja pausar/reanudar). */
  togglePause(task: TaskView): string {
    const runId = this.runId();
    if (task.state === 'pausada' || task.exec.control === 'pausar') {
      const to = resumeTask(this.ctx.engine, runId, task.id);
      return `▶ ${task.id} reanudada (${to})`;
    }
    const r = requestPause(this.ctx.engine, runId, task.id);
    if (r.immediate) return `⏸ ${task.id} pausada`;
    if (!this.runnerAlive()) {
      applyTaskControls(this.ctx.engine, runId, new Set());
      return `⏸ ${task.id} pausada`;
    }
    return `⏸ se pidió pausar ${task.id}: el run la detiene en cuanto sea seguro`;
  }

  reassign(task: TaskView, ref: string | null): string {
    reassignTask(this.ctx.engine, this.runId(), task.id, ref);
    return ref ? `✔ ${task.id} usará ${ref} desde su próximo intento` : `✔ ${task.id} vuelve al orden de su rol`;
  }

  stop(): string {
    const holder = requestStop(this.ctx.dataDir);
    return holder ? `⏸ se pidió detener el run (pid ${holder.pid}); los agentes en curso terminan su tarea` : 'no hay un forja run activo';
  }

  private runId(): string {
    const run = this.last?.run;
    if (!run) throw new Error('no hay un run en curso');
    return run.run_id;
  }
}
