import { join } from 'node:path';
import type { LaunchParams, ProviderAdapter } from '../providers/adapters.js';
import { type LaunchSummary, type ProviderEvent, summarize } from '../providers/normalized.js';
import { type ProviderKind, parseProviderStream } from '../providers/stream.js';
import { DEFAULT_RUNNER_SCRIPT, type LaunchStatus, launchDir, launchStatus, readSpool, spawnRunner, waitForLaunch, writeOrder } from './launcher.js';

export type StartedLaunch = { dir: string; parser: ProviderKind };

/** Protocol steps 1–3: durable order, then a detached runner. */
export function startLaunch(dataDir: string, adapter: ProviderAdapter, params: Omit<LaunchParams, 'inputsDir'>, runnerScript = DEFAULT_RUNNER_SCRIPT): StartedLaunch {
  const dir = launchDir(dataDir, params.launchId);
  const order = adapter.buildOrder({ ...params, inputsDir: join(dir, 'entrada') });
  writeOrder(dir, order);
  spawnRunner(dir, runnerScript);
  return { dir, parser: adapter.parser };
}

export type LaunchOutcome = {
  status: LaunchStatus;
  summary: LaunchSummary;
  events: ProviderEvent[];
  /** Hosts the sandbox tried to reach and the proxy refused. */
  deniedHosts: string[];
};

/** Reads the durable spool (whatever happened to the daemon) and normalizes it. */
export async function readOutcome(dir: string, parser: ProviderKind, expectStructured = false): Promise<LaunchOutcome> {
  const records = readSpool(dir);
  const lines = records.filter((r) => r.stream === 'stdout').map((r) => `${r.line}\n`);
  const events: ProviderEvent[] = [];
  for await (const e of parseProviderStream(
    parser,
    (async function* () {
      yield* lines;
    })(),
  )) {
    events.push(e);
  }
  const summary = summarize(events);
  // Codex returns structured output as the final message text.
  if (expectStructured && summary.structured === undefined && summary.text) {
    try {
      summary.structured = JSON.parse(jsonBody(summary.text)) as unknown;
    } catch {
      summary.warnings.push('se pidió salida estructurada y la respuesta no es JSON');
      if (summary.status === 'completed') summary.status = 'failed';
      summary.error ??= { category: 'schema', message: 'la respuesta no respeta el esquema', retryable: true };
    }
  }
  const deniedHosts = records
    .filter((r) => r.stream === 'forja')
    .map((r) => JSON.parse(r.line) as { tipo: string; host?: string; permitido?: boolean })
    .filter((e) => e.tipo === 'red' && e.permitido === false)
    .map((e) => e.host!)
    .filter((h, i, all) => all.indexOf(h) === i);
  const status = launchStatus(dir);
  if (status.state === 'terminado' && status.result.status === 'tiempo_agotado' && !summary.error) {
    summary.status = 'failed';
    summary.error = { category: 'timeout', message: 'se agotó el tiempo de la tarea', retryable: true };
  }
  if (status.state === 'interrumpido' && summary.status === 'completed') {
    // Result line seen but the runner died before closing: still trust only verified evidence.
    summary.warnings.push('el supervisor terminó sin cerrar el lanzamiento');
  }
  return { status, summary, events, deniedHosts };
}

/** The JSON object inside a reply that wrapped it in ``` fences or a sentence (it happens without a schema-enforced output). */
export function jsonBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

export async function runToCompletion(
  dataDir: string,
  adapter: ProviderAdapter,
  params: Omit<LaunchParams, 'inputsDir'>,
  options: { runnerScript?: string; waitMs?: number } = {},
): Promise<LaunchOutcome> {
  const { dir, parser } = startLaunch(dataDir, adapter, params, options.runnerScript);
  await waitForLaunch(dir, options.waitMs ?? params.timeoutMs + 15_000);
  return readOutcome(dir, parser, params.outputSchema !== undefined);
}
