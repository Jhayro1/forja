import { z } from 'zod';
import type { Spec } from '../spec/spec.js';

const CommandRecipeLlm = z.object({ executable: z.string(), args: z.array(z.string()) }).strict();

/** Task as proposed by the planner (LLM-facing: all fields required). */
export const PlanTask = z
  .object({
    id: z.string().regex(/^T-\d{3}$/, 'formato T-001'),
    titulo: z.string(),
    objetivo: z.string(),
    tipo: z.enum(['infraestructura', 'contrato', 'pruebas', 'implementacion', 'integracion', 'documentacion']),
    criterios: z.array(z.string()),
    requisitos: z.array(z.string()),
    depende_de: z.array(z.string()),
    escribe: z.array(z.string()).min(1).describe('globs que la tarea puede crear o modificar'),
    lee: z.array(z.string()).describe('archivos o globs que necesita leer como contexto'),
    recursos_exclusivos: z.array(z.string()).describe('p. ej. lockfile, migraciones, configuracion'),
    complejidad: z.enum(['baja', 'media', 'alta']),
    red: z.boolean().describe('true sólo si necesita instalar dependencias'),
    notas: z.string(),
  })
  .strict();
export type PlanTask = z.infer<typeof PlanTask>;

export const ProfileProposal = z
  .object({
    stack: z.array(z.string()),
    gestor: z.string(),
    comandos: z
      .object({
        instalar: CommandRecipeLlm.nullable(),
        build: CommandRecipeLlm.nullable(),
        typecheck: CommandRecipeLlm.nullable(),
        lint: CommandRecipeLlm.nullable(),
        test: CommandRecipeLlm.nullable(),
      })
      .strict(),
    red_instalar: z.array(z.string()).describe('hosts necesarios para instalar dependencias, p. ej. registry.npmjs.org'),
  })
  .strict();
export type ProfileProposal = z.infer<typeof ProfileProposal>;

export const PlanOutput = z
  .object({
    perfil: ProfileProposal.describe('stack y comandos del proyecto; respeta el perfil existente si lo hay'),
    tareas: z.array(PlanTask).min(1),
    supuestos: z.array(z.string()),
  })
  .strict();
export type PlanOutput = z.infer<typeof PlanOutput>;

export type Plan = {
  schema_version: 1;
  plan_id: string;
  change_id: string;
  revision: number;
  spec_revision: number;
  spec_hash: string;
  base_sha: string;
  perfil: ProfileProposal;
  tareas: PlanTask[];
  supuestos: string[];
  /** Resource added by Forja when two tasks might write the same files. */
  recursos_implicitos: Record<string, string[]>;
};

export type PlanIssue = { task: string | null; message: string; severity: 'error' | 'aviso' };

/** Static prefix of a glob, before the first wildcard. */
function globPrefix(glob: string): string {
  const i = glob.search(/[*?[{]/);
  return (i < 0 ? glob : glob.slice(0, i)).replace(/^\.\//, '');
}

/** Conservative: true unless we can show the globs are disjoint (v2/04). */
export function globsMayOverlap(a: string, b: string): boolean {
  const pa = globPrefix(a);
  const pb = globPrefix(b);
  const exactA = pa === a.replace(/^\.\//, '');
  const exactB = pb === b.replace(/^\.\//, '');
  if (exactA && exactB) return pa === pb;
  if (exactA) return pa.startsWith(pb);
  if (exactB) return pb.startsWith(pa);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** Ancestors of a task through depends_on. */
function ancestors(tasks: Map<string, PlanTask>, id: string, seen = new Set<string>()): Set<string> {
  for (const dep of tasks.get(id)?.depende_de ?? []) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    ancestors(tasks, dep, seen);
  }
  return seen;
}

export function findCycle(tasks: PlanTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visitando' | 'hecho'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'hecho') return null;
    if (state.get(id) === 'visitando') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visitando');
    stack.push(id);
    for (const dep of byId.get(id)?.depende_de ?? []) {
      if (!byId.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'hecho');
    return null;
  };
  for (const t of tasks) {
    const cycle = visit(t.id);
    if (cycle) return cycle;
  }
  return null;
}

/** Waves are a presentation (the scheduler does not wait on them). */
export function waves(tasks: PlanTask[]): string[][] {
  const level = new Map<string, number>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = (id: string, guard = 0): number => {
    if (level.has(id)) return level.get(id)!;
    if (guard > tasks.length) return 0;
    const deps = (byId.get(id)?.depende_de ?? []).filter((d) => byId.has(d));
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((x) => depth(x, guard + 1)));
    level.set(id, d);
    return d;
  };
  tasks.forEach((t) => depth(t.id));
  const out: string[][] = [];
  for (const [id, d] of level) (out[d] ??= []).push(id);
  return out.map((w) => w.sort());
}

/**
 * Validates the plan against the spec and adds implicit exclusive resources where
 * two independent tasks might write the same files.
 */
export function validatePlan(output: PlanOutput, spec: Spec): { issues: PlanIssue[]; implicitResources: Record<string, string[]> } {
  const issues: PlanIssue[] = [];
  const err = (task: string | null, message: string) => issues.push({ task, message, severity: 'error' });
  const warn = (task: string | null, message: string) => issues.push({ task, message, severity: 'aviso' });
  const tasks = new Map<string, PlanTask>();
  for (const t of output.tareas) {
    if (tasks.has(t.id)) err(t.id, 'id de tarea duplicado');
    tasks.set(t.id, t);
  }
  const criteria = new Set(spec.criterios.map((c) => c.id));
  const reqs = new Set(spec.requisitos.map((r) => r.id));
  for (const t of output.tareas) {
    for (const d of t.depende_de) if (!tasks.has(d)) err(t.id, `depende de ${d}, que no existe`);
    if (t.depende_de.includes(t.id)) err(t.id, 'depende de sí misma');
    for (const c of t.criterios) if (!criteria.has(c)) err(t.id, `criterio ${c} no existe en la spec`);
    for (const r of t.requisitos) if (!reqs.has(r)) err(t.id, `requisito ${r} no existe en la spec`);
    for (const g of t.escribe)
      if (g.startsWith('/') || g.split('/').includes('..') || g === '.git' || g.startsWith('.git/') || g === '.forja' || g.startsWith('.forja/')) err(t.id, `ruta de escritura no permitida: ${g}`);
  }
  const cycle = findCycle(output.tareas);
  if (cycle) err(null, `ciclo de dependencias: ${cycle.join(' → ')}`);

  for (const c of spec.criterios) {
    if (c.tipo_evidencia === 'automatica' && !output.tareas.some((t) => t.criterios.includes(c.id))) err(null, `el criterio ${c.id} no lo cubre ninguna tarea`);
  }

  // Implementation tasks must not write acceptance tests (R03).
  const testGlobs = output.tareas.filter((t) => t.tipo === 'pruebas').flatMap((t) => t.escribe.map((g) => ({ g, owner: t.id })));
  for (const t of output.tareas.filter((x) => x.tipo === 'implementacion')) {
    for (const g of t.escribe) {
      const clash = testGlobs.find((tg) => globsMayOverlap(g, tg.g));
      if (clash) err(t.id, `escribe ${g}, que se solapa con las pruebas de ${clash.owner} (${clash.g}); las pruebas son protegidas`);
    }
  }

  const implicitResources: Record<string, string[]> = {};
  if (!cycle) {
    const list = output.tareas;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const ordered = ancestors(tasks, a.id).has(b.id) || ancestors(tasks, b.id).has(a.id);
        if (ordered) continue;
        const overlap = a.escribe.some((ga) => b.escribe.some((gb) => globsMayOverlap(ga, gb)));
        if (overlap) {
          const key = `archivos:${[a.id, b.id].sort().join('+')}`;
          implicitResources[key] = [a.id, b.id];
          warn(a.id, `puede escribir los mismos archivos que ${b.id}: no correrán a la vez`);
        }
      }
    }
  }
  return { issues, implicitResources };
}

/** Exclusive resources of a task, declared plus implicit. */
export function taskResources(plan: Plan, taskId: string): string[] {
  const declared = plan.tareas.find((t) => t.id === taskId)?.recursos_exclusivos ?? [];
  const implicit = Object.entries(plan.recursos_implicitos)
    .filter(([, ids]) => ids.includes(taskId))
    .map(([k]) => k);
  return [...declared, ...implicit];
}
