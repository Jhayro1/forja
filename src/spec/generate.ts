import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { callRole, type Engine, waitIfTransient } from '../core/engine.js';
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

/**
 * Answers and change requests given after the latest spec: the ones the next spec must
 * apply. Older ones are already in `spec_base`; sending them again costs tokens and
 * could apply a change twice.
 */
export function pendingSpecInputs(engine: Engine, changeId: string): SpecAnswerRow[] {
  const last = engine.store.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE type = 'spec.revisada' AND aggregate_id = ?").get(changeId) as { s: number };
  return engine.store.db.prepare('SELECT question_id, question, answer FROM spec_answers WHERE change_id = ? AND answered_seq > ? ORDER BY answered_seq').all(changeId, last.s) as SpecAnswerRow[];
}

/**
 * Records the user's answer to a question of the latest spec, or changes one already
 * given (the question may no longer be in the spec: it became a decision).
 */
export function answerSpecQuestion(engine: Engine, changeId: string, questionId: string, answer: string): SpecAnswerRow {
  const latest = latestSpec(engine, changeId);
  const text =
    latest?.spec.preguntas.find((x) => x.id === questionId)?.texto ?? specAnswers(engine, changeId).find((a) => a.question_id === questionId && !a.question_id.startsWith(CHANGE_REQUEST))?.question;
  if (!text) throw new PlannerError(`la especificación vigente no tiene la pregunta ${questionId}`);
  engine.store.execute({ request_id: `respuesta:${changeId}:${questionId}:${answer}`, type: 'responder_pregunta_spec', input: { changeId, questionId, answer } }, () => ({
    result: null,
    events: [{ type: EV.specAnswer, aggregate_type: 'cambio', aggregate_id: changeId, payload: { question_id: questionId, question: text, answer } }],
  }));
  return { question_id: questionId, question: text, answer };
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
 * Approved discovery → structured spec (P-ESPECIFICAR), in parts: first the frame
 * (requirements, entities, rules… and the index of use cases), then the use cases a
 * few at a time. Each part is saved as it arrives, so a failure repeats only that part
 * and the next run resumes where this one stopped; each repair sends only the issues
 * of its part (v2/04).
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
  // Without a previous spec everything is new: all answers apply.
  const pending = base ? pendingSpecInputs(engine, input.changeId) : specAnswers(engine, input.changeId);

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
      const changes = pending.filter((a) => a.question_id.startsWith(CHANGE_REQUEST));
      return changes.length
        ? {
            instruccion:
              'Aplica estos cambios a spec_base: ajusta requisitos, reglas, casos de uso y criterios afectados; conserva los ids y el texto de todo lo que no cambia (lo que no cambia no se rehace) y usa ids nuevos para lo nuevo.',
            cambios: changes.map((c) => ({ id: c.question_id, texto: c.answer })),
          }
        : null;
    })(),
    respuestas_del_usuario: (() => {
      const answers = pending.filter((a) => !a.question_id.startsWith(CHANGE_REQUEST));
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
  for (const part of [loadPrompt('planeador/especificar-base'), loadPrompt('planeador/especificar-casos')]) manifest[part.id] = part.hash;
  const progress = loadProgress(engine.dataDir, input.changeId, hashJson({ prompt }));
  const call = (phase: string, schema: z.ZodType, extra: string, attempt: number) =>
    callRole(engine, {
      role: 'planeador',
      prompt: `${prompt}\n\n${loadPrompt(phase).text}${extra}`,
      tools: 'lectura',
      workspace: input.workspace,
      workspaceReadOnly: true,
      outputSchema: llmSchema(schema),
      scope: { change_id: input.changeId },
      attempt,
    });
  let attempts = 0;

  // 1. Everything but the use cases, plus the index of the cases to write.
  if (!progress.base) {
    const r = await askPart(SpecFrame, (feedback, attempt) => call('planeador/especificar-base', SpecFrame, feedback, attempt), frameErrors);
    attempts += r.attempts;
    if (!r.value) throw new PlannerError(`el planeador no devolvió la base de la especificación (${r.attempts} intentos; último problema: ${r.problem.slice(0, 300)})`);
    progress.base = r.value;
    saveProgress(engine.dataDir, input.changeId, progress);
  }
  const frame = progress.base;

  // 2. Cases the index marks as unchanged are copied from the previous spec, without the model,
  //    as long as they still fit the new frame (otherwise they are rewritten).
  const index = frame.indice_casos;
  const written = (id: string) => Object.values(progress.cases).some((x) => x.casos_uso.some((u) => u.id === id));
  if (base) {
    for (const c of index) {
      if (c.estado !== 'igual' || written(c.id)) continue;
      const old = base.spec.casos_uso.find((u) => u.id === c.id);
      if (!old) continue;
      const copy: SpecCases = { casos_uso: [old], criterios: base.spec.criterios.filter((k) => k.caso_uso_id === c.id) };
      if (partErrors(frame, progress.cases, copy, [c.id]).length === 0) progress.cases[`=${c.id}`] = copy;
    }
    saveProgress(engine.dataDir, input.changeId, progress);
  }

  // 3. The other cases, a few per call: a failure repeats only its part and a new run resumes here.
  const toWrite = index.filter((c) => !written(c.id));
  for (let from = 0; from < toWrite.length; from += CASES_PER_CALL) {
    const part = toWrite.slice(from, from + CASES_PER_CALL);
    const key = part.map((c) => c.id).join(',');
    if (progress.cases[key]) continue;
    const previous = base?.spec;
    const data = compose([], {
      // Same text on every part (and first): the provider's prompt cache reuses it.
      especificacion_hasta_ahora: withoutIndex(frame),
      casos_ya_escritos: Object.values(progress.cases).flatMap((x) => x.casos_uso.map((u) => u.id)),
      casos_a_escribir: part,
      casos_en_spec_base: previous
        ? { casos_uso: previous.casos_uso.filter((u) => part.some((c) => c.id === u.id)), criterios: previous.criterios.filter((c) => part.some((u) => u.id === c.caso_uso_id)) }
        : null,
    }).prompt;
    const r = await askPart(
      SpecCases,
      (feedback, attempt) => call('planeador/especificar-casos', SpecCases, `\n\n${data}${feedback}`, attempt),
      (value) =>
        partErrors(
          frame,
          progress.cases,
          value,
          part.map((c) => c.id),
        ),
    );
    attempts += r.attempts;
    if (!r.value) {
      const done = Object.values(progress.cases).reduce((n, x) => n + x.casos_uso.length, 0);
      throw new PlannerError(
        `el planeador no devolvió los casos ${key} (${r.attempts} intentos; último problema: ${r.problem.slice(0, 300)}). El avance quedó guardado (${done} de ${index.length} casos): vuelve a ejecutar especificar y sigue desde aquí`,
      );
    }
    progress.cases[key] = r.value;
    saveProgress(engine.dataDir, input.changeId, progress);
  }

  // In the index's order, whatever part each case came from.
  const parts = Object.values(progress.cases);
  const body: SpecBody = {
    ...withoutIndex(frame),
    casos_uso: index.flatMap((c) => parts.flatMap((x) => x.casos_uso).filter((u) => u.id === c.id)),
    criterios: index.flatMap((c) => parts.flatMap((x) => x.criterios).filter((k) => k.caso_uso_id === c.id)),
  };
  clearProgress(engine.dataDir, input.changeId);

  const saved = saveSpec(engine, { changeId: input.changeId, repoPath: input.repoPath, projectId: input.projectId, body, manifest });
  return { ...saved, attempts };
}

/**
 * Records a new spec revision (from the planner or edited by hand) and writes it to the
 * repo, which is the source of truth for decisions (ADR-008). A valid spec leaves the
 * current plan stale: the sprint goes to «dividir» (also mid-run).
 */
export function saveSpec(engine: Engine, input: { changeId: string; repoPath: string; projectId: string; body: SpecBody; manifest?: Record<string, string> }): Omit<SpecResult, 'attempts'> {
  const change = getChange(engine, input.changeId);
  const base = latestSpec(engine, input.changeId);
  const issues = validateSpec(input.body);
  const revision = (base?.revision ?? 0) + 1;
  const spec: Spec = { schema_version: 2, project_id: input.projectId, change_id: input.changeId, revision, ...input.body };
  const hash = hashJson(spec);
  const valid = !issues.some((x) => x.severity === 'error');
  engine.store.execute({ request_id: `spec:${input.changeId}:${revision}:${hash}`, type: 'revisar_spec', input: { changeId: input.changeId, revision, hash } }, () => ({
    result: null,
    events: [
      { type: EV.specRevised, aggregate_type: 'cambio', aggregate_id: input.changeId, payload: { revision, hash, spec: spec as unknown as Record<string, unknown> } },
      ...(valid && change.phase !== 'dividir' ? [{ type: EV.changePhase, aggregate_type: 'cambio', aggregate_id: input.changeId, payload: { from: change.phase, to: 'dividir' } }] : []),
    ],
  }));
  const dir = changeDir(input.repoPath, input.changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
  if (input.manifest) writeFileSync(join(dir, 'prompts.json'), `${JSON.stringify(input.manifest, null, 2)}\n`);
  return { spec, issues, revision, hash };
}

/** Use cases per call: small replies are fast, cheap to repair and never get cut off. */
const CASES_PER_CALL = 3;
const ATTEMPTS_PER_PART = 3;

const CaseIndex = z
  .object({
    id: z.string().regex(/^UC-\d{3}$/, 'formato UC-001'),
    nombre: z.string(),
    actor_id: z.string(),
    objetivo: z.string(),
    requisitos: z.array(z.string()),
    /** Against `spec_base`: «igual» is copied as it was, without spending tokens. */
    estado: z.enum(['igual', 'cambia', 'nuevo']),
  })
  .strict();
/** First part: the spec without its use cases, plus the list of cases to write next. */
const SpecFrame = SpecBody.omit({ casos_uso: true, criterios: true })
  .extend({ indice_casos: z.array(CaseIndex).min(1) })
  .strict();
type SpecFrame = z.infer<typeof SpecFrame>;
/** Following parts: some use cases with their acceptance criteria. */
const SpecCases = z.object({ casos_uso: SpecBody.shape.casos_uso, criterios: SpecBody.shape.criterios }).strict();
type SpecCases = z.infer<typeof SpecCases>;

type Progress = { inputs: string; base: SpecFrame | null; cases: Record<string, SpecCases> };

function progressFile(dataDir: string, changeId: string): string {
  return join(dataDir, 'especificar', `${changeId}.json`);
}

/** The saved parts, only if they were made from the same inputs (discovery, answers, changes…). */
function loadProgress(dataDir: string, changeId: string, inputs: string): Progress {
  try {
    const saved = JSON.parse(readFileSync(progressFile(dataDir, changeId), 'utf8')) as Progress;
    if (saved.inputs === inputs) return saved;
  } catch {
    // Nothing saved yet.
  }
  return { inputs, base: null, cases: {} };
}

function saveProgress(dataDir: string, changeId: string, progress: Progress): void {
  mkdirSync(join(dataDir, 'especificar'), { recursive: true });
  writeFileSync(progressFile(dataDir, changeId), JSON.stringify(progress));
}

function clearProgress(dataDir: string, changeId: string): void {
  rmSync(progressFile(dataDir, changeId), { force: true });
}

function withoutIndex(frame: SpecFrame): Omit<SpecBody, 'casos_uso' | 'criterios'> {
  const { indice_casos: _index, ...rest } = frame;
  return rest;
}

/** The frame's own references: the index decides which case covers each requirement. */
function frameErrors(frame: SpecFrame): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const id of [
    ...frame.actores.map((x) => x.id),
    ...frame.requisitos.map((x) => x.id),
    ...frame.entidades.map((x) => x.id),
    ...frame.reglas.map((x) => x.id),
    ...frame.indice_casos.map((x) => x.id),
    ...frame.contratos.map((x) => x.id),
    ...frame.rnf.map((x) => x.id),
    ...frame.integraciones.map((x) => x.id),
    ...frame.decisiones.map((x) => x.id),
    ...frame.preguntas.map((x) => x.id),
  ]) {
    if (ids.has(id)) out.push(`id duplicado ${id}`);
    ids.add(id);
  }
  for (const c of frame.indice_casos) {
    if (!frame.actores.some((a) => a.id === c.actor_id)) out.push(`indice_casos ${c.id}: actor ${c.actor_id} no existe`);
    for (const r of c.requisitos) if (!frame.requisitos.some((x) => x.id === r)) out.push(`indice_casos ${c.id}: requisito ${r} no existe`);
  }
  for (const r of frame.requisitos) if (r.prioridad !== 'baja' && !frame.indice_casos.some((c) => c.requisitos.includes(r.id))) out.push(`${r.id}: ningún caso de indice_casos lo cubre`);
  for (const r of frame.reglas) for (const ref of r.referencias) if (!ids.has(ref)) out.push(`${r.id}: referencia ${ref} no existe`);
  for (const q of frame.preguntas) for (const b of q.bloquea) if (!ids.has(b)) out.push(`${q.id}: bloquea ${b}, que no existe`);
  if (frame.sistema.alcance.length === 0) out.push('sistema.alcance: el alcance está vacío');
  return out;
}

/** Errors that concern these use cases, checked against everything written so far. */
function partErrors(frame: SpecFrame, done: Record<string, SpecCases>, part: SpecCases, ids: string[]): string[] {
  const owed = frame.indice_casos
    .filter((c) => ids.includes(c.id))
    .flatMap((c) => c.requisitos.filter((r) => frame.requisitos.find((x) => x.id === r)?.prioridad !== 'baja').map((r) => ({ caso: c.id, r })))
    .filter(({ caso, r }) => !part.criterios.some((k) => k.caso_uso_id === caso && k.requisitos.includes(r)))
    .map(({ caso, r }) => `${caso}: ningún criterio verifica ${r}, que el índice le asignó`);
  const others = Object.values(done);
  const spec: SpecBody = {
    ...withoutIndex(frame),
    casos_uso: [...others.flatMap((x) => x.casos_uso), ...part.casos_uso],
    criterios: [...others.flatMap((x) => x.criterios), ...part.criterios],
  };
  const missing = ids.filter((id) => !part.casos_uso.some((u) => u.id === id)).map((id) => `falta el caso ${id}`);
  const extra = part.casos_uso.filter((u) => !ids.includes(u.id)).map((u) => `${u.id}: escribe sólo los casos pedidos (${ids.join(', ')})`);
  const errors = validateSpec(spec)
    .filter((x) => x.severity === 'error' && ids.some((id) => x.path.includes(id)))
    .map((x) => `${x.path}: ${x.message}`);
  // Requirement coverage is global: it is checked through the index (`owed`), not here.
  const local = errors.filter((x) => !x.includes('requisito entregable sin criterio'));
  return [...missing, ...extra, ...owed, ...local];
}

type CallResultLike = Awaited<ReturnType<typeof callRole>>;

/**
 * One part with its repairs: a format repair sends the schema errors, a content repair
 * the problems and the draft of THIS part only. Gives up early on provider failures
 * that asking again does not fix.
 */
async function askPart<T>(
  schema: z.ZodType<T>,
  ask: (feedback: string, attempt: number) => Promise<CallResultLike>,
  problems: (value: T) => string[],
): Promise<{ value: T | null; attempts: number; problem: string }> {
  let feedback = '';
  let best: T | null = null;
  let problem = '';
  let attempts = 0;
  for (let i = 0; i < ATTEMPTS_PER_PART; i++) {
    attempts++;
    const call = await ask(feedback, attempts);
    const summary = call.outcome.summary;
    const parsed = schema.safeParse(summary.structured);
    if (!parsed.success) {
      problem =
        summary.error?.message ??
        (summary.structured === undefined
          ? `el modelo terminó sin entregar la respuesta (${call.provider}:${call.model}; registro en lanzamientos/${call.launchId})`
          : parsed.error.issues
              .slice(0, 8)
              .map((x) => `${x.path.join('.')}: ${x.message}`)
              .join('; '));
      if (await waitIfTransient(call.outcome)) continue;
      if (summary.error && summary.error.category !== 'schema') break;
      feedback = `\n\n<correccion>La respuesta anterior no sirvió: ${problem}. Devuelve sólo el objeto JSON completo y válido.</correccion>`;
      continue;
    }
    best = parsed.data;
    const found = problems(parsed.data);
    if (found.length === 0) return { value: best, attempts, problem: '' };
    problem = found.slice(0, 3).join('; ');
    feedback = `\n\n<correccion>Tu respuesta tiene estos problemas. Corrígelos sin cambiar lo que está bien y devuelve la parte completa:\n${found
      .map((x) => `- ${x}`)
      .join('\n')}\n</correccion>\n<borrador_anterior>\n${JSON.stringify(parsed.data)}\n</borrador_anterior>`;
  }
  // A part with leftover problems still moves forward: the final validation reports them.
  return { value: best, attempts, problem };
}
