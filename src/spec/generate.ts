import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callRole, type Engine } from '../core/engine.js';
import { hashJson } from '../domain/hash.js';
import { attachmentsForPrompt } from '../planner/attachments.js';
import { compose, loadPrompt } from '../planner/prompts.js';
import { getChange, getDiscovery, llmSchema, PlannerError } from '../planner/session.js';
import { EV } from '../store/planning-projections.js';
import { type Spec, SpecBody, type SpecIssue, validateSpec } from './spec.js';

export type SpecResult = { spec: Spec; issues: SpecIssue[]; revision: number; hash: string; attempts: number };

export function latestSpec(engine: Engine, changeId: string): { spec: Spec; revision: number; hash: string } | null {
  const row = engine.store.db.prepare('SELECT revision, hash, spec FROM specs WHERE change_id = ? ORDER BY revision DESC LIMIT 1').get(changeId) as
    | { revision: number; hash: string; spec: string }
    | undefined;
  return row ? { spec: JSON.parse(row.spec) as Spec, revision: row.revision, hash: row.hash } : null;
}

export type SpecAnswerRow = { question_id: string; question: string; answer: string };

export function specAnswers(engine: Engine, changeId: string): SpecAnswerRow[] {
  return engine.store.db.prepare('SELECT question_id, question, answer FROM spec_answers WHERE change_id = ? ORDER BY answered_seq').all(changeId) as SpecAnswerRow[];
}

/** Records the user's answer to an open question of the latest spec. */
export function answerSpecQuestion(engine: Engine, changeId: string, questionId: string, answer: string): SpecAnswerRow {
  const latest = latestSpec(engine, changeId);
  const q = latest?.spec.preguntas.find((x) => x.id === questionId);
  if (!q) throw new PlannerError(`la especificación vigente no tiene la pregunta ${questionId}`);
  engine.store.execute({ request_id: `respuesta:${changeId}:${questionId}:${answer}`, type: 'responder_pregunta_spec', input: { changeId, questionId, answer } }, () => ({
    result: null,
    events: [{ type: EV.specAnswer, aggregate_type: 'cambio', aggregate_id: changeId, payload: { question_id: questionId, question: q.texto, answer } }],
  }));
  return { question_id: questionId, question: q.texto, answer };
}

/** Prefix of user change requests stored with the spec answers (they survive replay the same way). */
export const CHANGE_REQUEST = 'CAMBIO-';

/**
 * A change the user asks for after the spec exists (MEJORAS 2.4): recorded as an
 * instruction for the next `forja especificar`, which may run in «aprobar» or
 * mid-run in «ejecutar». The next run redoes only what the change touched.
 */
export function requestSpecChange(engine: Engine, changeId: string, text: string): string {
  const n = (engine.store.db.prepare('SELECT COUNT(*) AS n FROM spec_answers WHERE change_id = ? AND question_id LIKE ?').get(changeId, `${CHANGE_REQUEST}%`) as { n: number }).n + 1;
  const id = `${CHANGE_REQUEST}${String(n).padStart(3, '0')}`;
  engine.store.execute({ request_id: `cambio:${changeId}:${id}`, type: 'pedir_cambio_spec', input: { changeId, text } }, () => ({
    result: null,
    events: [{ type: EV.specAnswer, aggregate_type: 'cambio', aggregate_id: changeId, payload: { question_id: id, question: 'cambio pedido por el usuario', answer: text } }],
  }));
  return id;
}

export function changeDir(repoPath: string, changeId: string): string {
  return join(repoPath, '.forja', 'cambios', changeId);
}

/**
 * Approved discovery → structured spec (P-ESPECIFICAR). Up to two format repairs
 * and three completeness repairs, each sending only the issues (v2/04).
 */
export async function generateSpec(
  engine: Engine,
  input: { changeId: string; workspace: string; repoPath: string; evidence?: object; projectId: string; databases?: object | null },
): Promise<SpecResult> {
  const change = getChange(engine, input.changeId);
  if (!['especificar', 'dividir', 'aprobar', 'ejecutar'].includes(change.phase)) throw new PlannerError(`el cambio está en la fase «${change.phase}»: primero aprueba el descubrimiento`);
  const { state, approvedRevision } = getDiscovery(engine, input.changeId);
  if (approvedRevision === null) throw new PlannerError('el descubrimiento no está aprobado');
  const base = latestSpec(engine, input.changeId);

  const agreed = {
    idea: state.idea,
    modo: state.modo,
    resumen: state.resumen,
    alcance: state.alcance,
    decisiones_aceptadas: Object.values(state.decisiones)
      .filter((d) => d.estado === 'aceptada')
      .map(({ id, contenido, motivo }) => ({ id, contenido, motivo })),
    propuestas_aceptadas: Object.values(state.propuestas)
      .filter((p) => p.estado === 'aceptada')
      .map(({ id, recomendacion }) => ({ id, recomendacion })),
    decisiones_sin_confirmar: Object.values(state.decisiones)
      .filter((d) => d.estado !== 'aceptada')
      .map(({ id, contenido }) => ({ id, contenido })),
    observaciones: Object.values(state.observaciones),
    cobertura: state.cobertura,
  };
  const { prompt, manifest } = compose([loadPrompt('planeador/base'), loadPrompt('planeador/especificar')], {
    descubrimiento_aprobado: agreed,
    documentos_adjuntos: attachmentsForPrompt(engine.dataDir, input.changeId),
    bases_de_datos: input.databases ?? null,
    spec_base: base?.spec ?? null,
    cambios_pedidos_por_el_usuario: (() => {
      const changes = specAnswers(engine, input.changeId).filter((a) => a.question_id.startsWith(CHANGE_REQUEST));
      return changes.length
        ? {
            instruccion:
              'Aplica estos cambios a spec_base: ajusta requisitos, reglas, casos de uso y criterios afectados; conserva los ids y el texto de todo lo que no cambia (lo que no cambia no se rehace) y usa ids nuevos para lo nuevo.',
            cambios: changes.map((c) => ({ id: c.question_id, texto: c.answer })),
          }
        : null;
    })(),
    respuestas_del_usuario: (() => {
      const answers = specAnswers(engine, input.changeId).filter((a) => !a.question_id.startsWith(CHANGE_REQUEST));
      return answers.length
        ? {
            instruccion:
              'Estas preguntas ya las respondió el usuario: incorpora cada respuesta como decisión aprobada (con su id), ajusta reglas, casos y criterios afectados y quita la pregunta de `preguntas`.',
            respuestas: answers,
          }
        : null;
    })(),
    evidencia_del_repositorio: input.evidence,
  });
  const schema = llmSchema(SpecBody);

  let body: SpecBody | null = null;
  let issues: SpecIssue[] = [];
  let feedback = '';
  let attempts = 0;
  for (let i = 0; i < 5; i++) {
    attempts++;
    const call = await callRole(engine, {
      role: 'planeador',
      prompt: prompt + feedback,
      tools: 'lectura',
      workspace: input.workspace,
      workspaceReadOnly: true,
      outputSchema: schema,
      scope: { change_id: input.changeId },
      attempt: attempts,
    });
    const parsed = SpecBody.safeParse(call.outcome.summary.structured);
    if (!parsed.success) {
      const why =
        call.outcome.summary.error?.message ??
        parsed.error.issues
          .slice(0, 8)
          .map((x) => `${x.path.join('.')}: ${x.message}`)
          .join('; ');
      feedback = `\n\n<correccion>La respuesta anterior no cumplía el esquema: ${why}. Devuelve la especificación completa y válida.</correccion>`;
      continue;
    }
    body = parsed.data;
    issues = validateSpec(body);
    const errors = issues.filter((x) => x.severity === 'error');
    if (errors.length === 0) break;
    // Completeness repair: send only the problems and the current draft.
    feedback = `\n\n<correccion>La especificación tiene estos problemas. Corrígelos sin cambiar lo que está bien y devuelve el documento completo:\n${errors
      .map((x) => `- ${x.path}: ${x.message}`)
      .join('\n')}\n</correccion>\n<borrador_anterior>\n${JSON.stringify(body)}\n</borrador_anterior>`;
  }
  if (!body) throw new PlannerError('el planeador no devolvió una especificación con el formato correcto');

  const revision = (base?.revision ?? 0) + 1;
  const spec: Spec = { schema_version: 2, project_id: input.projectId, change_id: input.changeId, revision, ...body };
  const hash = hashJson(spec);
  const valid = !issues.some((x) => x.severity === 'error');
  engine.store.execute({ request_id: `spec:${input.changeId}:${revision}:${hash}`, type: 'revisar_spec', input: { changeId: input.changeId, revision, hash } }, () => ({
    result: null,
    events: [
      { type: EV.specRevised, aggregate_type: 'cambio', aggregate_id: input.changeId, payload: { revision, hash, spec: spec as unknown as Record<string, unknown> } },
      // A valid new spec leaves the current plan stale: back to «dividir» (also mid-run).
      ...(valid && change.phase !== 'dividir' ? [{ type: EV.changePhase, aggregate_type: 'cambio', aggregate_id: input.changeId, payload: { from: change.phase, to: 'dividir' } }] : []),
    ],
  }));
  // The repo is the source of truth for decisions (ADR-008).
  const dir = changeDir(input.repoPath, input.changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(join(dir, 'prompts.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { spec, issues, revision, hash, attempts };
}
