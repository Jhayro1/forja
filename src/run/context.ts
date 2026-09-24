import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { hashBytes } from '../domain/hash.js';
import { git } from '../git/git.js';
import type { Plan, PlanTask } from '../plan/plan.js';
import { compose, loadPrompt } from '../planner/prompts.js';
import type { Spec } from '../spec/spec.js';
import { acceptanceFilesFor } from '../verify/verify.js';

export type ContextManifest = { prompt_hash: string; fragments: { id: string; reason: string; bytes: number }[]; excluded: string[] };

const MAX_FILE_BYTES = 24_000;
const MAX_TOTAL_FILE_BYTES = 60_000;

function featureText(spec: Spec, ucId: string): string {
  const uc = spec.casos_uso.find((u) => u.id === ucId);
  const lines = [`Característica: ${ucId} ${uc?.nombre ?? ''}`];
  for (const c of spec.criterios.filter((x) => x.caso_uso_id === ucId && x.tipo_evidencia === 'automatica')) {
    lines.push(`  Escenario: ${c.id}`, `    Dado ${c.dado}`, `    Cuando ${c.cuando}`, `    Entonces ${c.entonces}`);
  }
  return lines.join('\n');
}

/**
 * Deterministic context package for one worker attempt (v2/08 · MVP): same inputs
 * → same prompt. Critical rules are never truncated; files that do not fit are
 * listed so the agent can read them itself.
 */
export async function buildWorkerPrompt(input: {
  plan: Plan;
  spec: Spec;
  task: PlanTask;
  worktree: string;
  attempt: number;
  feedback: string | null;
  question: string | null;
  answer: string | null;
}): Promise<{ prompt: string; manifest: ContextManifest }> {
  const { spec, task, plan } = input;
  const fragments: ContextManifest['fragments'] = [];
  const excluded: string[] = [];
  const criteria = spec.criterios.filter((c) => task.criterios.includes(c.id));
  const ucIds = new Set([...criteria.map((c) => c.caso_uso_id), ...spec.casos_uso.filter((u) => u.requisitos.some((r) => task.requisitos.includes(r))).map((u) => u.id)]);
  const ucs = spec.casos_uso.filter((u) => ucIds.has(u.id));
  const ruleIds = new Set(ucs.flatMap((u) => u.reglas));
  const rules = spec.reglas.filter((r) => ruleIds.has(r.id) || task.notas.includes(r.id));
  const entityIds = new Set(ucs.flatMap((u) => u.entidades));
  const entities = task.tipo === 'contrato' || task.tipo === 'infraestructura' ? spec.entidades : spec.entidades.filter((e) => entityIds.has(e.id));
  const contracts = task.tipo === 'contrato' || task.tipo === 'infraestructura' ? spec.contratos : spec.contratos.filter((c) => task.notas.includes(c.id) || ucs.some((u) => c.descripcion.includes(u.id)));
  for (const c of criteria) fragments.push({ id: c.id, reason: 'criterio de la tarea', bytes: JSON.stringify(c).length });
  for (const r of rules) fragments.push({ id: r.id, reason: 'regla de sus casos de uso', bytes: r.texto.length });

  const tree = (await git(input.worktree, ['ls-files'])).stdout.split('\n').filter(Boolean);
  const readGlobs = [...task.lee, ...(task.tipo === 'implementacion' ? acceptanceFilesFor(plan, task) : [])];
  const readFiles = tree.filter((f) => readGlobs.some((g) => f === g || matchesGlob(f, g)));
  const files: Record<string, string> = {};
  let total = 0;
  for (const f of readFiles) {
    const full = join(input.worktree, f);
    if (!existsSync(full)) continue;
    const size = statSync(full).size;
    if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_FILE_BYTES) {
      excluded.push(f);
      continue;
    }
    files[f] = readFileSync(full, 'utf8');
    total += size;
    fragments.push({ id: f, reason: 'archivo que la tarea debe leer', bytes: size });
  }

  const c = plan.perfil.comandos;
  const verify = (['typecheck', 'build', 'lint', 'test'] as const)
    .map((k) => (c[k] ? `${k}: ${[c[k]!.executable, ...c[k]!.args].join(' ')}` : null))
    .filter(Boolean);
  const data: Record<string, unknown> = {
    tarea: {
      id: task.id,
      titulo: task.titulo,
      objetivo: task.objetivo,
      tipo: task.tipo,
      notas: task.notas,
      archivos_que_puedes_escribir: task.escribe,
      archivos_protegidos: plan.tareas.filter((t) => t.tipo === 'pruebas' && t.id !== task.id).flatMap((t) => t.escribe),
      comandos_de_verificacion: verify,
      stack: plan.perfil.stack,
    },
    criterios_de_aceptacion: criteria,
    ...(task.tipo === 'pruebas' ? { escenarios: [...ucIds].map((id) => featureText(spec, id)).join('\n\n') } : {}),
    casos_de_uso: ucs.map((u) => ({ id: u.id, nombre: u.nombre, pasos: u.pasos, alternos: u.alternos, excepciones: u.excepciones })),
    reglas: rules,
    entidades: entities,
    contratos: contracts,
    decisiones: spec.decisiones.filter((d) => d.estado === 'aprobada'),
    archivos_del_proyecto: tree.length > 300 ? [...tree.slice(0, 300), `… y ${tree.length - 300} más`] : tree,
    contenido_de_archivos: files,
    ...(excluded.length ? { archivos_no_incluidos: `Léelos si los necesitas: ${excluded.join(', ')}` } : {}),
    ...(input.feedback
      ? { intento_anterior: `Este es el intento ${input.attempt}. Tu trabajo anterior sigue en el directorio. Esto falló y debes corregirlo:\n${input.feedback}` }
      : {}),
    ...(input.question && input.answer ? { aclaracion: { pregunta: input.question, respuesta: input.answer } } : {}),
  };
  const { prompt } = compose([loadPrompt('trabajo/trabajador')], { contexto: data });
  return { prompt, manifest: { prompt_hash: hashBytes(prompt), fragments, excluded } };
}

/** The worker's structured way to ask (v2/04 · Preguntas y decisiones). */
export function extractQuestion(text: string | null): string | null {
  if (!text) return null;
  const m = /NECESITA_ACLARACION:\s*([\s\S]+)/.exec(text);
  return m ? m[1]!.trim().slice(0, 2000) : null;
}
