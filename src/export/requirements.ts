import type { Engine } from '../core/engine.js';
import { latestPlan } from '../plan/divide.js';
import { taskMinutes } from '../plan/estimate.js';
import { getDiscovery, listChanges } from '../planner/session.js';
import type { Spec } from '../spec/spec.js';
import { EpicService } from '../work/epics.js';
import { buildHistory, type HistoryTask } from '../work/history.js';
import { buildXlsx, type Cell, cellRef, type Sheet } from './xlsx.js';

/**
 * The project's requirements as the functional requirements workbook (INI###_…_Reqs):
 * process map, DER (epics and user stories with their review state), final stories with
 * the estimate, the lists and a lookup sheet, plus the tasks Forja planned. Built from
 * what Forja already has, in layers:
 *
 *   Macroproceso = the project · Proceso = a Forja epic · Subproceso (Pnn) = a sprint
 *   Épica (Enn) = the capability around one entity of the spec · HU = a use case
 *
 * Nothing is invented: what Forja does not know (hours) is left for the user to fill.
 */

type UseCase = Spec['casos_uso'][number];
type Criterion = Spec['criterios'][number];
type Revision = { revision: number; spec: Spec };

export type ExportOptions = { iniciativa?: string; contingencia?: number; today?: string };

const ESTADOS = ['Aprobado', 'Fusionado', 'Dividido', 'Cambiado', 'Postergado', 'Descartado'] as const;
const pad = (n: number) => String(n).padStart(2, '0');
const sentence = (s: string) => {
  const t = s.trim();
  return !t ? '' : /[.!?…]$/.test(t) ? t : `${t}.`;
};
const join = (items: string[], sep = '; ') =>
  items
    .map((x) => x.trim())
    .filter(Boolean)
    .join(sep);
const unique = <T>(items: T[]) => [...new Set(items)];
const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function revisions(engine: Engine, changeId: string): Revision[] {
  const rows = engine.store.db.prepare('SELECT revision, spec FROM specs WHERE change_id = ? ORDER BY revision').all(changeId) as { revision: number; spec: string }[];
  return rows.map((r) => ({ revision: r.revision, spec: JSON.parse(r.spec) as Spec }));
}

/** A use case with its criteria, comparable between revisions. */
const fingerprint = (spec: Spec, id: string) => JSON.stringify({ u: spec.casos_uso.find((x) => x.id === id) ?? null, c: spec.criterios.filter((c) => c.caso_uso_id === id) });

type StoryState = { estado: (typeof ESTADOS)[number]; observacion: string; nueva: boolean };

/**
 * Review state of each use case across the spec's revisions (the DER's «Estado HU»):
 * unchanged since it appeared → Aprobado; changed → Cambiado; gone from the latest →
 * Descartado. One that appeared after the first revision is «nueva» in the final sheet.
 */
function storyStates(revs: Revision[]): Map<string, StoryState> {
  const out = new Map<string, StoryState>();
  const latest = revs.at(-1);
  if (!latest) return out;
  const ids = unique(revs.flatMap((r) => r.spec.casos_uso.map((u) => u.id)));
  for (const id of ids) {
    const present = revs.filter((r) => r.spec.casos_uso.some((u) => u.id === id));
    const first = present[0]!;
    const nueva = first.revision !== revs[0]!.revision;
    if (!latest.spec.casos_uso.some((u) => u.id === id)) {
      out.set(id, { estado: 'Descartado', observacion: `Se quitó en la revisión ${revs.find((r) => r.revision > present.at(-1)!.revision)?.revision ?? '?'} de la especificación.`, nueva });
      continue;
    }
    const changes = present.slice(1).filter((r, i) => fingerprint(r.spec, id) !== fingerprint(present[i]!.spec, id));
    out.set(
      id,
      changes.length
        ? { estado: 'Cambiado', observacion: `Cambió en la revisión ${changes.map((r) => r.revision).join(', ')} de la especificación.`, nueva }
        : { estado: 'Aprobado', observacion: nueva ? `Nueva desde la revisión ${first.revision}.` : '', nueva },
    );
  }
  return out;
}

/** Latest known version of every use case (also the discarded ones), in process order. */
function allCases(revs: Revision[]): { uc: UseCase; criterios: Criterion[]; spec: Spec }[] {
  const seen = new Map<string, { uc: UseCase; criterios: Criterion[]; spec: Spec }>();
  for (const r of revs) for (const uc of r.spec.casos_uso) seen.set(uc.id, { uc, criterios: r.spec.criterios.filter((c) => c.caso_uso_id === uc.id), spec: r.spec });
  const latest = revs.at(-1)?.spec.casos_uso.map((u) => u.id) ?? [];
  return [...seen.values()].sort((a, b) => {
    const ia = latest.indexOf(a.uc.id);
    const ib = latest.indexOf(b.uc.id);
    return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib) || a.uc.id.localeCompare(b.uc.id);
  });
}

type EpicGroup = { key: string; nombre: string; casos: { uc: UseCase; criterios: Criterion[]; spec: Spec }[] };

/**
 * Epics of the workbook: the capability around the main entity each use case works on
 * («Gestión de Cotización»), in the order the process first needs it. A use case
 * without entities goes to «Funciones generales».
 */
function epicsOf(cases: ReturnType<typeof allCases>): EpicGroup[] {
  const groups = new Map<string, EpicGroup>();
  for (const c of cases) {
    const entity = c.uc.entidades.map((id) => c.spec.entidades.find((e) => e.id === id)).find(Boolean);
    const key = entity?.id ?? 'general';
    const g = groups.get(key) ?? { key, nombre: entity ? `Gestión de ${lower(entity.nombre)}` : 'Funciones generales', casos: [] };
    g.casos.push(c);
    groups.set(key, g);
  }
  return [...groups.values()];
}

function epicDetail(g: EpicGroup, spec: Spec): string {
  const live = g.casos;
  const rules = unique(live.flatMap((c) => c.uc.reglas)).map((id) => spec.reglas.find((r) => r.id === id)?.texto ?? id);
  const entities = unique(live.flatMap((c) => c.uc.entidades)).map((id) => spec.entidades.find((e) => e.id === id)?.nombre ?? id);
  return [
    `Objetivo funcional: ${sentence(
      join(
        live.map((c) => lower(c.uc.objetivo)),
        '; ',
      ),
    )}`,
    `Alcance incluido: ${sentence(
      join(
        live.map((c) => c.uc.nombre),
        ', ',
      ),
    )}`,
    `Reglas principales: ${sentence(join(rules) || 'sin reglas de negocio propias')}`,
    `Entidades requeridas: ${sentence(join(entities, ', ') || 'no aplica')}`,
    `Dependencias: ${sentence(join(unique(live.flatMap((c) => c.uc.precondiciones))) || 'ninguna')}`,
    `Fuera de alcance: ${sentence(join(spec.sistema.fuera_de_alcance) || 'no se declaró')}`,
    `Resultado esperado: ${sentence(join(unique(live.flatMap((c) => c.uc.postcondiciones))) || join(live.map((c) => c.uc.objetivo)))}`,
  ].join('\n');
}

function storyDetail(uc: UseCase, criterios: Criterion[], spec: Spec): string {
  const actor = spec.actores.find((a) => a.id === uc.actor_id)?.nombre ?? uc.actor_id;
  // The benefit is what the system is for: postconditions are results, they go elsewhere.
  const benefit = spec.sistema.objetivo;
  const rules = uc.reglas.map((id) => spec.reglas.find((r) => r.id === id)?.texto ?? id);
  const reqs = uc.requisitos.map((id) => `${id} ${spec.requisitos.find((r) => r.id === id)?.texto ?? ''}`.trim());
  const exceptions = [
    ...uc.excepciones.map((x) => `si ${lower(x.condicion)} (${x.desde_paso}), ${lower(x.resultado)}`),
    ...uc.alternos.map((a) => `alterno: si ${lower(a.condicion)} (${a.desde_paso}), ${lower(join(a.pasos, ', '))}`),
  ];
  return [
    `Como ${lower(actor)}, quiero ${lower(uc.objetivo).replace(/\.$/, '')}, para ${lower(benefit).replace(/\.$/, '')}.`,
    `Detalle funcional: ${sentence(
      join(
        uc.pasos.map((p) => `${p.id} ${p.texto}`),
        '; ',
      ),
    )}${reqs.length ? ` Cubre: ${sentence(join(reqs))}` : ''}${uc.postcondiciones.length ? ` Resultado: ${sentence(join(uc.postcondiciones))}` : ''}`,
    `Reglas principales: ${sentence(join(rules) || 'sin reglas propias')}`,
    `Criterios de aceptación: ${sentence(join(criterios.map((c) => `dado ${lower(c.dado)}, cuando ${lower(c.cuando)}, entonces ${lower(c.entonces)}`)))}`,
    `Excepciones/consideraciones: ${sentence(join(exceptions) || uc.excepciones_no_aplican || 'no aplica')}`,
  ].join('\n');
}

function toBe(title: string, spec: Spec | null, state: ReturnType<typeof getDiscovery>['state']): string {
  if (!spec) {
    const base = state.resumen || state.idea || title;
    return `El sistema podría ${lower(base).replace(/\.$/, '')}. ${state.alcance.incluye.length ? `Incluiría: ${join(state.alcance.incluye, ', ')}.` : ''} Todavía no tiene especificación: se detalla al priorizarlo.`.trim();
  }
  const reqs = spec.requisitos.map((r) => (/^el sistema/i.test(r.texto) ? sentence(r.texto) : `El sistema debe ${lower(sentence(r.texto))}`));
  const high = spec.requisitos.filter((r) => r.prioridad === 'alta').map((r) => r.texto);
  const later = [...spec.requisitos.filter((r) => r.prioridad === 'baja').map((r) => r.texto), ...spec.sistema.fuera_de_alcance];
  return [
    `«${spec.sistema.nombre}» debe permitir ${lower(spec.sistema.objetivo).replace(/\.$/, '')}.`,
    ...reqs,
    spec.reglas.length ? `Reglas: ${sentence(join(spec.reglas.map((r) => r.texto)))}` : '',
    spec.integraciones.length ? `Se integra con: ${sentence(join(spec.integraciones.map((i) => `${i.recurso} (${join(i.operaciones, ', ')})`)))}` : '',
    spec.sistema.fuera_de_alcance.length ? `Queda fuera del sistema: ${sentence(join(spec.sistema.fuera_de_alcance))}` : '',
    spec.preguntas.length ? `Pendiente de definición: ${sentence(join(spec.preguntas.map((q) => q.texto)))}` : '',
    `En una versión inicial, el sistema debe priorizar: ${sentence(join(high) || join(spec.sistema.alcance))}${later.length ? ` Deben quedar para fases posteriores: ${sentence(join(later))}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const header = (names: string[]): Cell[] => names.map((v) => ({ v, s: 'header' }));
const w = (v: string | number | null | undefined): Cell => ({ v: v ?? '', s: 'wrap' });

export type RequirementsWorkbook = { file: string; data: Buffer; sprints: number; stories: number };

export function buildRequirementsWorkbook(engine: Engine, opts: ExportOptions = {}): RequirementsWorkbook {
  const ini = (opts.iniciativa ?? 'INI001').trim().toUpperCase() || 'INI001';
  const contingency = opts.contingencia ?? 0.15;
  const project = engine.config.nombre;
  const epics = new EpicService(engine);
  const epicById = new Map(epics.list().map((e) => [e.epic_id, e]));
  const history = buildHistory(engine, opts.today);
  const sprintInfo = new Map(history.epicas.flatMap((e) => e.sprints.map((s) => [s.id, { ...s, epica: e.id ? (epicById.get(e.id)?.title ?? e.titulo) : 'Sin épica' }])));
  // Oldest first: P01 is the first sprint ever created, so codes never move.
  const changes = listChanges(engine).slice().reverse();

  const mapa: Cell[][] = [header(['ID', 'Macroproceso', 'Proceso', 'Código Subproceso', 'Subproceso', 'Objetivo', 'Descripción', 'TO BE', 'Alcance'])];
  const der: Cell[][] = [
    [{ v: `${ini} · ${project} · Detalle de épicas y requerimientos`, s: 'title' }],
    [{ v: 'Una fila por historia de usuario. Nunca se borran: se cambia el estado y se explica en la observación.', s: 'muted' }],
    [],
    header([
      'ID',
      'Alcance',
      'Macroproceso',
      'Proceso',
      'Código Sub Proces',
      'Subproceso',
      'Código épica',
      'Épicas',
      'Detalle épica',
      'Código HU',
      'Nombre HU',
      'Detalle HU',
      'Estado HU',
      'Observación/Comentario',
      'Copiar para buscar',
    ]),
  ];
  const finales: Cell[][] = [
    [{ v: `${ini} · ${project} · Épicas y HU finales (MVP refinado y estimación)`, s: 'title' }],
    header([
      'ID',
      'Código épica',
      'Épicas',
      'Detalle épica',
      'Nuevo código',
      'HU Nombre Final',
      'HU Detallado Final',
      'Alcance',
      'Horas funcionales',
      'Horas técnicas',
      'Horas pruebas',
      'Horas deploy/gestión',
      'Subtotal horas',
      'Contingencia %',
      'Horas contingencia',
      'Total estimado',
      'Sprint',
      'Fase del sprint',
      'Avance de tareas',
      'Minutos de agentes (Forja)',
      'Prioridad',
      'Fecha objetivo',
    ]),
  ];
  const tareas: Cell[][] = [
    header(['Código Subproceso', 'Sprint', 'Código HU', 'Tarea', 'Título', 'Tipo', 'Complejidad', 'Depende de', 'Estado', 'Rol', 'Inicio', 'Fin', 'Minutos de agentes (Forja)']),
  ];
  const entidades: Cell[][] = [header(['Código Subproceso', 'Entidad', 'Campo', 'Tipo', 'Requerido', 'Restricción', 'Invariantes'])];
  const terminos = new Map<string, string>();
  let derId = 0;
  let finalId = 0;
  let stories = 0;

  changes.forEach((change, i) => {
    const code = `P${pad(i + 1)}`;
    const info = sprintInfo.get(change.change_id);
    const proceso = info?.epica ?? 'Sin épica';
    const { state } = getDiscovery(engine, change.change_id);
    const revs = revisions(engine, change.change_id);
    const spec = revs.at(-1)?.spec ?? null;
    const alcance = change.phase === 'cancelado' ? 'Alcance 3' : spec ? 'Alcance 1' : 'Alcance 2';
    const objetivo = sentence(spec?.sistema.objetivo || state.resumen || change.title);
    const descripcion = [
      state.alcance.incluye.length || spec ? `Incluye ${lower(join(state.alcance.incluye.length ? state.alcance.incluye : (spec?.sistema.alcance ?? []), ', '))}.` : '',
      `Inicia con la idea: «${state.idea || change.title}».`,
      spec ? `Termina con ${lower(join(unique(spec.casos_uso.flatMap((u) => u.postcondiciones)).slice(0, 3), '; ') || 'los casos de uso completos')}.` : '',
      state.alcance.excluye.length ? `No incluye ${lower(join(state.alcance.excluye, ', '))}.` : '',
      (() => {
        const accepted = Object.values(state.decisiones).filter((d) => d.estado === 'aceptada');
        return accepted.length ? `Considera: ${join(accepted.map((d) => d.contenido))}.` : '';
      })(),
    ]
      .filter(Boolean)
      .join(' ');
    mapa.push([i + 1, w(project), w(proceso), code, w(change.title), w(objetivo), w(descripcion), w(toBe(change.title, spec, state)), alcance]);
    for (const t of spec?.terminos ?? []) if (!terminos.has(t.termino)) terminos.set(t.termino, t.definicion);

    if (!spec) {
      // Not described yet: one placeholder row keeps it visible in the DER.
      derId++;
      der.push([derId, alcance, w(project), w(proceso), code, w(change.title), null, null, null, null, null, null, null, w(`Sin especificación todavía (fase ${change.phase}).`), w(change.title)]);
      return;
    }
    const states = storyStates(revs);
    const groups = epicsOf(allCases(revs));
    const tasks = new Map<string, HistoryTask>((info?.historias ?? []).flatMap((h) => h.tareas.map((t) => [t.id, t] as const)));
    const plan = latestPlan(engine, change.change_id)?.plan ?? null;
    const ucOfCriterion = new Map(spec.criterios.map((c) => [c.id, c.caso_uso_id]));
    const huCode = new Map<string, string>();

    groups.forEach((g, gi) => {
      const epicCode = `${ini}_${code}_E${pad(gi + 1)}`;
      const detail = epicDetail(g, spec);
      g.casos.forEach((c, ci) => {
        const hu = `${epicCode}_HU${pad(ci + 1)}`;
        huCode.set(c.uc.id, hu);
        const st = states.get(c.uc.id)!;
        derId++;
        stories++;
        der.push([
          derId,
          alcance,
          w(project),
          w(proceso),
          code,
          w(change.title),
          epicCode,
          w(g.nombre),
          w(detail),
          hu,
          w(`${c.uc.nombre} (${c.uc.id})`),
          w(storyDetail(c.uc, c.criterios, c.spec)),
          st.estado,
          w(st.observacion),
          w(change.title),
        ]);
        if (st.estado === 'Descartado' || change.phase === 'cancelado') return;
        finalId++;
        const row = finales.length + 1;
        const mine = (plan?.tareas ?? []).filter((t) => t.criterios.some((k) => ucOfCriterion.get(k) === c.uc.id));
        const done = mine.filter((t) => tasks.get(t.id)?.marca === 'unida').length;
        const priority =
          c.uc.requisitos.map((id) => spec.requisitos.find((r) => r.id === id)?.prioridad).find((p) => p === 'alta') ??
          c.uc.requisitos.map((id) => spec.requisitos.find((r) => r.id === id)?.prioridad).find(Boolean) ??
          '';
        finales.push([
          finalId,
          epicCode,
          w(g.nombre),
          w(detail),
          hu,
          w(`${c.uc.nombre} (${c.uc.id})`),
          w(storyDetail(c.uc, c.criterios, c.spec)),
          st.nueva ? 'nueva' : 'Alcance 1',
          { v: 0, s: 'input' },
          { v: 0, s: 'input' },
          { v: 0, s: 'input' },
          { v: 0, s: 'input' },
          { f: `${cellRef(8, row - 1)}+${cellRef(9, row - 1)}+${cellRef(10, row - 1)}+${cellRef(11, row - 1)}`, v: 0, s: 'number' },
          { v: contingency, s: 'percent' },
          { f: `${cellRef(12, row - 1)}*${cellRef(13, row - 1)}`, v: 0, s: 'number' },
          { f: `${cellRef(12, row - 1)}+${cellRef(14, row - 1)}`, v: 0, s: 'number' },
          `${code} · ${change.title}`,
          change.phase,
          mine.length ? `${done} de ${mine.length}` : 'sin plan',
          Math.round(mine.reduce((n, t) => n + taskMinutes(t), 0)),
          priority,
          info?.fecha_objetivo ?? '',
        ]);
      });
    });

    for (const t of plan?.tareas ?? []) {
      const uc = t.criterios.map((k) => ucOfCriterion.get(k)).find(Boolean);
      const run = tasks.get(t.id);
      tareas.push([
        code,
        w(change.title),
        uc ? (huCode.get(uc) ?? uc) : 'Base técnica',
        t.id,
        w(t.titulo),
        t.tipo,
        t.complejidad,
        t.depende_de.join(', '),
        run?.estado ?? 'sin_ejecutar',
        run?.rol ?? '',
        run?.inicio ?? '',
        run?.fin ?? '',
        Math.round(taskMinutes(t)),
      ]);
    }
    for (const e of spec.entidades) {
      for (const f of e.campos) entidades.push([code, w(e.nombre), f.nombre, f.tipo, f.requerido ? 'sí' : 'no', w(f.restriccion ?? ''), w(join(e.invariantes))]);
      if (!e.campos.length) entidades.push([code, w(e.nombre), '', '', '', '', w(join(e.invariantes))]);
    }
  });

  const sheets: Sheet[] = [
    instructions(ini, project, terminos),
    definitions(),
    {
      name: '1. Mapa_Procesos',
      rows: mapa,
      widths: [6, 18, 22, 12, 30, 40, 55, 90, 11],
      freezeRows: 1,
      tables:
        mapa.length > 1
          ? [{ name: 'tb_mapa_procesos', ref: `A1:I${mapa.length}`, columns: ['ID', 'Macroproceso', 'Proceso', 'Código Subproceso', 'Subproceso', 'Objetivo', 'Descripción', 'TO BE', 'Alcance'] }]
          : [],
      validations: mapa.length > 1 ? [{ ref: `I2:I${mapa.length}`, list: '"Alcance 1,Alcance 2,Alcance 3"' }] : [],
    },
    {
      name: '2. DER',
      rows: der,
      widths: [6, 11, 16, 20, 9, 26, 20, 24, 60, 26, 30, 70, 13, 34, 26],
      freezeRows: 4,
      tables:
        der.length > 4
          ? [
              {
                name: 'tb_DER',
                ref: `A4:N${der.length}`,
                columns: [
                  'ID',
                  'Alcance',
                  'Macroproceso',
                  'Proceso',
                  'Código Sub Proces',
                  'Subproceso',
                  'Código épica',
                  'Épicas',
                  'Detalle épica',
                  'Código HU',
                  'Nombre HU',
                  'Detalle HU',
                  'Estado HU',
                  'Observación/Comentario',
                ],
              },
            ]
          : [],
      validations: der.length > 4 ? [{ ref: `M5:M${der.length}`, list: `Lista!$B$9:$B$${8 + ESTADOS.length}`, prompt: 'Elige el estado de la HU' }] : [],
    },
    lista(),
    lookup(mapa.length),
    {
      name: '3. Épicas y HU finales',
      rows: finales,
      widths: [6, 22, 24, 50, 26, 30, 70, 10, 10, 10, 10, 10, 10, 11, 11, 11, 28, 12, 12, 12, 10, 12],
      freezeRows: 2,
      tables:
        finales.length > 2
          ? [
              {
                name: 'Tabla3',
                ref: `A2:V${finales.length}`,
                columns: (finales[1] as { v: string }[]).map((c) => c.v),
              },
            ]
          : [],
    },
    {
      name: '4. Tareas',
      rows: tareas,
      widths: [11, 28, 26, 9, 45, 15, 12, 16, 16, 12, 20, 20, 12],
      freezeRows: 1,
      tables: tareas.length > 1 ? [{ name: 'tb_tareas', ref: `A1:M${tareas.length}`, columns: (tareas[0] as { v: string }[]).map((c) => c.v) }] : [],
    },
    {
      name: 'Entidades',
      rows: entidades,
      widths: [11, 24, 22, 14, 10, 34, 50],
      freezeRows: 1,
      tables: entidades.length > 1 ? [{ name: 'tb_entidades', ref: `A1:G${entidades.length}`, columns: (entidades[0] as { v: string }[]).map((c) => c.v) }] : [],
    },
  ];
  const safeProject = project.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'Proyecto';
  const day = (opts.today ?? new Date().toISOString()).slice(0, 10);
  return { file: `${ini}_${safeProject}_Reqs_${day}.xlsx`, data: buildXlsx(sheets, { title: `${ini} ${project} · Requerimientos`, author: 'Forja' }), sprints: changes.length, stories };
}

function lista(): Sheet {
  const rows: Cell[][] = [
    [],
    [null, { v: 'Catálogo de valores', s: 'title' }],
    [null, { v: 'Valores de la lista desplegable «Estado HU» de la hoja 2. DER. Si agregas un estado, súmalo aquí y amplía la validación.', s: 'muted' }],
    [],
    [],
    [],
    [],
    [null, { v: 'Estado HU', s: 'header' }],
    ...ESTADOS.map((e): Cell[] => [null, e]),
  ];
  return { name: 'Lista', rows, widths: [3, 22] };
}

/** Lookup of one subprocess (the guide's FILTRAR, written with INDEX/MATCH so it works in any Excel). */
function lookup(mapRows: number): Sheet {
  const last = Math.max(mapRows, 2);
  const cols = ['ID', 'Macroproceso', 'Proceso', 'Código Subproceso', 'Subproceso', 'Objetivo', 'Descripción', 'TO BE', 'Alcance'];
  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  return {
    name: 'Consulta_Subproceso',
    rows: [
      [{ v: 'Consulta de un subproceso', s: 'title' }],
      [{ v: 'Elige un subproceso en la celda amarilla: se muestra su fila completa del mapa de procesos.', s: 'muted' }],
      [
        { v: 'Subproceso', s: 'section' },
        { v: '', s: 'input' },
      ],
      [],
      [],
      cols.map((v) => ({ v, s: 'header' as const })),
      letters.map((l) => ({
        f: `IF($B$3="","← Elija un subproceso en la celda amarilla (B3)",IFERROR(INDEX('1. Mapa_Procesos'!$${l}$2:$${l}$${last},MATCH($B$3,'1. Mapa_Procesos'!$E$2:$E$${last},0)),"No se encontró el subproceso"))`,
        s: 'wrap' as const,
      })),
    ],
    widths: [16, 30, 22, 12, 30, 40, 55, 90, 11],
    validations: [{ ref: 'B3', list: `'1. Mapa_Procesos'!$E$2:$E$${last}`, prompt: 'Elige el subproceso' }],
    heights: { 7: 300 },
  };
}

function instructions(ini: string, project: string, terminos: Map<string, string>): Sheet {
  const sections: [string, string[]][] = [
    [
      '1. Objetivo del archivo',
      [
        `Reunir los requerimientos funcionales de ${project} (${ini}) desde la visión del negocio hasta historias de usuario listas para estimar y organizar en sprints. Lo genera Forja con lo que se acordó en cada sprint.`,
      ],
    ],
    [
      '2. Lógica general',
      [
        '1. Mapa_Procesos: un subproceso por sprint de Forja, con su objetivo, descripción, TO BE y alcance.',
        '2. DER: épicas e historias de usuario de cada subproceso con alcance 1, con su estado de revisión.',
        '3. Épicas y HU finales: las HU vigentes (MVP refinado), para estimar en horas y asignar a sprints.',
        '4. Tareas: las tareas que Forja planificó para cada HU, con su estado real.',
        'Entidades: los conceptos de negocio y sus campos (insumo para el modelo de datos, no son tablas).',
      ],
    ],
    [
      '3. Interpretación de 1. Mapa_Procesos',
      [
        'Macroproceso = el proyecto; Proceso = la épica de Forja a la que pertenece el sprint; Subproceso (Pnn) = el sprint.',
        'TO BE = visión funcional del subproceso. Alcance 1 = ya tiene especificación (MVP); Alcance 2 = sólo conversación, falta detallar; Alcance 3 = cancelado o futuro.',
      ],
    ],
    [
      '4. Interpretación de 2. DER',
      [
        'Una fila por HU. La épica agrupa las HU que trabajan sobre la misma entidad principal («Gestión de …»).',
        'Estado HU: Aprobado (sin cambios desde que apareció), Cambiado (se reformuló en una revisión posterior), Descartado (se quitó). Fusionado, Dividido y Postergado los marcas tú al refinar.',
        'Los subprocesos sin especificación aparecen con una sola fila de marcador.',
      ],
    ],
    [
      '5. Interpretación de 3. Épicas y HU finales',
      [
        'Sólo HU vigentes: no entran las descartadas ni las de sprints cancelados. «nueva» = apareció después de la primera especificación.',
        'Las horas (celdas amarillas) las completas tú; el subtotal, la contingencia y el total se calculan solos. «Minutos de agentes» es la estimación de Forja para programarla con IA, como referencia.',
        'Columnas Sprint, Fase, Avance, Prioridad y Fecha objetivo sirven para ordenar y repartir el trabajo en sprints.',
      ],
    ],
    ['6. Regla metodológica principal', ['TO BE = visión completa; Alcance = prioridad de implementación; DER = detalle funcional del alcance 1; HU finales = refinamiento del MVP.']],
    ['7. «Versión inicial», «MVP» y «fases posteriores»', ['Indican priorización, no exclusión: lo que se deja para después sigue siendo parte de la visión.']],
    ['8. Uso para análisis técnico', ['Modelo conceptual completo: a partir del mapa y la hoja Entidades. Modelo lógico de la primera versión: a partir de las HU finales.']],
    [
      '9. Trazabilidad',
      [`Proceso → Subproceso → TO BE → Alcance → Épica → HU → Regla → Criterio de aceptación → Tarea. Códigos: ${ini}_Pnn_Enn_HUnn; entre paréntesis va el id del caso de uso en Forja (UC-…).`],
    ],
    ['10. Conceptos del dominio que no deben fusionarse', terminos.size ? [...terminos].map(([t, d]) => `${t}: ${d}`) : ['Todavía no hay términos definidos en las especificaciones.']],
    [
      '11. Precauciones para herramientas de IA',
      [
        'No leer sólo las HU finales: el mapa y el TO BE dan la visión completa.',
        'No asumir que el DER es todo el sistema: sólo descompone el alcance 1.',
        'No convertir cada HU en una tabla: las HU son capacidades; las entidades están en su hoja.',
      ],
    ],
    ['12. Nota de uso', ['Documento vivo: se vuelve a generar desde Forja cuando cambian los sprints. Lo que edites a mano (horas, estados de refinamiento) conviene copiarlo a la nueva versión.']],
  ];
  const rows: Cell[][] = [[null, { v: `${ini} · ${project} · Requerimientos funcionales`, s: 'title' }], []];
  for (const [title, lines] of sections) {
    rows.push([null, { v: title, s: 'section' }]);
    for (const l of lines) rows.push([null, { v: l, s: 'wrap' }]);
    rows.push([]);
  }
  return { name: '0. Instrucciones', rows, widths: [3, 140] };
}

function definitions(): Sheet {
  const items: [string, string, string][] = [
    ['Macroproceso', 'Agrupación de más alto nivel: un bloque de gestión de la cadena de valor.', 'Ventas'],
    ['Proceso', 'Conjunto de actividades con inicio, fin, responsable, entradas, salidas, cliente, riesgos, controles e indicadores.', 'Gestión comercial'],
    ['Subproceso', 'Etapa lógica de un proceso: un bloque manejable, documentable y medible. En Forja, un sprint.', 'Cotizaciones'],
    ['Actividad', 'Acción concreta de un rol o del sistema; verbo en infinitivo.', 'Registrar la cotización'],
    ['TO BE', 'Escenario objetivo: qué soporta el sistema, sus reglas, excepciones y qué queda fuera. Sin llegar a especificación técnica ni lista de pantallas.', 'El sistema debe permitir…'],
    ['Épica', 'Capacidad funcional que agrupa HU. No es tarea técnica, pantalla, botón, tabla ni API. Nombre breve y entendible por el negocio.', 'Gestión de cotizaciones'],
    ['Épica detallada', 'Siete partes: Objetivo funcional, Alcance incluido, Reglas principales, Entidades requeridas, Dependencias, Fuera de alcance, Resultado esperado.', 'Objetivo funcional: …'],
    ['Historia de usuario', '«Como [rol], quiero [acción], para [beneficio]». Un nivel debajo de la épica: ni toda la épica ni un campo o botón.', 'Como vendedor, quiero…'],
    [
      'HU detallada',
      'Como/quiero/para + Detalle funcional + Reglas principales + Criterios de aceptación (dado/cuando/entonces, al menos uno positivo y uno negativo) + Excepciones.',
      'Criterios de aceptación: dado…, cuando…, entonces…',
    ],
  ];
  const rows: Cell[][] = [
    [null, { v: 'Definiciones', s: 'title' }],
    [],
    [null, { v: 'Dato', s: 'header' }, { v: 'Descripción', s: 'header' }, ...Array(10).fill({ v: '', s: 'header' }), { v: 'Ejemplo', s: 'header' }],
  ];
  const merges = ['C3:M3'];
  items.forEach(([dato, desc, ex], i) => {
    const r = i + 4;
    rows.push([null, { v: dato, s: 'section' }, { v: desc, s: 'wrap' }, ...Array(10).fill(null), { v: ex, s: 'wrap' }]);
    merges.push(`C${r}:M${r}`);
  });
  return { name: 'Definiciones', rows, widths: [3, 20, ...Array(11).fill(9), 34], merges, heights: Object.fromEntries(items.map((_, i) => [i + 4, 45])) };
}
