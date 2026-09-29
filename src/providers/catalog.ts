/**
 * The models each provider's CLI accepts, with the reasoning effort each one supports.
 * Single source of truth for the panel's selectors, `forja modelos` and the adapters
 * (which clamp a role's effort to what the chosen model accepts).
 *
 * Sources (checked 2026-09):
 * - Claude Code: https://code.claude.com/docs/en/model-config (`--model`, `--effort`).
 * - Codex CLI: https://learn.chatgpt.com/docs/models (`-m`, `model_reasoning_effort`).
 *
 * A model missing here can still be typed as `proveedor:modelo`: the CLI decides.
 */

/** Reasoning effort, from least to most. Claude uses `--effort`, Codex `model_reasoning_effort`. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type Effort = (typeof EFFORTS)[number];

export const EFFORT_LABELS: Record<Effort, string> = {
  low: 'Bajo',
  medium: 'Medio',
  high: 'Alto',
  xhigh: 'Muy alto',
  max: 'Máximo',
  ultra: 'Ultra',
};

export type CatalogProvider = 'claude' | 'codex';
export type ModelTier = 'tope' | 'alto' | 'medio' | 'economico';
export type ModelStatus = 'actual' | 'anterior' | 'retirandose';

export interface CatalogModel {
  /** `proveedor:modelo`, exactly what goes in forja.yaml. */
  readonly ref: string;
  readonly provider: CatalogProvider;
  readonly label: string;
  readonly description: string;
  /** Effort levels the model accepts; empty = the CLI does not take an effort for it. */
  readonly efforts: readonly Effort[];
  readonly tier: ModelTier;
  readonly status: ModelStatus;
  /** An alias the CLI resolves to its current model (e.g. `opus`). */
  readonly alias?: boolean;
  /** Context window, for the panel. */
  readonly context?: string;
  /** For `retirandose`: the date the provider stops serving it. */
  readonly retires?: string;
}

const CLAUDE_FULL: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_46: readonly Effort[] = ['low', 'medium', 'high', 'max'];
const CODEX_FULL: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function claude(id: string, label: string, description: string, efforts: readonly Effort[], tier: ModelTier, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { ref: `claude:${id}`, provider: 'claude', label, description, efforts, tier, status: 'actual', ...extra };
}
function codex(id: string, label: string, description: string, efforts: readonly Effort[], tier: ModelTier, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { ref: `codex:${id}`, provider: 'codex', label, description, efforts, tier, status: 'actual', ...extra };
}

export const MODEL_CATALOG: readonly CatalogModel[] = [
  // Claude Code: aliases follow the newest model of each family.
  claude('default', 'Recomendado de tu plan', 'Lo que Claude Code usa si no eliges nada (hoy Opus 5.5 en la mayoría de planes).', CLAUDE_FULL, 'alto', { alias: true }),
  claude('best', 'El más capaz disponible', 'Fable si tu plan lo incluye; si no, Opus.', CLAUDE_FULL, 'tope', { alias: true }),
  claude('opusplan', 'Opus para planear, Sonnet para ejecutar', 'Alias de Claude Code: piensa con Opus y escribe con Sonnet.', CLAUDE_FULL, 'alto', { alias: true }),
  claude('fable', 'Fable (último)', 'La familia más capaz de Claude.', CLAUDE_FULL, 'tope', { alias: true, context: '1M' }),
  claude('opus', 'Opus (último)', 'Muy capaz y más barato que Fable. Buen planeador.', CLAUDE_FULL, 'alto', { alias: true, context: '1M' }),
  claude('opus[1m]', 'Opus (último) · 1M de contexto', 'Opus con la ventana de contexto de 1M activada.', CLAUDE_FULL, 'alto', { alias: true, context: '1M' }),
  claude('sonnet', 'Sonnet (último)', 'Equilibrio entre calidad y costo. Bueno para tareas complejas.', CLAUDE_FULL, 'medio', { alias: true, context: '1M' }),
  claude('sonnet[1m]', 'Sonnet (último) · 1M de contexto', 'Sonnet con la ventana de contexto de 1M activada.', CLAUDE_FULL, 'medio', { alias: true, context: '1M' }),
  claude('haiku', 'Haiku (último)', 'El más rápido y barato. Bueno para tareas simples en paralelo.', [], 'economico', { alias: true, context: '200K' }),
  claude('claude-fable-5-1', 'Fable 5.1', 'Versión fija de Fable 5.1.', CLAUDE_FULL, 'tope', { context: '1M' }),
  claude('claude-fable-5', 'Fable 5', 'Versión fija de Fable 5.', CLAUDE_FULL, 'tope', { context: '1M', status: 'anterior' }),
  claude('claude-opus-5-5', 'Opus 5.5', 'Versión fija de Opus 5.5.', CLAUDE_FULL, 'alto', { context: '1M' }),
  claude('claude-opus-5', 'Opus 5', 'Versión fija de Opus 5.', CLAUDE_FULL, 'alto', { context: '1M', status: 'anterior' }),
  claude('claude-opus-4-8', 'Opus 4.8', 'Versión fija de Opus 4.8.', CLAUDE_FULL, 'alto', { context: '1M', status: 'anterior' }),
  claude('claude-opus-4-7', 'Opus 4.7', 'Versión fija de Opus 4.7.', CLAUDE_FULL, 'alto', { context: '1M', status: 'anterior' }),
  claude('claude-opus-4-6', 'Opus 4.6', 'Versión fija de Opus 4.6.', CLAUDE_46, 'alto', { context: '200K', status: 'anterior' }),
  claude('claude-opus-4-6[1m]', 'Opus 4.6 · 1M de contexto', 'Opus 4.6 con la ventana de 1M activada.', CLAUDE_46, 'alto', { context: '1M', status: 'anterior' }),
  claude('claude-sonnet-5-5', 'Sonnet 5.5', 'Versión fija de Sonnet 5.5.', CLAUDE_FULL, 'medio', { context: '1M' }),
  claude('claude-sonnet-5', 'Sonnet 5', 'Versión fija de Sonnet 5.', CLAUDE_FULL, 'medio', { context: '1M', status: 'anterior' }),
  claude('claude-sonnet-4-6', 'Sonnet 4.6', 'Versión fija de Sonnet 4.6.', CLAUDE_46, 'medio', { context: '200K', status: 'anterior' }),
  claude('claude-sonnet-4-6[1m]', 'Sonnet 4.6 · 1M de contexto', 'Sonnet 4.6 con la ventana de 1M activada.', CLAUDE_46, 'medio', { context: '1M', status: 'anterior' }),
  claude('claude-haiku-4-5', 'Haiku 4.5', 'Versión fija de Haiku 4.5.', [], 'economico', { context: '200K' }),
  // Codex CLI.
  codex('gpt-6-sol', 'GPT-6 Sol', 'El recomendado de Codex: buen equilibrio para programar y revisar.', CODEX_FULL, 'alto'),
  codex('gpt-6-astra', 'GPT-6 Astra', 'El más capaz de Codex. Buen planeador.', CODEX_FULL, 'tope'),
  codex('gpt-6-luna', 'GPT-6 Luna', 'Rápido y barato. Llega hasta esfuerzo «Máximo» (sin «Ultra»).', ['low', 'medium', 'high', 'xhigh', 'max'], 'economico'),
  codex('gpt-5.6-sol', 'GPT-5.6 Sol', 'Generación anterior: modelo de código para trabajo complejo.', CODEX_FULL, 'alto', { status: 'anterior' }),
  codex('gpt-5.6-terra', 'GPT-5.6 Terra', 'Generación anterior: equilibrado para trabajo directo.', CODEX_FULL, 'medio', { status: 'anterior' }),
  codex('gpt-5.6-luna', 'GPT-5.6 Luna', 'Generación anterior: rápido y eficiente. Sin esfuerzo «Ultra».', ['low', 'medium', 'high', 'xhigh', 'max'], 'economico', { status: 'anterior' }),
  codex('gpt-5.5', 'GPT-5.5', 'Generación anterior. OpenAI lo retira: cámbialo antes de esa fecha.', ['low', 'medium', 'high', 'xhigh'], 'medio', {
    status: 'retirandose',
    retires: '2026-10-14',
  }),
];

const BY_REF = new Map(MODEL_CATALOG.map((m) => [m.ref, m]));

export function catalogModel(ref: string): CatalogModel | undefined {
  return BY_REF.get(ref);
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value);
}

/**
 * The effort to pass for `ref` when its role asks for `wanted`: the highest level the
 * model accepts that is not above `wanted`. `undefined` = let the CLI use its default
 * (no effort asked, or the model does not take one). A model outside the catalog gets
 * the level as asked: the CLI is the one that knows it.
 */
export function effortFor(ref: string, wanted: Effort | undefined): Effort | undefined {
  if (!wanted) return undefined;
  const model = catalogModel(ref);
  if (!model) return ref.startsWith('claude:') || ref.startsWith('codex:') ? wanted : undefined;
  const limit = EFFORTS.indexOf(wanted);
  return [...model.efforts].reverse().find((e) => EFFORTS.indexOf(e) <= limit) ?? model.efforts[0];
}
