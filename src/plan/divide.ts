import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callRole, type Engine } from '../core/engine.js';
import { hashJson } from '../domain/hash.js';
import { newId } from '../domain/ids.js';
import { gitOut } from '../git/git.js';
import { compose, loadPrompt } from '../planner/prompts.js';
import { getChange, llmSchema, PlannerError } from '../planner/session.js';
import { latestBaseline, profileHash } from '../profile/baseline.js';
import { changeDir, latestSpec } from '../spec/generate.js';
import { blockingQuestions } from '../spec/spec.js';
import { EV } from '../store/planning-projections.js';
import { draftTasks } from './draft.js';
import { type Plan, type PlanIssue, PlanOutput, type ProfileProposal, validatePlan, waves } from './plan.js';

/** The profile the user approved in forja.yaml, in the plan's shape (null if there is none). */
export function approvedProfile(engine: Engine): ProfileProposal | null {
  const p = engine.config.perfil;
  if (Object.keys(p.comandos).length === 0) return null;
  const cmd = (k: keyof typeof p.comandos) => (p.comandos[k] ? { executable: p.comandos[k].executable, args: p.comandos[k].args } : null);
  return {
    stack: p.stack,
    gestor: p.gestor ?? '',
    comandos: { instalar: cmd('instalar'), build: cmd('build'), typecheck: cmd('typecheck'), lint: cmd('lint'), test: cmd('test') },
    red_instalar: p.red_instalar,
  };
}

export function latestPlan(engine: Engine, changeId: string): { plan: Plan; hash: string; revision: number } | null {
  const row = engine.store.db.prepare('SELECT plan, hash, revision FROM plans WHERE change_id = ? ORDER BY revision DESC LIMIT 1').get(changeId) as
    | { plan: string; hash: string; revision: number }
    | undefined;
  return row ? { plan: JSON.parse(row.plan) as Plan, hash: row.hash, revision: row.revision } : null;
}

export type DivideResult = { plan: Plan; hash: string; issues: PlanIssue[]; attempts: number };

/**
 * Spec → plan: rules make the draft (0 tokens), the planner adjusts it in one call
 * (plus repairs), code validates the DAG, coverage and file overlaps.
 */
export async function dividePlan(engine: Engine, input: { changeId: string; repoPath: string; workspace: string; hasCode: boolean; evidence?: object }): Promise<DivideResult> {
  const change = getChange(engine, input.changeId);
  // «ejecutar» = re-plan mid-run (V2-037): the new revision goes back to «aprobar»
  // and the next run inherits the tasks already integrated with an identical definition.
  if (change.phase !== 'dividir' && change.phase !== 'aprobar' && change.phase !== 'ejecutar') {
    throw new PlannerError(`el cambio está en la fase «${change.phase}»; primero genera una especificación válida`);
  }
  const spec = latestSpec(engine, input.changeId);
  if (!spec) throw new PlannerError('no hay especificación');
  const pending = blockingQuestions(spec.spec);
  if (pending.length > 0) throw new PlannerError(`la especificación tiene preguntas pendientes (${pending.map((q) => q.id).join(', ')}): respóndelas con forja responder y vuelve a especificar`);

  const draft = draftTasks(spec.spec, engine.config, input.hasCode);
  const { prompt } = compose([loadPrompt('planeador/base'), loadPrompt('planeador/dividir')], {
    especificacion: {
      sistema: spec.spec.sistema,
      requisitos: spec.spec.requisitos,
      casos_uso: spec.spec.casos_uso.map((u) => ({
        id: u.id,
        nombre: u.nombre,
        objetivo: u.objetivo,
        pasos: u.pasos.length,
        excepciones: u.excepciones.length,
        reglas: u.reglas,
        requisitos: u.requisitos,
      })),
      criterios: spec.spec.criterios.map((c) => ({ id: c.id, caso_uso_id: c.caso_uso_id, tipo_evidencia: c.tipo_evidencia })),
      entidades: spec.spec.entidades.map((e) => ({ id: e.id, nombre: e.nombre })),
      contratos: spec.spec.contratos,
    },
    perfil_actual: approvedProfile(engine) ?? 'sin perfil: propón stack y comandos (TypeScript/Node si nada indica otra cosa)',
    linea_base: baselineSummary(engine),
    borrador_de_tareas: draft,
    evidencia_del_repositorio: input.evidence,
  });
  const schema = llmSchema(PlanOutput);

  let output: PlanOutput | null = null;
  let issues: PlanIssue[] = [];
  let implicit: Record<string, string[]> = {};
  let feedback = '';
  let attempts = 0;
  for (let i = 0; i < 4; i++) {
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
    const parsed = PlanOutput.safeParse(call.outcome.summary.structured);
    if (!parsed.success) {
      feedback = `\n\n<correccion>La respuesta no cumplía el esquema: ${
        call.outcome.summary.error?.message ??
        parsed.error.issues
          .slice(0, 6)
          .map((x) => `${x.path.join('.')}: ${x.message}`)
          .join('; ')
      }</correccion>`;
      continue;
    }
    output = parsed.data;
    ({ issues, implicitResources: implicit } = validatePlan(output, spec.spec));
    const errors = issues.filter((x) => x.severity === 'error');
    if (errors.length === 0) break;
    feedback = `\n\n<correccion>El plan tiene estos problemas; corrígelos y devuelve el plan completo:\n${errors.map((x) => `- ${x.task ?? 'plan'}: ${x.message}`).join('\n')}\n</correccion>\n<plan_anterior>\n${JSON.stringify(output)}\n</plan_anterior>`;
  }
  if (!output) throw new PlannerError('el planeador no devolvió un plan con el formato correcto');

  const previous = latestPlan(engine, input.changeId);
  const revision = (previous?.revision ?? 0) + 1;
  const plan: Plan = {
    schema_version: 1,
    plan_id: previous?.plan.plan_id ?? newId('plan'),
    change_id: input.changeId,
    revision,
    spec_revision: spec.revision,
    spec_hash: spec.hash,
    base_sha: await gitOut(input.repoPath, ['rev-parse', 'HEAD']),
    // An approved profile is the user's decision: the planner cannot change it.
    perfil: approvedProfile(engine) ?? output.perfil,
    tareas: output.tareas,
    supuestos: output.supuestos,
    recursos_implicitos: implicit,
  };
  const hash = hashJson(plan);
  const valid = !issues.some((x) => x.severity === 'error');
  engine.store.execute({ request_id: `plan:${input.changeId}:${revision}:${hash}`, type: 'proponer_plan', input: { changeId: input.changeId, hash } }, () => ({
    result: null,
    events: [
      { type: EV.planProposed, aggregate_type: 'cambio', aggregate_id: input.changeId, payload: { plan_id: plan.plan_id, revision, hash, plan: plan as unknown as Record<string, unknown> } },
      ...(valid && (change.phase === 'dividir' || change.phase === 'ejecutar')
        ? [{ type: EV.changePhase, aggregate_type: 'cambio', aggregate_id: input.changeId, payload: { from: change.phase, to: 'aprobar' } }]
        : []),
    ],
  }));
  const dir = changeDir(input.repoPath, input.changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(join(dir, 'plan.md'), renderPlanMarkdown(plan));
  return { plan, hash, issues, attempts };
}

/** What the planner should know about the untouched repository (failing steps become tasks or assumptions). */
function baselineSummary(engine: Engine): object | string {
  const approved = approvedProfile(engine);
  const b = approved ? latestBaseline(engine, profileHash(approved)) : null;
  if (!b) return 'sin línea base';
  const failing = b.pasos.filter((s) => !s.ok);
  return {
    commit: b.sha.slice(0, 12),
    pasos_que_ya_fallan: failing.map((s) => ({ paso: s.paso, salida: s.detalle.slice(-600) })),
    nota: failing.length ? 'estos pasos ya fallaban antes del cambio: no los atribuyas a las tareas; si hace falta, planifica una tarea para arreglarlos' : 'todo pasaba antes del cambio',
  };
}

export function renderPlanMarkdown(plan: Plan): string {
  const lines = [
    `<!-- Generado por Forja (plan revisión ${plan.revision}, spec revisión ${plan.spec_revision}). -->`,
    '# Plan',
    '',
    `**Stack:** ${plan.perfil.stack.join(', ')} · **Gestor:** ${plan.perfil.gestor}`,
    '',
    '## Olas (tareas que pueden correr en paralelo)',
  ];
  waves(plan.tareas).forEach((w, i) => lines.push(`${i + 1}. ${w.join(', ')}`));
  lines.push('', '## Tareas', '');
  for (const t of plan.tareas) {
    lines.push(
      `### ${t.id} · ${t.titulo}`,
      `- **Tipo:** ${t.tipo} · **Complejidad:** ${t.complejidad}${t.red ? ' · **Red:** sí' : ''}`,
      `- **Objetivo:** ${t.objetivo}`,
      `- **Depende de:** ${t.depende_de.join(', ') || '—'}`,
      `- **Criterios:** ${t.criterios.join(', ') || '—'}`,
      `- **Escribe:** ${t.escribe.map((g) => `\`${g}\``).join(', ')}`,
      ...(t.recursos_exclusivos.length ? [`- **Recursos exclusivos:** ${t.recursos_exclusivos.join(', ')}`] : []),
      ...(t.notas ? [`- **Notas:** ${t.notas}`] : []),
      '',
    );
  }
  if (plan.supuestos.length) lines.push('## Supuestos', ...plan.supuestos.map((s) => `- ${s}`), '');
  return `${lines.join('\n')}\n`;
}
