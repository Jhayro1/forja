import { join } from 'node:path';
import { newId } from '../domain/ids.js';
import { AdapterError, ClaudeAdapter, CodexAdapter, SimulatedAdapter, type LaunchParams, type ProviderAdapter, type ToolProfile } from '../providers/adapters.js';
import type { ForjaConfig } from '../registry/config.js';
import { runToCompletion, type LaunchOutcome } from '../runtime/launch-service.js';
import type { EventStore } from '../store/event-store.js';
import { EV } from '../store/planning-projections.js';

export type Role = keyof ForjaConfig['roles'];

/** Script for the simulated provider, chosen per call (tests and demos). */
export type Simulation = (call: { role: Role; prompt: string; attempt: number; taskId: string }) => object;

export type Engine = {
  store: EventStore;
  dataDir: string;
  config: ForjaConfig;
  adapters: Record<'claude' | 'codex' | 'simulado', ProviderAdapter>;
  runnerScript?: string;
  simulation?: Simulation;
  /** Providers paused in this process after a quota/auth answer (until restart or the given time). */
  paused: Map<string, { until: number; reason: string }>;
};

export function createEngine(opts: {
  store: EventStore;
  dataDir: string;
  config: ForjaConfig;
  runnerScript?: string;
  simulation?: Simulation;
  adapters?: Partial<Engine['adapters']>;
}): Engine {
  return {
    store: opts.store,
    dataDir: opts.dataDir,
    config: opts.config,
    adapters: {
      claude: opts.adapters?.claude ?? new ClaudeAdapter(),
      codex: opts.adapters?.codex ?? new CodexAdapter(),
      simulado: opts.adapters?.simulado ?? new SimulatedAdapter(),
    },
    ...(opts.runnerScript ? { runnerScript: opts.runnerScript } : {}),
    ...(opts.simulation ? { simulation: opts.simulation } : {}),
    paused: new Map(),
  };
}

export type CallScope = { change_id?: string; run_id?: string; task_id?: string };

export type CallOptions = {
  role: Role;
  prompt: string;
  tools: ToolProfile;
  workspace: string;
  workspaceReadOnly?: boolean;
  outputSchema?: object;
  scope: CallScope;
  timeoutMs?: number;
  attempt?: number;
  extraHosts?: string[];
  resumeSessionId?: string;
  /** Restrict to these candidates (e.g. a retry pinned to another provider). */
  candidates?: string[];
  extraMounts?: LaunchParams['extraMounts'];
};

export type CallResult = { outcome: LaunchOutcome; provider: string; model: string; launchId: string; skipped: string[] };

export class NoProviderError extends Error {
  constructor(readonly reasons: string[]) {
    super(`ningún modelo disponible para este rol:\n${reasons.map((r) => `  - ${r}`).join('\n')}`);
  }
}

function parseRef(ref: string): { provider: 'claude' | 'codex' | 'simulado'; model: string } {
  const [provider, model] = ref.split(':') as ['claude' | 'codex' | 'simulado', string];
  return { provider, model };
}

/**
 * Runs one call for a role. Candidates are tried in configured order; quota and
 * auth problems move to the next candidate of the SAME role — they never escalate
 * to a more expensive role (R09).
 */
export async function callRole(engine: Engine, opts: CallOptions): Promise<CallResult> {
  const candidates = opts.candidates ?? engine.config.roles[opts.role];
  const skipped: string[] = [];
  for (const ref of candidates) {
    const { provider, model } = parseRef(ref);
    // Real providers share one quota per account; simulated models are independent.
    const pauseKey = provider === 'simulado' ? ref : provider;
    const pause = engine.paused.get(pauseKey);
    if (pause && pause.until > Date.now()) {
      skipped.push(`${ref}: en pausa (${pause.reason})`);
      continue;
    }
    const adapter = engine.adapters[provider];
    const launchId = newId('lan');
    const params: Omit<LaunchParams, 'inputsDir'> = {
      launchId,
      fencingToken: 1,
      runId: opts.scope.run_id ?? 'planificacion',
      taskId: opts.scope.task_id ?? opts.role,
      attempt: opts.attempt ?? 1,
      model,
      prompt: opts.prompt,
      workspace: opts.workspace,
      providerStateDir: join(engine.dataDir, 'proveedores', provider),
      tools: opts.tools,
      timeoutMs: opts.timeoutMs ?? engine.config.ejecucion.timeout_min * 60_000,
      ...(opts.workspaceReadOnly ? { workspaceReadOnly: true } : {}),
      ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
      ...(opts.extraHosts ? { extraHosts: opts.extraHosts } : {}),
      ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
      ...(opts.extraMounts ? { extraMounts: opts.extraMounts } : {}),
      ...(provider === 'simulado' && engine.simulation
        ? { simulationScript: engine.simulation({ role: opts.role, prompt: opts.prompt, attempt: opts.attempt ?? 1, taskId: opts.scope.task_id ?? opts.role }) }
        : {}),
    };
    let outcome: LaunchOutcome;
    try {
      outcome = await runToCompletion(engine.dataDir, adapter, params, engine.runnerScript ? { runnerScript: engine.runnerScript } : {});
    } catch (error) {
      if (error instanceof AdapterError) {
        skipped.push(`${ref}: ${error.message}`);
        continue;
      }
      throw error;
    }
    recordUsage(engine, opts, launchId, provider, model, outcome);
    const err = outcome.summary.error;
    if (err && (err.category === 'quota' || err.category === 'auth')) {
      engine.paused.set(pauseKey, { until: Date.now() + (err.retryAfterMs ?? 15 * 60_000), reason: err.message.slice(0, 120) });
      skipped.push(`${ref}: ${err.category === 'quota' ? 'cuota agotada' : 'sin sesión'} (${err.message.slice(0, 100)})`);
      continue;
    }
    return { outcome, provider, model, launchId, skipped };
  }
  throw new NoProviderError(skipped);
}

function recordUsage(engine: Engine, opts: CallOptions, launchId: string, provider: string, model: string, outcome: LaunchOutcome): void {
  // Session-accumulated counters: the last report is the total for this launch.
  const last = outcome.summary.usage.at(-1);
  const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'): number | null => {
    if (outcome.summary.usage.length === 0) return null;
    if (last?.semantics === 'acumulado_sesion') return last[key];
    let total = 0;
    for (const u of outcome.summary.usage) {
      if (u[key] === null) return null;
      total += u[key]!;
    }
    return total;
  };
  const scope = opts.scope;
  engine.store.execute(
    { request_id: `uso:${launchId}`, type: 'registrar_uso', input: { launchId } },
    () => ({
      result: null,
      events: [
        {
          type: EV.usage,
          aggregate_type: scope.task_id ? 'tarea' : 'cambio',
          aggregate_id: scope.task_id ? `${scope.run_id}/${scope.task_id}` : (scope.change_id ?? 'sin_cambio'),
          ...(scope.run_id ? { run_id: scope.run_id } : {}),
          ...(scope.task_id ? { task_id: scope.task_id } : {}),
          launch_id: launchId,
          payload: {
            launch_id: launchId,
            role: opts.role,
            provider,
            model: outcome.summary.model ?? model,
            input: sum('inputTokens'),
            output: sum('outputTokens'),
            cache_read: sum('cacheReadTokens'),
            cache_write: sum('cacheWriteTokens'),
            cost_micro: last?.semantics === 'acumulado_sesion' ? last.costEquivalentMicroUsd : null,
          },
        },
      ],
    }),
  );
}
