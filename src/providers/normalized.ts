import type { NormalizedError } from '../domain/errors.js';

/**
 * Provider-independent observations (v2/07). Text and observed tools never grant
 * the ability to act: they are only shown and stored.
 */
export type ProviderEvent =
  | { t: 'inicio'; sessionId: string; model: string | null }
  | { t: 'texto'; text: string }
  | { t: 'herramienta'; name: string; summary: string; exitCode?: number | null }
  | { t: 'segundo_plano'; description: string }
  | { t: 'uso'; usage: Usage }
  | { t: 'resultado'; text: string; structured?: unknown }
  | { t: 'error'; error: NormalizedError }
  | { t: 'desconocido'; rawType: string };

/** Absent counters are null ("unknown"), never zero (v2/07 · Contabilidad). */
export type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** Equivalent cost reported by the provider, in micro-USD. */
  costEquivalentMicroUsd: number | null;
  /** How the provider accumulates: per turn (delta) or for the whole session. */
  semantics: 'por_turno' | 'acumulado_sesion';
};

export type LaunchSummary = {
  status: 'completed' | 'failed' | 'incomplete';
  sessionId: string | null;
  model: string | null;
  text: string | null;
  structured?: unknown;
  usage: Usage[];
  error: NormalizedError | null;
  /** Things the orchestrator must not ignore, e.g. work sent to background. */
  warnings: string[];
  unknownEvents: number;
};

export function summarize(events: readonly ProviderEvent[]): LaunchSummary {
  const summary: LaunchSummary = {
    status: 'incomplete',
    sessionId: null,
    model: null,
    text: null,
    usage: [],
    error: null,
    warnings: [],
    unknownEvents: 0,
  };
  for (const e of events) {
    switch (e.t) {
      case 'inicio':
        summary.sessionId = e.sessionId;
        summary.model = e.model;
        break;
      case 'uso':
        summary.usage.push(e.usage);
        break;
      case 'segundo_plano':
        summary.warnings.push(`el agente mandó trabajo a segundo plano: ${e.description}`);
        break;
      case 'resultado':
        summary.text = e.text;
        if (e.structured !== undefined) summary.structured = e.structured;
        if (summary.status !== 'failed') summary.status = 'completed';
        break;
      case 'error':
        summary.error = e.error;
        summary.status = 'failed';
        break;
      case 'desconocido':
        summary.unknownEvents++;
        break;
      default:
        break;
    }
  }
  return summary;
}
