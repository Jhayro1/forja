import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkApproval } from '../domain/approval.js';
import { hashJson } from '../domain/hash.js';
import { newId } from '../domain/ids.js';
import type { TaskState, TransitionReason } from '../domain/task-state.js';
import { changeTaskState, createTask, tasksReadyToUnblock } from '../core/task-commands.js';
import { pauseProvider, pickCandidate, recordUsage, type Engine, type Role } from '../core/engine.js';
import { git } from '../git/git.js';
import {
  captureTask,
  deliveryBranch as deliveryBranchName,
  detachedWorktree,
  ensureIntegrationBranch,
  isAncestor,
  mergeCandidate,
  publishRef,
  refSha,
  removeWorktree,
  resetWorktree,
  runBranch,
  taskBranch,
  taskWorktree,
} from '../git/workspace.js';
import { approvalTarget, currentApproval, gateProblems } from '../plan/approve.js';
import { latestPlan } from '../plan/divide.js';
import { taskResources, type Plan, type PlanTask } from '../plan/plan.js';
import { getChange } from '../planner/session.js';
import { ClaudeAdapter, CodexAdapter } from '../providers/adapters.js';
import { launchDir, launchStatus, spawnRunner } from '../runtime/launcher.js';
import { readOutcome, startLaunch } from '../runtime/launch-service.js';
import { secretsFromFile } from '../runtime/runner.js';
import { Redactor } from '../security/redact.js';
import { latestSpec } from '../spec/generate.js';
import type { Spec } from '../spec/spec.js';
import { getTask, listTasks, type TaskRow } from '../store/projections.js';
import { EV, type RunState } from '../store/planning-projections.js';
import { runCommand, type CommandContext } from '../verify/commands.js';
import { acceptanceFilesFor, verifyTask } from '../verify/verify.js';
import type { GatewayHost } from '../mcp/gateway.js';
import { buildWorkerPrompt, extractQuestion } from './context.js';

export class RunError extends Error {}

export type RunRow = {
  run_id: string;
  change_id: string;
  plan_id: string;
  plan_revision: number;
  plan_hash: string;
  approval_id: string;
  state: RunState;
  base_sha: string;
  branch: string;
  detail: string | null;
  created_at: string;
};

export type ExecRow = {
  run_id: string;
  task_id: string;
  attempt: number;
  quality_failures: number;
  level: string | null;
  launch_id: string | null;
  launch_dir: string | null;
  worktree: string | null;
  provider: string | null;
  model: string | null;
  base_sha: string | null;
  candidate_sha: string | null;
  integrated_sha: string | null;
  files: string | null;
  feedback: string | null;
  last_error: string | null;
  question: string | null;
  answer: string | null;
  steps: string | null;
};

export function getRun(engine: Engine, runId: string): RunRow | undefined {
  return engine.store.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined;
}

export function runsOf(engine: Engine, changeId: string): RunRow[] {
  return engine.store.db.prepare('SELECT * FROM runs WHERE change_id = ? ORDER BY created_at DESC').all(changeId) as RunRow[];
}

export function getExec(engine: Engine, runId: string, taskId: string): ExecRow {
  return (
    (engine.store.db.prepare('SELECT * FROM task_exec WHERE run_id = ? AND task_id = ?').get(runId, taskId) as ExecRow | undefined) ?? {
      run_id: runId,
      task_id: taskId,
      attempt: 0,
      quality_failures: 0,
      level: null,
      launch_id: null,
      launch_dir: null,
      worktree: null,
      provider: null,
      model: null,
      base_sha: null,
      candidate_sha: null,
      integrated_sha: null,
      files: null,
      feedback: null,
      last_error: null,
      question: null,
      answer: null,
      steps: null,
    }
  );
}

const taskDefHash = (t: PlanTask) => hashJson(t);

function setRunState(engine: Engine, runId: string, to: RunState, detail: string | null = null): void {
  const run = getRun(engine, runId);
  if (!run || run.state === to) return;
  engine.store.execute({ request_id: newId('req'), type: 'estado_run', input: { runId, to } }, () => ({
    result: null,
    events: [{ type: EV.runState, aggregate_type: 'run', aggregate_id: runId, payload: { from: run.state, to, detail } }],
  }));
}

/**
 * Starts a run for the approved plan, or resumes the open one. The approval must
 * match exactly what is about to run (I02). A new plan revision creates a new run
 * that inherits tasks already integrated with an identical definition (V2-037).
 */
export async function startOrResumeRun(engine: Engine, input: { changeId: string; repoPath: string }): Promise<{ runId: string; resumed: boolean; inherited: string[] }> {
  const change = getChange(engine, input.changeId);
  const problems = gateProblems(engine, input.changeId);
  if (problems.length) throw new RunError(`no se puede ejecutar:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  const planRow = latestPlan(engine, input.changeId)!;
  const approval = currentApproval(engine, input.changeId);
  if (!approval) throw new RunError('el plan no está aprobado: forja aprobar plan');
  const check = checkApproval(approval, approvalTarget(engine.config, planRow.plan, planRow.hash));
  if (!check.ok) throw new RunError(`la aprobación ya no corresponde a lo que se ejecutaría:\n${check.reasons.map((r) => `  - ${r}`).join('\n')}`);

  const open = runsOf(engine, input.changeId).find((r) => r.state !== 'completado' && r.state !== 'cancelado');
  if (open && open.plan_hash === planRow.hash) {
    if (open.state !== 'ejecutando') setRunState(engine, open.run_id, 'ejecutando');
    return { runId: open.run_id, resumed: true, inherited: [] };
  }

  const runId = newId('run');
  const branch = runBranch(engine.config.git.prefijo, runId);
  // A replaced run keeps its integrated work: the new one starts from its integration ref.
  let base = planRow.plan.base_sha;
  const inherited = new Map<string, string>();
  if (open) {
    base = await refSha(input.repoPath, open.branch);
    const oldPlan = engine.store.db.prepare('SELECT plan FROM plans WHERE plan_id = ? AND revision = ?').get(open.plan_id, open.plan_revision) as { plan: string } | undefined;
    const oldTasks = new Map(((oldPlan ? (JSON.parse(oldPlan.plan) as Plan) : null)?.tareas ?? []).map((t) => [t.id, taskDefHash(t)]));
    for (const t of listTasks(engine.store.db, open.run_id)) {
      if (t.state === 'integrada') {
        const now = planRow.plan.tareas.find((x) => x.id === t.task_id);
        if (now && oldTasks.get(t.task_id) === taskDefHash(now)) inherited.set(t.task_id, open.run_id);
      } else if (t.state !== 'invalidada' && t.state !== 'cancelada') {
        changeTaskState(engine.store, newId('req'), { run_id: open.run_id, task_id: t.task_id, to: 'invalidada', reason: 'nueva_revision' });
      }
    }
    setRunState(engine, open.run_id, 'cancelado', `reemplazado por ${runId} (plan revisión ${planRow.revision})`);
  }
  await ensureIntegrationBranch(input.repoPath, branch, base);
  engine.store.execute({ request_id: `run:${runId}`, type: 'iniciar_run', input: { runId } }, () => ({
    result: null,
    events: [
      {
        type: EV.runStarted,
        aggregate_type: 'run',
        aggregate_id: runId,
        payload: { change_id: input.changeId, plan_id: planRow.plan.plan_id, plan_revision: planRow.revision, plan_hash: planRow.hash, approval_id: approval.approval_id, base_sha: base, branch },
      },
      ...(change.phase === 'aprobar' ? [{ type: EV.changePhase, aggregate_type: 'cambio', aggregate_id: input.changeId, payload: { from: 'aprobar', to: 'ejecutar' } }] : []),
    ],
  }));
  // Topological creation: dependencies exist before dependents.
  const pending = [...planRow.plan.tareas];
  const created = new Set<string>();
  while (pending.length) {
    const i = pending.findIndex((t) => t.depende_de.every((d) => created.has(d)));
    const t = pending.splice(i < 0 ? 0 : i, 1)[0]!;
    const from = inherited.get(t.id);
    createTask(engine.store, `${runId}:${t.id}`, { run_id: runId, task_id: t.id, title: t.titulo, depends_on: t.depende_de, ...(from ? { inherited_from: from } : {}) });
    created.add(t.id);
  }
  return { runId, resumed: false, inherited: [...inherited.keys()] };
}

export type OrchestratorOptions = {
  parallel?: number;
  /** false only in Forja's own tests on machines without bubblewrap. */
  sandbox?: boolean;
  review?: boolean;
  pollMs?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  /** MCP gateway for workers (M5): only when the project linked connections or MCP servers. */
  gateway?: GatewayHost;
};

export type RunSummary = { runId: string; state: RunState; counts: Record<string, number>; branch: string; deliveryBranch: string | null };

/**
 * Deterministic scheduler (ADR-002): coordination spends no tokens. Everything
 * it decides is an event persisted before the effect, so a restart resumes.
 */
export class Orchestrator {
  private readonly jobs = new Map<string, Promise<void>>();
  private integrating: string | null = null;
  private readonly plan: Plan;
  private readonly spec: Spec;
  private readonly run: RunRow;
  private readonly parallel: number;
  private readonly cmd: CommandContext;
  private readonly redactor: Redactor;

  constructor(
    private readonly engine: Engine,
    private readonly repoPath: string,
    runId: string,
    private readonly opts: OrchestratorOptions = {},
  ) {
    const run = getRun(engine, runId);
    if (!run) throw new RunError(`no existe el run ${runId}`);
    this.run = run;
    const planRow = engine.store.db.prepare('SELECT plan FROM plans WHERE plan_id = ? AND revision = ?').get(run.plan_id, run.plan_revision) as { plan: string };
    this.plan = JSON.parse(planRow.plan) as Plan;
    this.spec = latestSpec(engine, run.change_id)!.spec;
    this.parallel = opts.parallel ?? engine.config.ejecucion.paralelo;
    this.cmd = { dataDir: engine.dataDir, sandbox: opts.sandbox ?? true, timeoutMs: engine.config.ejecucion.timeout_min * 60_000, ...(engine.runnerScript ? { runnerScript: engine.runnerScript } : {}) };
    this.redactor = new Redactor();
    for (const f of [ClaudeAdapter.credentialFile(), CodexAdapter.credentialFile()]) {
      if (existsSync(f)) for (const v of secretsFromFile(f)) this.redactor.add({ name: 'credencial_proveedor', value: v });
    }
  }

  private log(line: string): void {
    this.opts.onLog?.(line);
  }

  private task(id: string): PlanTask {
    return this.plan.tareas.find((t) => t.id === id)!;
  }

  private exec(taskId: string, patch: Partial<Omit<ExecRow, 'run_id' | 'task_id'>>): void {
    this.engine.store.execute({ request_id: newId('req'), type: 'ejecucion_tarea', input: { taskId } }, () => ({
      result: null,
      events: [{ type: EV.taskExec, aggregate_type: 'tarea', aggregate_id: `${this.run.run_id}/${taskId}`, run_id: this.run.run_id, task_id: taskId, payload: patch }],
    }));
  }

  private move(taskId: string, to: TaskState, reason: TransitionReason, detail?: string): void {
    changeTaskState(this.engine.store, newId('req'), { run_id: this.run.run_id, task_id: taskId, to, reason, ...(detail ? { detail: detail.slice(0, 500) } : {}) });
  }

  private tasks(): TaskRow[] {
    return listTasks(this.engine.store.db, this.run.run_id);
  }

  private dir(...parts: string[]): string {
    return join(this.engine.dataDir, 'worktrees', this.run.run_id, ...parts);
  }

  /**
   * Test files already green at `tip`: the regression suite for later tasks. Only
   * tasks whose integration is contained in `tip` count — another task may be
   * integrated while this verification is being prepared, and its tests must not
   * be demanded from a base that does not have its code yet. Inherited tasks
   * (no integrated SHA in this run) are in the run's base by construction.
   */
  private async greenTests(tip: string): Promise<string[]> {
    const out = new Set<string>();
    for (const t of this.tasks().filter((x) => x.state === 'integrada')) {
      const def = this.task(t.task_id);
      if (!def || def.tipo === 'pruebas') continue;
      const exec = getExec(this.engine, this.run.run_id, t.task_id);
      if (exec.integrated_sha && !(await isAncestor(this.repoPath, exec.integrated_sha, tip))) continue;
      for (const f of acceptanceFilesFor(this.plan, def)) out.add(f);
      for (const f of JSON.parse(exec.files ?? '[]') as string[]) if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(f)) out.add(f);
    }
    return [...out];
  }

  private levelFor(task: PlanTask, failures: number): Role {
    const base: Role = task.complejidad === 'alta' ? 'complejo' : 'trabajador';
    if (failures < 2) return base;
    return base === 'trabajador' ? 'complejo' : 'planeador';
  }

  private qualityFailure(taskId: string, from: TaskState, feedback: string): void {
    const exec = getExec(this.engine, this.run.run_id, taskId);
    const failures = exec.quality_failures + 1;
    this.exec(taskId, { quality_failures: failures, feedback: feedback.slice(0, 8000), last_error: feedback.split('\n')[0]!.slice(0, 300) });
    if (failures >= this.engine.config.ejecucion.intentos_calidad) {
      this.move(taskId, 'bloqueada', 'bloqueo', `falló ${failures} veces: ${feedback.split('\n')[0]}`);
      this.log(`✘ ${taskId} bloqueada tras ${failures} intentos`);
    } else {
      this.move(taskId, 'lista', 'fallo_calidad', feedback.split('\n')[0]);
      this.log(`↻ ${taskId} reintenta (${failures}/${this.engine.config.ejecucion.intentos_calidad}): ${feedback.split('\n')[0]!.slice(0, 120)}`);
    }
  }

  private readonly jobErrors = new Map<string, number>();

  /**
   * Runs one job per key. An unexpected exception is an environment problem: after
   * three in a row the task is blocked with the error instead of looping forever.
   */
  private spawnJob(key: string, fn: () => Promise<void>): void {
    if (this.jobs.has(key)) return;
    const taskId = key.split(':')[1]!;
    const p = fn()
      .then(() => {
        this.jobErrors.delete(key);
      })
      .catch((error: unknown) => {
        const message = (error as Error).message;
        const n = (this.jobErrors.get(key) ?? 0) + 1;
        this.jobErrors.set(key, n);
        this.log(`⚠ ${key}: ${message}`);
        if (n >= 3) {
          const current = this.tasks().find((t) => t.task_id === taskId);
          if (current && !['integrada', 'invalidada', 'cancelada', 'bloqueada'].includes(current.state)) {
            this.exec(taskId, { last_error: message.slice(0, 500) });
            this.move(taskId, 'bloqueada', 'bloqueo', `error interno repetido: ${message}`);
          }
          this.jobErrors.delete(key);
        }
      })
      .finally(() => this.jobs.delete(key));
    this.jobs.set(key, p);
  }

  /** Recovery at start (v2/05 · Reconciliación). */
  private async reconcile(): Promise<void> {
    for (const t of this.tasks()) {
      const exec = getExec(this.engine, this.run.run_id, t.task_id);
      if (t.state === 'reservada') {
        const status = exec.launch_dir ? launchStatus(exec.launch_dir) : null;
        if (!status) this.move(t.task_id, 'lista', 'reserva_liberada', 'recuperación: reserva sin lanzamiento');
        else {
          if (status.state === 'sin_iniciar') spawnRunner(exec.launch_dir!, this.engine.runnerScript);
          this.move(t.task_id, 'ejecutando', 'lanzamiento_iniciado', 'recuperación');
        }
      } else if (t.state === 'integrando' && exec.candidate_sha) {
        const tip = await refSha(this.repoPath, this.run.branch);
        if (await isAncestor(this.repoPath, exec.candidate_sha, tip)) {
          this.exec(t.task_id, { integrated_sha: tip });
          this.move(t.task_id, 'integrada', 'integracion_confirmada', 'recuperación: ya estaba integrada');
        }
      }
    }
  }

  async loop(): Promise<RunSummary> {
    await this.reconcile();
    this.engine.store.execute({ request_id: newId('req'), type: 'parametros_run', input: { runId: this.run.run_id } }, () => ({
      result: null,
      events: [{ type: EV.runParams, aggregate_type: 'run', aggregate_id: this.run.run_id, run_id: this.run.run_id, payload: { paralelo: this.parallel, revisor: this.opts.review ?? true } }],
    }));
    const pollMs = this.opts.pollMs ?? 1000;
    let stopping = false;
    this.opts.signal?.addEventListener('abort', () => {
      stopping = true;
      this.log('⏸ deteniendo: no se lanzan tareas nuevas; los agentes en curso siguen y se retoman con forja run');
    });
    for (;;) {
      // Unblock tasks whose dependencies are integrated (I04).
      for (const id of tasksReadyToUnblock(this.engine.store, this.run.run_id)) this.move(id, 'lista', 'dependencias_integradas');
      const tasks = this.tasks();

      if (!stopping) {
        for (const t of tasks) {
          if (t.state === 'ejecutando') this.spawnJob(`proc:${t.task_id}`, () => this.pollLaunch(t.task_id));
          if (t.state === 'verificando') this.spawnJob(`verif:${t.task_id}`, () => this.verify(t.task_id));
        }
        if (!this.integrating) {
          const next = tasks.filter((t) => t.state === 'verificada' || t.state === 'integrando').sort((a, b) => a.task_id.localeCompare(b.task_id))[0];
          if (next) {
            this.integrating = next.task_id;
            this.spawnJob(`integ:${next.task_id}`, () => this.integrate(next.task_id).finally(() => (this.integrating = null)));
          }
        }
        if (getRun(this.engine, this.run.run_id)!.state === 'ejecutando') this.launchReady(tasks);
        else return this.finish(getRun(this.engine, this.run.run_id)!.state, getRun(this.engine, this.run.run_id)!.detail);
      } else if (this.jobs.size === 0) {
        return this.finish('pausado', 'detenido por el usuario; los agentes en curso se retoman con forja run');
      }

      const now = this.tasks();
      if (now.every((t) => ['integrada', 'invalidada', 'cancelada'].includes(t.state))) return this.finish('completado');
      const active = now.filter((t) => ['reservada', 'ejecutando', 'verificando', 'verificada', 'integrando'].includes(t.state));
      if (!stopping && active.length === 0 && this.jobs.size === 0) {
        const ready = now.filter((t) => t.state === 'lista');
        if (ready.length > 0 && this.noProviderSince !== null && Date.now() - this.noProviderSince > 60_000) {
          return this.finish('pausado', 'no hay modelos disponibles (cuota agotada o sin sesión); vuelve a ejecutar más tarde');
        }
        if (ready.length === 0 && tasksReadyToUnblock(this.engine.store, this.run.run_id).length === 0) {
          const attention = now.filter((t) => t.state === 'bloqueada' || t.state === 'esperando_respuesta').map((t) => `${t.task_id} (${t.state})`);
          return this.finish('bloqueado', attention.length ? `necesitan atención: ${attention.join(', ')}` : 'hay tareas cuyas dependencias no se pueden integrar');
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  private noProviderSince: number | null = null;
  private lastNoProviderLog = 0;

  private budgetExceeded(): boolean {
    const row = this.engine.store.db.prepare('SELECT COALESCE(SUM(cost_micro), 0) AS c FROM usage WHERE run_id = ?').get(this.run.run_id) as { c: number };
    return row.c > this.engine.config.presupuesto.por_run_usd * 1_000_000;
  }

  private launchReady(tasks: TaskRow[]): void {
    const running = tasks.filter((t) => t.state === 'reservada' || t.state === 'ejecutando');
    let slots = this.parallel - running.length;
    if (slots <= 0) return;
    if (this.budgetExceeded()) {
      setRunState(this.engine, this.run.run_id, 'pausado', 'presupuesto del run agotado: amplíalo en forja.yaml (presupuesto.por_run_usd) y vuelve a ejecutar');
      this.log('⏸ presupuesto agotado: el run se pausa (no se escala de modelo)');
      return;
    }
    // Resources held until integration, so two tasks never write the same files concurrently.
    const held = new Set(
      tasks
        .filter((t) => ['reservada', 'ejecutando', 'verificando', 'verificada', 'integrando'].includes(t.state))
        .flatMap((t) => taskResources(this.plan, t.task_id)),
    );
    // Critical path first: tasks that unblock more work go earlier.
    const dependents = (id: string): number => this.plan.tareas.filter((t) => t.depende_de.includes(id)).reduce((a, t) => a + 1 + dependents(t.id), 0);
    const ready = tasks.filter((t) => t.state === 'lista').sort((a, b) => dependents(b.task_id) - dependents(a.task_id) || a.task_id.localeCompare(b.task_id));
    for (const t of ready) {
      if (slots <= 0) break;
      const resources = taskResources(this.plan, t.task_id);
      if (resources.some((r) => held.has(r))) continue;
      resources.forEach((r) => held.add(r));
      slots--;
      this.spawnJob(`lanzar:${t.task_id}`, () => this.launch(t.task_id));
    }
  }

  private async launch(taskId: string): Promise<void> {
    const task = this.task(taskId);
    const exec = getExec(this.engine, this.run.run_id, taskId);
    const role = this.levelFor(task, exec.quality_failures);
    const candidate = pickCandidate(this.engine, role);
    if (!candidate) {
      this.noProviderSince ??= Date.now();
      if (Date.now() - this.lastNoProviderLog > 30_000) {
        this.lastNoProviderLog = Date.now();
        this.log(`… ${taskId}: ningún modelo disponible para «${role}» (cuota o sesión); se reintenta más tarde`);
      }
      return;
    }
    this.noProviderSince = null;
    this.move(taskId, 'reservada', 'reservada');
    const attempt = exec.quality_failures + 1;
    this.exec(taskId, { attempt, level: role, provider: candidate.provider, model: candidate.model });
    try {
      const base = exec.worktree && existsSync(exec.worktree) ? exec.base_sha! : await refSha(this.repoPath, this.run.branch);
      const { path } = await taskWorktree(this.repoPath, this.dir(taskId), taskBranch(this.engine.config.git.prefijo, this.run.run_id, taskId), base);
      this.exec(taskId, { worktree: path, base_sha: base });
      const c = this.plan.perfil.comandos;
      if (c.instalar && existsSync(join(path, 'package.json')) && !existsSync(join(path, 'node_modules'))) {
        this.log(`⋯ ${taskId}: instalando dependencias`);
        const r = await runCommand({ ...this.cmd, networkHosts: this.plan.perfil.red_instalar }, path, c.instalar);
        if (!r.ok) throw new Error(`no se pudieron instalar dependencias: ${r.output.split('\n').slice(-3).join(' ')}`);
      }
      const fresh = getExec(this.engine, this.run.run_id, taskId);
      const built = await buildWorkerPrompt({ plan: this.plan, spec: this.spec, task, worktree: path, attempt, feedback: fresh.feedback, question: fresh.question, answer: fresh.answer });
      const prompt = this.opts.gateway
        ? `${built.prompt}\n\n<herramientas_externas>\nSi la tarea necesita un efecto fuera del repositorio (un servicio, una API), usa la herramienta MCP «forja» proponer_accion: queda pendiente de aprobación humana y NO se ejecuta. No intentes llegar al servicio de otra forma.\n</herramientas_externas>`
        : built.prompt;
      const launchId = newId('lan');
      const dir = launchDir(this.engine.dataDir, launchId);
      // Intent before effect: the launch id is durable before the runner exists.
      this.exec(taskId, { launch_id: launchId, launch_dir: dir });
      const adapter = this.engine.adapters[candidate.provider];
      const mcpSocket = this.opts.gateway ? await this.opts.gateway.socketFor(`agente ${taskId} · ${this.run.run_id}`) : undefined;
      startLaunch(
        this.engine.dataDir,
        adapter,
        {
          launchId,
          fencingToken: attempt,
          runId: this.run.run_id,
          taskId,
          attempt,
          model: candidate.model,
          prompt,
          workspace: path,
          providerStateDir: join(this.engine.dataDir, 'proveedores', candidate.provider),
          tools: 'edicion',
          timeoutMs: this.engine.config.ejecucion.timeout_min * 60_000,
          ...(task.red ? { extraHosts: this.plan.perfil.red_instalar } : {}),
          ...(candidate.provider === 'simulado' && this.engine.simulation ? { simulationScript: this.engine.simulation({ role, prompt, attempt, taskId }) } : {}),
          ...(mcpSocket ? { mcpSocket } : {}),
        },
        this.engine.runnerScript,
      );
      this.move(taskId, 'ejecutando', 'lanzamiento_iniciado');
      this.launchErrors.delete(taskId);
      this.log(`▶ ${taskId} ${task.titulo} · ${candidate.ref} (intento ${attempt})`);
    } catch (error) {
      const message = (error as Error).message;
      this.exec(taskId, { last_error: message.slice(0, 500) });
      // A launch that cannot even start will not fix itself: stop after a few tries instead of looping.
      const n = (this.launchErrors.get(taskId) ?? 0) + 1;
      this.launchErrors.set(taskId, n);
      if (n >= 3) {
        this.launchErrors.delete(taskId);
        this.move(taskId, 'bloqueada', 'bloqueo', `no se pudo lanzar el agente ${n} veces: ${message}`);
        this.log(`✘ ${taskId} bloqueada: no se pudo lanzar el agente (${message})`);
      } else {
        this.move(taskId, 'lista', 'fallo_entorno', message);
        this.log(`⚠ ${taskId}: ${message}`);
      }
    }
  }

  private readonly launchErrors = new Map<string, number>();

  private async pollLaunch(taskId: string): Promise<void> {
    const exec = getExec(this.engine, this.run.run_id, taskId);
    if (!exec.launch_dir) return;
    const status = launchStatus(exec.launch_dir);
    if (status.state === 'corriendo') return;
    if (status.state === 'sin_iniciar') {
      spawnRunner(exec.launch_dir, this.engine.runnerScript);
      return;
    }
    const parser = exec.provider === 'codex' ? 'codex' : 'claude';
    const outcome = await readOutcome(exec.launch_dir, parser);
    recordUsage(this.engine, { role: (exec.level as Role) ?? 'trabajador', scope: { run_id: this.run.run_id, task_id: taskId } }, exec.launch_id!, exec.provider ?? '?', exec.model ?? '?', outcome);
    if (status.state === 'interrumpido') {
      // Interruption is not a quality failure (R09): relaunch on the same workspace.
      this.exec(taskId, { feedback: 'El proceso anterior se interrumpió. Tu trabajo parcial sigue en el directorio: revísalo y termina la tarea.' });
      this.move(taskId, 'lista', 'fallo_entorno', 'lanzamiento interrumpido');
      this.log(`↻ ${taskId}: el agente se interrumpió; se relanza sin contar como fallo`);
      return;
    }
    const err = outcome.summary.error;
    if (err && (err.category === 'quota' || err.category === 'auth')) {
      pauseProvider(this.engine, `${exec.provider}:${exec.model}`, err.message.slice(0, 100), err.retryAfterMs ?? 15 * 60_000);
      this.move(taskId, 'lista', 'proveedor_no_disponible', err.message);
      this.log(`⏸ ${exec.provider}: ${err.category === 'quota' ? 'cuota agotada' : 'sin sesión'}; ${taskId} usará otro modelo`);
      return;
    }
    const question = extractQuestion(outcome.summary.text);
    if (question) {
      this.exec(taskId, { question, answer: null });
      this.move(taskId, 'esperando_respuesta', 'pregunta', question);
      this.log(`? ${taskId} pregunta: ${question.split('\n')[0]}`);
      return;
    }
    const task = this.task(taskId);
    const protectedPaths = this.plan.tareas.filter((t) => t.tipo === 'pruebas' && t.id !== taskId).flatMap((t) => t.escribe);
    const capture = await captureTask(exec.worktree!, {
      baseSha: exec.base_sha!,
      allow: task.escribe,
      protectedPaths,
      message: `forja(${taskId}): ${task.titulo}`,
      redactor: this.redactor,
    });
    const problems = [...capture.violations, ...capture.secretFindings];
    if (problems.length > 0) {
      await resetWorktree(exec.worktree!, exec.base_sha!);
      this.qualityFailure(taskId, 'ejecutando', `El cambio se rechazó antes de verificar:\n${problems.map((p) => `- ${p}`).join('\n')}\nModifica sólo ${task.escribe.join(', ')}.`);
      return;
    }
    if (!capture.sha) {
      const why = err ? `${err.category}: ${err.message}` : outcome.summary.status === 'completed' ? 'terminó sin modificar ningún archivo' : 'terminó sin resultado';
      this.qualityFailure(taskId, 'ejecutando', `El intento no produjo cambios (${why}).`);
      return;
    }
    this.exec(taskId, { candidate_sha: capture.sha, files: JSON.stringify(capture.changes.map((c) => c.path)) });
    this.move(taskId, 'verificando', 'proceso_terminado');
    this.log(`✎ ${taskId}: ${capture.changes.length} archivo(s) cambiados; verificando`);
  }

  private async verify(taskId: string): Promise<void> {
    const exec = getExec(this.engine, this.run.run_id, taskId);
    const task = this.task(taskId);
    // Verify the candidate as it will really end up: merged onto the current integration tip.
    const tip = await refSha(this.repoPath, this.run.branch);
    const wt = await detachedWorktree(this.repoPath, this.dir(`verif-${taskId}`), tip);
    const merged = await mergeCandidate(wt, tip, exec.candidate_sha!, `forja: verificar ${taskId}`);
    if ('conflicts' in merged) {
      if (exec.worktree) await removeWorktree(this.repoPath, exec.worktree);
      this.exec(taskId, { worktree: null, feedback: `Tu cambio choca con lo ya integrado (${merged.conflicts.join(', ')}). Rehaz la tarea sobre la base nueva.` });
      this.move(taskId, 'lista', 'conflicto_integracion', merged.conflicts.join(', '));
      this.log(`⚡ ${taskId}: conflicto con lo integrado; se rehace sobre la base nueva`);
      return;
    }
    const v = await verifyTask(this.engine, {
      plan: this.plan,
      spec: this.spec,
      task,
      worktree: wt,
      baseSha: tip,
      candidateSha: merged.sha,
      changedFiles: JSON.parse(exec.files ?? '[]') as string[],
      greenTests: await this.greenTests(tip),
      cmd: this.cmd,
      runId: this.run.run_id,
      review: this.opts.review ?? true,
    });
    this.exec(taskId, { steps: JSON.stringify(v.steps) });
    if (v.ok) {
      this.move(taskId, 'verificada', 'verificacion_aprobada');
      this.log(`✔ ${taskId} verificada (${v.steps.map((s) => s.paso).join(', ')})`);
    } else if (v.environmentFailure) {
      this.exec(taskId, { last_error: v.steps.at(-1)?.detalle.slice(-300) ?? 'entorno' });
      this.move(taskId, 'lista', 'fallo_entorno', v.steps.at(-1)?.paso);
      this.log(`⚠ ${taskId}: problema del entorno en «${v.steps.at(-1)?.paso}»; se reintenta sin escalar`);
    } else {
      this.qualityFailure(taskId, 'verificando', v.feedback);
    }
  }

  private async integrate(taskId: string): Promise<void> {
    const task = this.tasks().find((t) => t.task_id === taskId);
    if (task?.state === 'verificada') this.move(taskId, 'integrando', 'integracion_iniciada');
    const exec = getExec(this.engine, this.run.run_id, taskId);
    const def = this.task(taskId);
    const wtPath = this.dir('integracion');
    for (let tries = 0; tries < 3; tries++) {
      const target = await refSha(this.repoPath, this.run.branch);
      if (await isAncestor(this.repoPath, exec.candidate_sha!, target)) {
        this.exec(taskId, { integrated_sha: target });
        this.move(taskId, 'integrada', 'integracion_confirmada');
        return;
      }
      await detachedWorktree(this.repoPath, wtPath, target);
      const merged = await mergeCandidate(wtPath, target, exec.candidate_sha!, `forja: integrar ${taskId} · ${def.titulo}`);
      if ('conflicts' in merged) {
        if (exec.worktree) await removeWorktree(this.repoPath, exec.worktree);
        this.exec(taskId, { worktree: null, feedback: `Tu cambio anterior chocó con lo que se integró mientras trabajabas (${merged.conflicts.join(', ')}). Rehaz la tarea sobre la base nueva.` });
        this.move(taskId, 'lista', 'conflicto_integracion', merged.conflicts.join(', '));
        this.log(`⚡ ${taskId}: conflicto al integrar (${merged.conflicts.join(', ')}); se rehace sobre la base nueva`);
        return;
      }
      // Full check on the merged candidate before publishing (v2/05 · Cola de integración).
      const c = this.plan.perfil.comandos;
      if (c.instalar && existsSync(join(wtPath, 'package.json'))) {
        const r = await runCommand({ ...this.cmd, networkHosts: this.plan.perfil.red_instalar }, wtPath, c.instalar);
        if (!r.ok) {
          this.move(taskId, 'lista', 'fallo_entorno', 'instalación en integración');
          return;
        }
      }
      for (const name of ['typecheck', 'build'] as const) {
        const recipe = c[name];
        if (!recipe) continue;
        const r = await runCommand(this.cmd, wtPath, recipe);
        if (!r.ok) {
          this.qualityFailure(taskId, 'integrando', `Al integrarlo con lo demás falló «${name}»:\n${r.output}`);
          return;
        }
      }
      if (c.test && def.tipo !== 'pruebas') {
        const own = [...acceptanceFilesFor(this.plan, def), ...(JSON.parse(exec.files ?? '[]') as string[]).filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f))];
        const selection = [...new Set([...(await this.greenTests(target)), ...own])].filter((f) => existsSync(join(wtPath, f)));
        if (selection.length) {
          const r = await runCommand(this.cmd, wtPath, c.test, selection);
          if (!r.ok) {
            this.qualityFailure(taskId, 'integrando', `Al integrarlo con lo demás fallaron las pruebas:\n${r.output}`);
            return;
          }
        }
      }
      if (await publishRef(this.repoPath, this.run.branch, merged.sha, target)) {
        this.exec(taskId, { integrated_sha: merged.sha });
        this.move(taskId, 'integrada', 'integracion_confirmada');
        if (exec.worktree) await removeWorktree(this.repoPath, exec.worktree);
        this.log(`⇪ ${taskId} integrada (${merged.sha.slice(0, 8)})`);
        return;
      }
      // The ref moved between check and publish: retry on the new tip.
    }
    this.move(taskId, 'lista', 'fallo_entorno', 'la rama de integración cambió varias veces durante la integración');
  }

  private async finish(state: RunState, detail: string | null = null): Promise<RunSummary> {
    await Promise.allSettled([...this.jobs.values()]);
    setRunState(this.engine, this.run.run_id, state, detail);
    const counts: Record<string, number> = {};
    for (const t of this.tasks()) counts[t.state] = (counts[t.state] ?? 0) + 1;
    let deliveryBranch: string | null = null;
    if (state === 'completado') {
      deliveryBranch = deliveryBranchName(this.engine.config.git.prefijo, this.run.change_id);
      const tip = await refSha(this.repoPath, this.run.branch);
      await git(this.repoPath, ['branch', '-f', deliveryBranch, tip]);
      const change = getChange(this.engine, this.run.change_id);
      if (change.phase === 'ejecutar') {
        this.engine.store.execute({ request_id: `entregar:${this.run.run_id}`, type: 'entregar', input: { runId: this.run.run_id } }, () => ({
          result: null,
          events: [{ type: EV.changePhase, aggregate_type: 'cambio', aggregate_id: this.run.change_id, payload: { from: 'ejecutar', to: 'entregado' } }],
        }));
      }
      await removeWorktree(this.repoPath, this.dir('integracion'));
      for (const t of this.plan.tareas) await removeWorktree(this.repoPath, this.dir(`verif-${t.id}`));
      this.writeReport(tip, deliveryBranch);
    }
    this.log(state === 'completado' ? `✔ run completado · rama ${deliveryBranch}` : `■ run ${state}${detail ? `: ${detail}` : ''}`);
    return { runId: this.run.run_id, state, counts, branch: this.run.branch, deliveryBranch };
  }

  private writeReport(tip: string, branch: string): void {
    const usage = this.engine.store.db
      .prepare('SELECT role, provider, model, COUNT(*) n, SUM(input) i, SUM(output) o, SUM(cost_micro) c FROM usage WHERE run_id = ? GROUP BY role, provider, model')
      .all(this.run.run_id) as { role: string; provider: string; model: string; n: number; i: number | null; o: number | null; c: number | null }[];
    const lines = [
      `# Informe de ejecución · ${this.run.run_id}`,
      '',
      `- Rama entregada: \`${branch}\` (${tip.slice(0, 12)}), desde \`${this.run.base_sha.slice(0, 12)}\``,
      `- Plan revisión ${this.run.plan_revision} · aprobación ${this.run.approval_id}`,
      '- La rama principal no se modificó. Para revisar: `git log --oneline ' + `${this.run.base_sha.slice(0, 12)}..${branch}` + '`',
      '',
      '## Tareas',
      '| Tarea | Estado | Intentos | Modelo | Verificación |',
      '|---|---|---|---|---|',
      ...this.tasks().map((t) => {
        const e = getExec(this.engine, this.run.run_id, t.task_id);
        const steps = (JSON.parse(e.steps ?? '[]') as { paso: string; ok: boolean }[]).map((s) => `${s.ok ? '✔' : '✘'} ${s.paso}`).join(' ');
        return `| ${t.task_id} ${this.task(t.task_id)?.titulo ?? ''} | ${t.state} | ${e.attempt} | ${e.provider ?? '—'}:${e.model ?? '—'} | ${steps || '—'} |`;
      }),
      '',
      '## Consumo',
      '| Rol | Modelo | Llamadas | Entrada | Salida | Costo equivalente |',
      '|---|---|---|---|---|---|',
      ...usage.map((u) => `| ${u.role} | ${u.provider}:${u.model} | ${u.n} | ${u.i ?? '?'} | ${u.o ?? '?'} | ${u.c === null ? 'desconocido' : `US$ ${(u.c / 1e6).toFixed(2)}`} |`),
      '',
    ];
    const dir = join(this.repoPath, '.forja', 'cambios', this.run.change_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'informe.md'), `${lines.join('\n')}\n`);
  }
}

/** Answer to a worker's question: the task goes back to the queue with the answer in its context. */
export function answerTaskQuestion(engine: Engine, runId: string, taskId: string, answer: string): void {
  const t = getTask(engine.store.db, runId, taskId);
  if (!t || t.state !== 'esperando_respuesta') throw new RunError(`la tarea ${taskId} no está esperando una respuesta`);
  engine.store.execute({ request_id: newId('req'), type: 'responder_tarea', input: { taskId } }, () => ({
    result: null,
    events: [{ type: EV.taskExec, aggregate_type: 'tarea', aggregate_id: `${runId}/${taskId}`, run_id: runId, task_id: taskId, payload: { answer } }],
  }));
  changeTaskState(engine.store, newId('req'), { run_id: runId, task_id: taskId, to: 'lista', reason: 'causa_resuelta' });
}

/** Retry a blocked task from scratch counting (explicit user decision). */
export function unblockTask(engine: Engine, runId: string, taskId: string, note: string | null): void {
  const t = getTask(engine.store.db, runId, taskId);
  if (!t || t.state !== 'bloqueada') throw new RunError(`la tarea ${taskId} no está bloqueada`);
  engine.store.execute({ request_id: newId('req'), type: 'desbloquear_tarea', input: { taskId } }, () => ({
    result: null,
    events: [
      { type: EV.taskExec, aggregate_type: 'tarea', aggregate_id: `${runId}/${taskId}`, run_id: runId, task_id: taskId, payload: { quality_failures: 0, ...(note ? { feedback: note } : {}) } },
    ],
  }));
  changeTaskState(engine.store, newId('req'), { run_id: runId, task_id: taskId, to: 'lista', reason: 'causa_resuelta' });
}
