import { join } from 'node:path';
import { newId } from '../domain/ids.js';
import type { Prices } from '../plan/estimate.js';
import { type AccountChoice, type AccountProvider, type AccountStore, accountPauseKey, chooseAccount, PRINCIPAL } from '../providers/accounts.js';
import { AdapterError, ClaudeAdapter, CodexAdapter, type LaunchParams, type ProviderAdapter, SimulatedAdapter, type ToolProfile } from '../providers/adapters.js';
import { effortFor } from '../providers/catalog.js';
import type { ForjaConfig } from '../registry/config.js';
import { type LaunchOutcome, runToCompletion } from '../runtime/launch-service.js';
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
  /** USD per million tokens per `proveedor:modelo` (~/.forja/precios.yaml), to estimate costs a provider does not report. */
  prices?: Prices;
  /** Accounts per provider (v3 §4.9); without it every launch uses the CLI's default session. */
  accounts?: AccountStore;
};

export function createEngine(opts: {
  store: EventStore;
  dataDir: string;
  config: ForjaConfig;
  runnerScript?: string;
  simulation?: Simulation;
  adapters?: Partial<Engine['adapters']>;
  prices?: Prices | null;
  accounts?: AccountStore;
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
    ...(opts.prices ? { prices: opts.prices } : {}),
    ...(opts.accounts ? { accounts: opts.accounts } : {}),
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

export type ProviderRef = { ref: string; provider: 'claude' | 'codex' | 'simulado'; model: string };
export type ProviderPause = { key: string; until: number; reason: string };

/** Real providers share one quota per account; simulated models are independent. */
export const pauseKeyOf = (ref: string): string => {
  const { provider } = parseRef(ref);
  return provider === 'simulado' ? ref : provider;
};

/**
 * Pauses are events (`proveedor.pausado`), not process memory: the board, the
 * panel and `forja estado` show them, and a restarted `forja run` respects them.
 */
export function activePauses(engine: Engine, now = Date.now()): ProviderPause[] {
  const rows = engine.store.db.prepare('SELECT pause_key, until, reason FROM provider_pauses').all() as { pause_key: string; until: string; reason: string }[];
  return rows.map((r) => ({ key: r.pause_key, until: Date.parse(r.until), reason: r.reason })).filter((p) => p.until > now);
}

export function providerPause(engine: Engine, ref: string, now = Date.now()): ProviderPause | null {
  return activePauses(engine, now).find((p) => p.key === pauseKeyOf(ref)) ?? null;
}

export function pauseProvider(engine: Engine, ref: string, reason: string, ms = 15 * 60_000, account?: string | null): void {
  const { provider } = parseRef(ref);
  // With accounts, only the account that ran out is paused: the others keep working.
  const key = account && isAccountProvider(provider) ? accountPauseKey(provider, account) : pauseKeyOf(ref);
  const until = new Date(Date.now() + ms).toISOString();
  engine.store.execute({ request_id: newId('req'), type: 'pausar_proveedor', input: { key } }, () => ({
    result: null,
    events: [{ type: EV.providerPaused, aggregate_type: 'proveedor', aggregate_id: key, payload: { key, until, reason: reason.slice(0, 200) } }],
  }));
}

/** Lifts a pause before its time (the user renewed the session or the quota). */
export function resumeProvider(engine: Engine, key: string): boolean {
  if (!activePauses(engine).some((p) => p.key === key)) return false;
  engine.store.execute({ request_id: newId('req'), type: 'reanudar_proveedor', input: { key } }, () => ({
    result: null,
    events: [{ type: EV.providerPaused, aggregate_type: 'proveedor', aggregate_id: key, payload: { key, until: new Date(0).toISOString(), reason: 'reanudado por el usuario' } }],
  }));
  return true;
}

const isAccountProvider = (p: string): p is AccountProvider => p === 'claude' || p === 'codex';

/** Agents running now on one account of a provider (any run of this checkout). */
function runningOn(engine: Engine, provider: string, alias: string): number {
  const row = engine.store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM task_exec e JOIN tasks t ON t.run_id = e.run_id AND t.task_id = e.task_id WHERE e.provider = ? AND COALESCE(e.account, 'principal') = ? AND t.state IN ('reservada', 'ejecutando')",
    )
    .get(provider, alias) as { n: number };
  return row.n;
}

/**
 * The account a launch of `provider` should use. `reparto` spreads task agents over the
 * least busy account; `orden` keeps planner calls on the first usable one (so resumed
 * sessions stay on the account that created them). `undefined`: no account registry, the
 * CLI's default session is used as before. `null`: every account is paused, busy or signed out.
 */
export function accountFor(engine: Engine, provider: string, mode: 'reparto' | 'orden'): AccountChoice | null | undefined {
  if (!engine.accounts || !isAccountProvider(provider)) return undefined;
  const paused = new Set(activePauses(engine).map((p) => p.key));
  return chooseAccount(engine.accounts, provider, {
    paused: (key) => paused.has(key),
    running: (alias) => (mode === 'orden' ? 0 : runningOn(engine, provider, alias)),
  });
}

/** Launch parameters that follow from the chosen account: its session file and its own state folder. */
export function accountParams(engine: Engine, provider: string, choice: AccountChoice | undefined): Pick<LaunchParams, 'credentialFile' | 'providerStateDir'> {
  const alias = choice?.alias ?? PRINCIPAL;
  return {
    providerStateDir: join(engine.dataDir, 'proveedores', alias === PRINCIPAL ? provider : `${provider}@${alias}`),
    ...(choice ? { credentialFile: choice.credentialFile } : {}),
  };
}

/** Whether `ref` can take a launch now: not paused, and (with accounts) some account free. */
function available(engine: Engine, ref: string): boolean {
  const { provider } = parseRef(ref);
  const choice = accountFor(engine, provider, 'reparto');
  if (choice === undefined) return !providerPause(engine, ref);
  return choice !== null;
}

/** First configured model of a role whose provider is not paused (and has a free account). */
export function pickCandidate(engine: Engine, role: Role): ProviderRef | null {
  for (const ref of engine.config.roles[role]) {
    if (!available(engine, ref)) continue;
    return { ref, ...parseRef(ref) };
  }
  return null;
}

/** Whether a model pinned by the user can take a launch now. */
export function pinnedAvailable(engine: Engine, ref: string): boolean {
  return available(engine, ref);
}

/** Every model the policy allows in some role (a reassignment must pick one of these). */
export function allowedModels(engine: Engine): string[] {
  return [...new Set(Object.values(engine.config.roles).flat())];
}

/** The role's effort (forja.yaml `esfuerzo`) clamped to what `ref` accepts, as a LaunchParams fragment. */
export function effortParam(config: ForjaConfig, role: Role, ref: string): Pick<LaunchParams, 'effort'> {
  const effort = effortFor(ref, config.esfuerzo[role]);
  return effort ? { effort } : {};
}

export function parseRef(ref: string): { provider: 'claude' | 'codex' | 'simulado'; model: string } {
  const i = ref.indexOf(':');
  return { provider: ref.slice(0, i) as 'claude' | 'codex' | 'simulado', model: ref.slice(i + 1) };
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
    const account = accountFor(engine, provider, 'orden');
    if (account === null) {
      skipped.push(`${ref}: ninguna cuenta disponible (sin sesión, en pausa o desactivadas)`);
      continue;
    }
    const pause = account === undefined ? providerPause(engine, ref) : null;
    if (pause) {
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
      ...effortParam(engine.config, opts.role, ref),
      prompt: opts.prompt,
      workspace: opts.workspace,
      ...accountParams(engine, provider, account),
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
      pauseProvider(engine, ref, err.message.slice(0, 120), err.retryAfterMs ?? 15 * 60_000, account?.alias);
      skipped.push(`${ref}: ${err.category === 'quota' ? 'cuota agotada' : 'sin sesión'} (${err.message.slice(0, 100)})`);
      continue;
    }
    return { outcome, provider, model, launchId, skipped };
  }
  throw new NoProviderError(skipped);
}

export function recordUsage(engine: Engine, opts: Pick<CallOptions, 'role' | 'scope'>, launchId: string, provider: string, model: string, outcome: LaunchOutcome): void {
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
  engine.store.execute({ request_id: `uso:${launchId}`, type: 'registrar_uso', input: { launchId } }, () => ({
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
  }));
}
