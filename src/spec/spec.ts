import { z } from 'zod';

/**
 * Spec body as produced by the planner (v2/formatos/especificacion-y-configuracion.md).
 * LLM-facing: every field required, nullable when it may be absent.
 * Forja wraps it with schema_version, project_id, change_id and revision.
 */
const Id = (re: RegExp, example: string) => z.string().regex(re, `formato ${example}`);

export const SpecBody = z
  .object({
    sistema: z.object({ nombre: z.string(), objetivo: z.string(), alcance: z.array(z.string()), fuera_de_alcance: z.array(z.string()) }).strict(),
    actores: z.array(z.object({ id: Id(/^A-\d{3}$/, 'A-001'), nombre: z.string(), tipo: z.enum(['humano', 'sistema']), descripcion: z.string() }).strict()),
    terminos: z.array(z.object({ termino: z.string(), definicion: z.string() }).strict()),
    requisitos: z.array(z.object({ id: Id(/^REQ-\d{3}$/, 'REQ-001'), texto: z.string(), prioridad: z.enum(['alta', 'media', 'baja']), origen: z.string() }).strict()),
    entidades: z.array(
      z
        .object({
          id: Id(/^E-\d{3}$/, 'E-001'),
          nombre: z.string(),
          campos: z.array(z.object({ nombre: z.string(), tipo: z.string(), requerido: z.boolean(), restriccion: z.string().nullable() }).strict()),
          invariantes: z.array(z.string()),
        })
        .strict(),
    ),
    reglas: z.array(z.object({ id: Id(/^R-\d{3}$/, 'R-001'), texto: z.string(), referencias: z.array(z.string()) }).strict()),
    casos_uso: z.array(
      z
        .object({
          id: Id(/^UC-\d{3}$/, 'UC-001'),
          nombre: z.string(),
          actor_id: z.string(),
          objetivo: z.string(),
          precondiciones: z.array(z.string()),
          postcondiciones: z.array(z.string()),
          pasos: z.array(z.object({ id: Id(/^P\d+$/, 'P1'), texto: z.string() }).strict()).min(1),
          alternos: z.array(z.object({ id: Id(/^AL\d+$/, 'AL1'), desde_paso: z.string(), condicion: z.string(), pasos: z.array(z.string()), retorno: z.string().nullable() }).strict()),
          excepciones: z.array(z.object({ id: Id(/^EX\d+$/, 'EX1'), desde_paso: z.string(), condicion: z.string(), resultado: z.string() }).strict()),
          excepciones_no_aplican: z.string().nullable(),
          reglas: z.array(z.string()),
          entidades: z.array(z.string()),
          requisitos: z.array(z.string()),
        })
        .strict(),
    ),
    criterios: z.array(
      z
        .object({
          id: Id(/^CA-UC-\d{3}-\d{2}$/, 'CA-UC-001-01'),
          caso_uso_id: z.string(),
          requisitos: z.array(z.string()),
          dado: z.string(),
          cuando: z.string(),
          entonces: z.string(),
          tipo_evidencia: z.enum(['automatica', 'manual']),
        })
        .strict(),
    ),
    contratos: z.array(z.object({ id: Id(/^CT-\d{3}$/, 'CT-001'), tipo: z.enum(['endpoint', 'tipo', 'evento', 'esquema', 'otro']), descripcion: z.string(), detalle: z.string() }).strict()),
    rnf: z.array(
      z
        .object({
          id: Id(/^RNF-\d{3}$/, 'RNF-001'),
          metrica: z.string(),
          unidad: z.string(),
          umbral: z.string(),
          comparador: z.enum(['<', '<=', '>', '>=', '=']),
          escenario: z.string(),
          metodo: z.string(),
        })
        .strict(),
    ),
    integraciones: z.array(
      z.object({ id: Id(/^I-\d{3}$/, 'I-001'), tipo: z.string(), recurso: z.string(), operaciones: z.array(z.string()), sensibilidad: z.enum(['baja', 'media', 'alta']) }).strict(),
    ),
    decisiones: z.array(z.object({ id: z.string(), texto: z.string(), motivo: z.string(), estado: z.enum(['aprobada', 'propuesta', 'sustituida']) }).strict()),
    preguntas: z.array(z.object({ id: Id(/^Q-\d{3}$/, 'Q-001'), texto: z.string(), bloquea: z.array(z.string()), responsable: z.string(), condicion: z.string() }).strict()),
  })
  .strict();
export type SpecBody = z.infer<typeof SpecBody>;

export type Spec = SpecBody & { schema_version: 2; project_id: string; change_id: string; revision: number };

export type SpecIssue = { path: string; message: string; severity: 'error' | 'aviso' };

/**
 * Semantic validation beyond the schema. Structure being valid does not prove the
 * business is right (v2/formatos): these checks catch broken references and gaps.
 */
export function validateSpec(spec: SpecBody): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: 'aviso' });

  const ids = new Map<string, string>();
  const register = (id: string, where: string) => {
    if (ids.has(id)) err(where, `id duplicado ${id} (también en ${ids.get(id)})`);
    else ids.set(id, where);
  };
  spec.actores.forEach((a, i) => register(a.id, `actores[${i}]`));
  spec.requisitos.forEach((r, i) => register(r.id, `requisitos[${i}]`));
  spec.entidades.forEach((e, i) => register(e.id, `entidades[${i}]`));
  spec.reglas.forEach((r, i) => register(r.id, `reglas[${i}]`));
  spec.casos_uso.forEach((u, i) => register(u.id, `casos_uso[${i}]`));
  spec.criterios.forEach((c, i) => register(c.id, `criterios[${i}]`));
  spec.contratos.forEach((c, i) => register(c.id, `contratos[${i}]`));
  spec.rnf.forEach((r, i) => register(r.id, `rnf[${i}]`));
  spec.integraciones.forEach((r, i) => register(r.id, `integraciones[${i}]`));
  spec.decisiones.forEach((d, i) => register(d.id, `decisiones[${i}]`));
  spec.preguntas.forEach((q, i) => register(q.id, `preguntas[${i}]`));

  const has = (id: string, prefix?: string) => ids.has(id) && (prefix === undefined || id.startsWith(prefix));

  if (spec.casos_uso.length === 0) err('casos_uso', 'la especificación no tiene casos de uso');
  spec.casos_uso.forEach((u, i) => {
    const at = `casos_uso[${i}] ${u.id}`;
    if (!has(u.actor_id, 'A-')) err(at, `actor ${u.actor_id} no existe`);
    const steps = new Set(u.pasos.map((p) => p.id));
    if (steps.size !== u.pasos.length) err(at, 'ids de pasos repetidos');
    for (const a of u.alternos) if (!steps.has(a.desde_paso)) err(`${at} ${a.id}`, `el flujo alterno parte del paso ${a.desde_paso}, que no existe`);
    for (const x of u.excepciones) if (!steps.has(x.desde_paso)) err(`${at} ${x.id}`, `la excepción parte del paso ${x.desde_paso}, que no existe`);
    if (u.excepciones.length === 0 && !u.excepciones_no_aplican?.trim()) err(at, 'no tiene excepciones ni justifica por qué no aplican');
    for (const r of u.reglas) if (!has(r, 'R-')) err(at, `regla ${r} no existe`);
    for (const e of u.entidades) if (!has(e, 'E-')) err(at, `entidad ${e} no existe`);
    for (const r of u.requisitos) if (!has(r, 'REQ-')) err(at, `requisito ${r} no existe`);
    if (!spec.criterios.some((c) => c.caso_uso_id === u.id)) err(at, 'no tiene criterios de aceptación');
  });

  spec.criterios.forEach((c, i) => {
    const at = `criterios[${i}] ${c.id}`;
    if (!has(c.caso_uso_id, 'UC-')) err(at, `caso de uso ${c.caso_uso_id} no existe`);
    else if (!c.id.startsWith(`CA-${c.caso_uso_id}-`)) err(at, `el id debe empezar con CA-${c.caso_uso_id}-`);
    for (const r of c.requisitos) if (!has(r, 'REQ-')) err(at, `requisito ${r} no existe`);
    for (const [k, v] of [
      ['dado', c.dado],
      ['cuando', c.cuando],
      ['entonces', c.entonces],
    ] as const)
      if (!v.trim()) err(at, `«${k}» está vacío`);
  });

  for (const r of spec.requisitos) {
    if (r.prioridad !== 'baja' && !spec.criterios.some((c) => c.requisitos.includes(r.id))) err(r.id, 'requisito entregable sin criterio de aceptación que lo verifique');
  }
  spec.reglas.forEach((r, i) => {
    if (r.referencias.length === 0) warn(`reglas[${i}] ${r.id}`, 'la regla no referencia requisitos, casos ni entidades');
    for (const ref of r.referencias) if (!ids.has(ref)) err(`reglas[${i}] ${r.id}`, `referencia ${ref} no existe`);
    const used = spec.casos_uso.some((u) => u.reglas.includes(r.id));
    if (!used) warn(r.id, 'ningún caso de uso aplica esta regla');
  });
  spec.preguntas.forEach((q, i) => {
    for (const b of q.bloquea) if (!ids.has(b)) err(`preguntas[${i}] ${q.id}`, `bloquea ${b}, que no existe`);
  });
  if (spec.sistema.alcance.length === 0) err('sistema.alcance', 'el alcance está vacío');
  return issues;
}

/** Questions that block executing part of the scope (v2/04: a pending question blocks the gate). */
export function blockingQuestions(spec: SpecBody): SpecBody['preguntas'] {
  return spec.preguntas.filter((q) => q.bloquea.length > 0);
}
