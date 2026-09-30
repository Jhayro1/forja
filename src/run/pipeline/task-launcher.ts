import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { accountFor, accountParams, effortParam, type ProviderRef, parseRef, pickCandidate, pinnedAvailable } from '../../core/engine.js';
import { newId } from '../../domain/ids.js';
import { refSha, removeWorktree, taskBranch, taskWorktree } from '../../git/workspace.js';
import type { GatewayHost } from '../../mcp/gateway.js';
import { hashFilesIn, LessonService } from '../../memory/lessons.js';
import { startLaunch } from '../../runtime/launch-service.js';
import { launchDir } from '../../runtime/launcher.js';
import { runCommand } from '../../verify/commands.js';
import { buildWorkerPrompt } from '../context.js';
import { buildTeamLedger, exportsReader } from '../team.js';
import { GraphContext } from './graph-context.js';
import type { RunContext } from './run-context.js';
import { levelFor } from './scheduler.js';

/** Who is calling through a launch's socket: the socket, not the agent, decides it. */
export const gatewayOrigin = (taskId: string, runId: string) => `agente ${taskId} · ${runId}`;

const CONTEXT_NOTE =
  '\n<contexto_bajo_pedido>\nSi te falta contexto (una decisión, archivos relacionados o quién usa un archivo), pídelo con la herramienta MCP «forja» pedir_contexto indicando el motivo, en vez de recorrer el repositorio a ciegas.\n</contexto_bajo_pedido>';

const TEAM_NOTE = '\n<equipo_en_vivo>\nEn tareas largas, consulta la herramienta MCP «forja» equipo para ver qué terminaron o empezaron otras tareas desde que arrancaste.\n</equipo_en_vivo>';

const SAME_SESSION_NOTE =
  '<misma_sesion>\nSigues en la misma sesión: ya hiciste las tareas anteriores de este bloque en esta carpeta y el resultado ya está integrado. Aprovecha lo que recuerdas, pero la tarea de ahora es SOLO la que sigue; no rehagas ni cambies lo anterior salvo que esta tarea lo pida.\n</misma_sesion>';

const EXTERNAL_TOOLS_NOTE =
  '<herramientas_externas>\nSi la tarea necesita un efecto fuera del repositorio (un servicio, una API), usa la herramienta MCP «forja» proponer_accion: queda pendiente de aprobación humana y NO se ejecuta. No intentes llegar al servicio de otra forma.\n</herramientas_externas>';

/**
 * Prepares and starts one attempt of a task: model choice (the role's order or
 * the model the user pinned), worktree, dependencies, context and the detached
 * runner. Intent is recorded before every effect so a restart can reconcile.
 */
export class TaskLauncher {
  private readonly graph: GraphContext;
  private readonly exportsOf: ReturnType<typeof exportsReader>;
  private noProviderSince: number | null = null;
  private lastNoProviderLog = 0;

  constructor(
    private readonly ctx: RunContext,
    private readonly gateway?: GatewayHost,
    graph?: GraphContext,
    private readonly block?: { tasks: string[]; model?: string },
  ) {
    this.graph = graph ?? new GraphContext(ctx);
    this.exportsOf = exportsReader(ctx.repoPath);
  }

  /** The team ledger for one task, also served live through the gateway's «equipo» tool. */
  team(taskId: string) {
    const { ctx } = this;
    return buildTeamLedger({ plan: ctx.plan, tasks: ctx.tasks(), exec: (id) => ctx.execOf(id), exportsOf: this.exportsOf }, taskId);
  }

  /** Milliseconds without any usable model while tasks wait (null: models available). */
  get starvedForMs(): number | null {
    return this.noProviderSince === null ? null : Date.now() - this.noProviderSince;
  }

  private candidateFor(_taskId: string, role: ReturnType<typeof levelFor>, pinned: string | null): ProviderRef | null {
    if (!pinned) return pickCandidate(this.ctx.engine, role);
    if (!pinnedAvailable(this.ctx.engine, pinned)) return null;
    return { ref: pinned, ...parseRef(pinned) };
  }

  /**
   * Block mode runs every task in ONE folder: Claude Code keys its sessions by folder, so
   * this is what lets the next task continue the same session. Only one task of a block
   * runs at a time; the folder is taken over once its previous task left it (integrated,
   * or cancelled), and a task finds it busy only if an earlier one is still unresolved.
   */
  private async worktreeFolder(taskId: string): Promise<string> {
    const { ctx } = this;
    if (!this.block) return ctx.dir(taskId);
    const shared = ctx.dir('_agente');
    if (!existsSync(shared)) return shared;
    const owner = ctx.tasks().find((t) => t.task_id !== taskId && ctx.execOf(t.task_id).worktree === shared && !['integrada', 'cancelada', 'invalidada'].includes(t.state));
    if (owner) return ctx.dir(taskId);
    await removeWorktree(ctx.repoPath, shared);
    return shared;
  }

  /**
   * The session this attempt continues: the task's own previous attempt, or the last task
   * of the block that ran in the same folder with the same model — while its context has
   * room (ejecucion.sesion_max_tokens). Otherwise a new session, whose prompt already
   * carries the team ledger with what each finished task did (the handover summary).
   */
  private sessionToContinue(taskId: string, folder: string, provider: string, model: string): string | null {
    if (!this.block) return null;
    const row = this.ctx.engine.store.db
      .prepare('SELECT task_id, session_id, context_tokens, provider, model FROM task_exec WHERE run_id = ? AND worktree = ? AND session_id IS NOT NULL ORDER BY updated_seq DESC LIMIT 1')
      .get(this.ctx.runId, folder) as { task_id: string; session_id: string; context_tokens: number | null; provider: string | null; model: string | null } | undefined;
    if (!row || row.provider !== provider || row.model !== model) return null;
    if (row.context_tokens !== null && row.context_tokens >= this.ctx.engine.config.ejecucion.sesion_max_tokens) {
      this.ctx.log(`⋯ ${taskId}: la sesión anterior ya lleva ${Math.round(row.context_tokens / 1000)}k tokens; empieza una nueva con el resumen de lo hecho`);
      return null;
    }
    return row.session_id;
  }

  async launch(taskId: string): Promise<void> {
    const { ctx } = this;
    const { engine, plan, run } = ctx;
    const task = ctx.task(taskId);
    const exec = ctx.execOf(taskId);
    const role = levelFor(task, exec.quality_failures);
    // A reassignment by the user wins; otherwise the model chosen for the block.
    const candidate = this.candidateFor(taskId, role, exec.pinned_model ?? this.block?.model ?? null);
    if (!candidate) {
      this.noProviderSince ??= Date.now();
      if (Date.now() - this.lastNoProviderLog > 30_000) {
        this.lastNoProviderLog = Date.now();
        ctx.log(`… ${taskId}: ningún modelo disponible para «${exec.pinned_model ?? role}» (cuota o sesión); se reintenta más tarde`);
      }
      return;
    }
    // With several accounts, the least busy one takes the task (v3 §4.9).
    const account = accountFor(engine, candidate.provider, 'reparto');
    if (account === null) return;
    this.noProviderSince = null;
    ctx.move(taskId, 'reservada', 'reservada');
    const attempt = exec.quality_failures + 1;
    ctx.exec(taskId, { attempt, level: role, provider: candidate.provider, model: candidate.model, account: account?.alias ?? null });
    try {
      const reuse = Boolean(exec.worktree && existsSync(exec.worktree));
      const base = reuse ? exec.base_sha! : await refSha(ctx.repoPath, run.branch);
      const folder = reuse ? exec.worktree! : await this.worktreeFolder(taskId);
      const { path } = await taskWorktree(ctx.repoPath, folder, taskBranch(engine.config.git.prefijo, run.run_id, taskId), base);
      ctx.exec(taskId, { worktree: path, base_sha: base });
      const c = plan.perfil.comandos;
      if (c.instalar && existsSync(join(path, 'package.json')) && !existsSync(join(path, 'node_modules'))) {
        ctx.log(`⋯ ${taskId}: instalando dependencias`);
        const r = await runCommand({ ...ctx.cmd, networkHosts: plan.perfil.red_instalar }, path, c.instalar);
        if (!r.ok) throw new Error(`no se pudieron instalar dependencias: ${r.output.split('\n').slice(-3).join(' ')}`);
      }
      const fresh = ctx.execOf(taskId);
      const related = await this.graph.relatedFiles(task, path);
      // Lessons whose files changed since approval wait for a human to revalidate them (MEJORAS 5.7).
      const lessons = new LessonService(engine.store).forTask(task, hashFilesIn(path)).map((l) => ({ id: l.lesson_id, text: l.text }));
      const team = await this.team(taskId);
      const built = await buildWorkerPrompt({ plan, spec: ctx.spec, task, worktree: path, attempt, feedback: fresh.feedback, question: fresh.question, answer: fresh.answer, related, lessons, team });
      const session = this.sessionToContinue(taskId, path, candidate.provider, candidate.model);
      const withTools = this.gateway ? `${built.prompt}\n\n${EXTERNAL_TOOLS_NOTE}${TEAM_NOTE}${this.gateway.offersContext ? CONTEXT_NOTE : ''}` : built.prompt;
      const prompt = session ? `${SAME_SESSION_NOTE}\n\n${withTools}` : withTools;
      const launchId = newId('lan');
      const dir = launchDir(engine.dataDir, launchId);
      // Intent before effect: the launch id is durable before the runner exists.
      ctx.exec(taskId, { launch_id: launchId, launch_dir: dir });
      const mcpSocket = this.gateway
        ? await this.gateway.socketFor(gatewayOrigin(taskId, run.run_id), launchId, { runId: run.run_id, taskId }, async () => JSON.stringify(await this.team(taskId)))
        : undefined;
      startLaunch(
        engine.dataDir,
        engine.adapters[candidate.provider],
        {
          launchId,
          fencingToken: attempt,
          runId: run.run_id,
          taskId,
          attempt,
          model: candidate.model,
          ...effortParam(engine.config, role, candidate.ref),
          prompt,
          workspace: path,
          ...accountParams(engine, candidate.provider, account),
          tools: 'edicion',
          timeoutMs: engine.config.ejecucion.timeout_min * 60_000,
          ...(task.red ? { extraHosts: plan.perfil.red_instalar } : {}),
          ...(candidate.provider === 'simulado' && engine.simulation ? { simulationScript: engine.simulation({ role, prompt, attempt, taskId }) } : {}),
          ...(mcpSocket ? { mcpSocket } : {}),
          ...(session ? { resumeSessionId: session } : {}),
        },
        engine.runnerScript,
      );
      if (session) ctx.log(`↪ ${taskId} sigue la sesión ${session.slice(0, 8)} del agente (recuerda las tareas anteriores del bloque)`);
      ctx.move(taskId, 'ejecutando', 'lanzamiento_iniciado');
      ctx.log(`▶ ${taskId} ${task.titulo} · ${candidate.ref}${account && account.alias !== 'principal' ? ` @${account.alias}` : ''}${exec.pinned_model ? ' (reasignada)' : ''} (intento ${attempt})`);
    } catch (error) {
      // A launch that cannot even start will not fix itself: bounded, then blocked.
      ctx.environmentFailure(taskId, `no se pudo lanzar el agente: ${(error as Error).message}`);
    }
  }
}
