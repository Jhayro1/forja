import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { callRole, type Engine } from '../core/engine.js';
import { newId } from '../domain/ids.js';
import type { Effort } from '../providers/catalog.js';
import { type ChangePhase, EV } from '../store/planning-projections.js';
import { type AttachmentMeta, attachmentsForPrompt } from './attachments.js';
import { closureBlockers, type DiscoveryState, emptyState, mergeTurn, openQuestions, PlannerTurnOutput, type Question, stateForPrompt } from './discovery.js';
import { compose, loadPrompt } from './prompts.js';

export class PlannerError extends Error {}

export type ChangeRow = {
  change_id: string;
  title: string;
  mode: 'idea' | 'mejora';
  phase: ChangePhase;
  discovery_revision: number;
  spec_revision: number;
  plan_revision: number;
  created_at: string;
};

/** JSON Schema accepted by both CLIs (all properties required, no extra keys). */
export function llmSchema(schema: z.ZodType): object {
  const json = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export function createChange(engine: Engine, requestId: string, title: string, mode: 'idea' | 'mejora'): string {
  const changeId = newId('cam');
  const res = engine.store.execute({ request_id: requestId, type: 'crear_cambio', input: { title, mode } }, () => ({
    result: changeId,
    events: [{ type: EV.changeCreated, aggregate_type: 'cambio', aggregate_id: changeId, payload: { title, mode } }],
  }));
  return res.result;
}

export function listChanges(engine: Engine): ChangeRow[] {
  return engine.store.db.prepare('SELECT * FROM changes ORDER BY created_at DESC').all() as ChangeRow[];
}

export function getChange(engine: Engine, changeId: string): ChangeRow {
  const row = engine.store.db.prepare('SELECT * FROM changes WHERE change_id = ?').get(changeId) as ChangeRow | undefined;
  if (!row) throw new PlannerError(`no existe el cambio ${changeId}`);
  return row;
}

/** The most recent change that is not delivered or cancelled. */
export function activeChange(engine: Engine): ChangeRow | undefined {
  return engine.store.db.prepare("SELECT * FROM changes WHERE phase NOT IN ('entregado', 'cancelado') ORDER BY created_at DESC LIMIT 1").get() as ChangeRow | undefined;
}

export function getDiscovery(engine: Engine, changeId: string): { revision: number; state: DiscoveryState; approvedRevision: number | null } {
  const change = getChange(engine, changeId);
  const row = engine.store.db.prepare('SELECT * FROM discovery WHERE change_id = ?').get(changeId) as { revision: number; state: string; approved_revision: number | null } | undefined;
  if (!row) return { revision: 0, state: emptyState(change.mode, change.title), approvedRevision: null };
  return { revision: row.revision, state: JSON.parse(row.state) as DiscoveryState, approvedRevision: row.approved_revision };
}

export type TranscriptTurn = { n: number; user_text: string | null; planner_text: string; provider: string; model: string | null; attachments: AttachmentMeta[] };

export function transcript(engine: Engine, changeId: string): TranscriptTurn[] {
  const rows = engine.store.db.prepare('SELECT n, user_text, planner_text, provider, model, attachments FROM planner_turns WHERE change_id = ? ORDER BY n').all(changeId) as (Omit<
    TranscriptTurn,
    'attachments'
  > & { attachments: string | null })[];
  return rows.map((r) => ({ ...r, attachments: r.attachments ? (JSON.parse(r.attachments) as AttachmentMeta[]) : [] }));
}

const CONTRACT = `Contrato de salida:
- Responde SÓLO con el objeto JSON del esquema. \`mensaje_usuario\` es lo único que verá el usuario: natural, breve, en su idioma, con las preguntas de este turno (máximo tres) y tus recomendaciones.
- Reutiliza los ids ya existentes (PRE-n, PRO-n, DEC-n, OBS-n) cuando hables de lo mismo; crea ids nuevos sólo para elementos nuevos.
- \`preguntas\` contiene las preguntas abiertas vigentes que quieras mantener o agregar; \`preguntas_resueltas\` los ids que el mensaje del usuario de ESTE turno respondió.
- Una decisión es \`respuesta_usuario\` sólo si el usuario la expresó; \`delegada\` sólo si el usuario te pidió decidir; lo demás es \`sugerencia\`.
- \`cobertura\` usa los temas de la matriz que apliquen al dominio; no hace falta listar todos.
- \`siguiente_paso\`: \`proponer_cierre\` sólo cuando no queden dudas que bloqueen el incremento.`;

export type TurnResult = {
  message: string;
  questions: Question[];
  notes: string[];
  state: DiscoveryState;
  revision: number;
  provider: string;
  model: string;
  blockers: string[];
};

/**
 * One planner turn: compose prompt (base + phase module + contract + current state
 * + user message), call the planner role with structured output, validate, apply
 * authority rules and persist the new revision in a single event.
 */
export async function runPlannerTurn(
  engine: Engine,
  input: {
    changeId: string;
    userText: string | null;
    workspace: string;
    evidence?: object;
    closing?: boolean;
    /** Documents attached to THIS message (already saved with saveAttachments). */
    attachments?: AttachmentMeta[];
    /** The model picked in the chat (`proveedor:modelo`), instead of the planner role's order. */
    model?: string;
    effort?: Effort;
    /** Schema of the project's linked databases (db/service.ts schemaForPrompt), when there are any. */
    databases?: object | null;
  },
): Promise<TurnResult> {
  const change = getChange(engine, input.changeId);
  if (change.phase !== 'descubrir') throw new PlannerError(`el cambio está en la fase «${change.phase}»; el descubrimiento ya se aprobó`);
  const { revision, state } = getDiscovery(engine, input.changeId);
  const modules = [loadPrompt('planeador/base'), loadPrompt(state.modo === 'mejora' ? 'planeador/mejorar' : 'planeador/descubrir')];
  if (state.siguiente_paso === 'revisar' || input.closing) modules.push(loadPrompt('planeador/revisar'));
  if (input.closing) modules.push(loadPrompt('planeador/cerrar'));
  const { prompt, manifest } = compose(modules, {
    contrato: CONTRACT,
    estado: stateForPrompt(state),
    evidencia_del_repositorio: input.evidence,
    documentos_adjuntos: attachmentsForPrompt(engine.dataDir, input.changeId),
    bases_de_datos: input.databases ?? null,
    mensaje_usuario: input.userText ?? (state.turnos === 0 ? `(inicio) La idea del usuario es: ${state.idea}` : '(el usuario no escribió nada nuevo)'),
  });
  const schema = llmSchema(PlannerTurnOutput);

  let output: PlannerTurnOutput | null = null;
  let lastError = '';
  let used = { provider: '', model: '' };
  // Up to two format repairs (v2/04 · Generación).
  for (let attempt = 1; attempt <= 3 && !output; attempt++) {
    const repair = attempt === 1 ? '' : `\n\n<correccion>Tu respuesta anterior no cumplía el esquema: ${lastError}. Devuelve el objeto completo y válido.</correccion>`;
    const call = await callRole(engine, {
      role: 'planeador',
      prompt: prompt + repair,
      tools: 'lectura',
      workspace: input.workspace,
      workspaceReadOnly: true,
      outputSchema: schema,
      scope: { change_id: input.changeId },
      attempt,
      ...(input.model ? { candidates: [input.model] } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    });
    used = { provider: call.provider, model: call.outcome.summary.model ?? call.model };
    const parsed = PlannerTurnOutput.safeParse(call.outcome.summary.structured);
    if (parsed.success) output = parsed.data;
    else
      lastError =
        call.outcome.summary.error?.message ??
        parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
  }
  if (!output) throw new PlannerError(`el planeador no devolvió un turno válido tras 3 intentos: ${lastError}`);

  const { state: next, notes } = mergeTurn(state, output, input.userText);
  const n = next.turnos;
  const turnId = `${input.changeId}:${n}`;
  engine.store.execute({ request_id: `turno:${turnId}`, type: 'turno_planeador', input: { turnId, base: revision } }, () => ({
    result: null,
    events: [
      {
        type: EV.plannerTurn,
        aggregate_type: 'cambio',
        aggregate_id: input.changeId,
        aggregate_revision: revision + 1,
        payload: {
          turn_id: turnId,
          n,
          base_revision: revision,
          new_revision: revision + 1,
          user_text: input.userText,
          planner_text: output.mensaje_usuario,
          provider: used.provider,
          model: used.model,
          prompt_manifest: manifest,
          state: next as unknown as Record<string, unknown>,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        },
      },
    ],
  }));
  return {
    message: output.mensaje_usuario,
    questions: openQuestions(next),
    notes,
    state: next,
    revision: revision + 1,
    provider: used.provider,
    model: used.model,
    blockers: closureBlockers(next),
  };
}

/** Explicit user approval of the discovery; never inferred from silence. */
export function approveDiscovery(engine: Engine, changeId: string, requestId: string): { revision: number } {
  const { revision, state } = getDiscovery(engine, changeId);
  const blockers = closureBlockers(state);
  if (blockers.length > 0) throw new PlannerError(`todavía no se puede aprobar:\n${blockers.map((b) => `  - ${b}`).join('\n')}`);
  engine.store.execute({ request_id: requestId, type: 'aprobar_descubrimiento', input: { changeId, revision } }, () => {
    const change = getChange(engine, changeId);
    if (change.phase !== 'descubrir') throw new PlannerError(`el cambio ya está en la fase «${change.phase}»`);
    return {
      result: null,
      events: [
        { type: EV.discoveryApproved, aggregate_type: 'cambio', aggregate_id: changeId, payload: { revision } },
        { type: EV.changePhase, aggregate_type: 'cambio', aggregate_id: changeId, payload: { from: 'descubrir', to: 'especificar' } },
      ],
    };
  });
  return { revision };
}

export function plannerScratch(engine: Engine): string {
  const dir = join(engine.dataDir, 'planeador', 'vacio');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
