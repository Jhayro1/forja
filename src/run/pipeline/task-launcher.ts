import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { accountFor, accountParams, effortParam, type ProviderRef, parseRef, pickCandidate, pinnedAvailable } from '../../core/engine.js';
import { newId } from '../../domain/ids.js';
import { refSha, taskBranch, taskWorktree } from '../../git/workspace.js';
import type { GatewayHost } from '../../mcp/gateway.js';
import { hashFilesIn, LessonService } from '../../memory/lessons.js';
import { startLaunch } from '../../runtime/launch-service.js';
import { launchDir } from '../../runtime/launcher.js';
import { runCommand } from '../../verify/commands.js';
import { buildWorkerPrompt } from '../context.js';
import { GraphContext } from './graph-context.js';
import type { RunContext } from './run-context.js';
import { levelFor } from './scheduler.js';

/** Who is calling through a launch's socket: the socket, not the agent, decides it. */
export const gatewayOrigin = (taskId: string, runId: string) => `agente ${taskId} · ${runId}`;

const CONTEXT_NOTE =
  '\n<contexto_bajo_pedido>\nSi te falta contexto (una decisión, archivos relacionados o quién usa un archivo), pídelo con la herramienta MCP «forja» pedir_contexto indicando el motivo, en vez de recorrer el repositorio a ciegas.\n</contexto_bajo_pedido>';

const EXTERNAL_TOOLS_NOTE =
  '<herramientas_externas>\nSi la tarea necesita un efecto fuera del repositorio (un servicio, una API), usa la herramienta MCP «forja» proponer_accion: queda pendiente de aprobación humana y NO se ejecuta. No intentes llegar al servicio de otra forma.\n</herramientas_externas>';

/**
 * Prepares and starts one attempt of a task: model choice (the role's order or
 * the model the user pinned), worktree, dependencies, context and the detached
 * runner. Intent is recorded before every effect so a restart can reconcile.
 */
export class TaskLauncher {
  private readonly graph: GraphContext;
  private noProviderSince: number | null = null;
  private lastNoProviderLog = 0;

  constructor(
    private readonly ctx: RunContext,
    private readonly gateway?: GatewayHost,
    graph?: GraphContext,
  ) {
    this.graph = graph ?? new GraphContext(ctx);
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

  async launch(taskId: string): Promise<void> {
    const { ctx } = this;
    const { engine, plan, run } = ctx;
    const task = ctx.task(taskId);
    const exec = ctx.execOf(taskId);
    const role = levelFor(task, exec.quality_failures);
    const candidate = this.candidateFor(taskId, role, exec.pinned_model);
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
      const base = exec.worktree && existsSync(exec.worktree) ? exec.base_sha! : await refSha(ctx.repoPath, run.branch);
      const { path } = await taskWorktree(ctx.repoPath, ctx.dir(taskId), taskBranch(engine.config.git.prefijo, run.run_id, taskId), base);
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
      const built = await buildWorkerPrompt({ plan, spec: ctx.spec, task, worktree: path, attempt, feedback: fresh.feedback, question: fresh.question, answer: fresh.answer, related, lessons });
      const prompt = this.gateway ? `${built.prompt}\n\n${EXTERNAL_TOOLS_NOTE}${this.gateway.offersContext ? CONTEXT_NOTE : ''}` : built.prompt;
      const launchId = newId('lan');
      const dir = launchDir(engine.dataDir, launchId);
      // Intent before effect: the launch id is durable before the runner exists.
      ctx.exec(taskId, { launch_id: launchId, launch_dir: dir });
      const mcpSocket = this.gateway ? await this.gateway.socketFor(gatewayOrigin(taskId, run.run_id), launchId, { runId: run.run_id, taskId }) : undefined;
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
        },
        engine.runnerScript,
      );
      ctx.move(taskId, 'ejecutando', 'lanzamiento_iniciado');
      ctx.log(`▶ ${taskId} ${task.titulo} · ${candidate.ref}${account && account.alias !== 'principal' ? ` @${account.alias}` : ''}${exec.pinned_model ? ' (reasignada)' : ''} (intento ${attempt})`);
    } catch (error) {
      // A launch that cannot even start will not fix itself: bounded, then blocked.
      ctx.environmentFailure(taskId, `no se pudo lanzar el agente: ${(error as Error).message}`);
    }
  }
}
