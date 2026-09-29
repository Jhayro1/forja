import type { Engine } from '../core/engine.js';
import type { TaskState } from '../domain/task-state.js';
import { latestPlan } from '../plan/divide.js';
import type { Plan } from '../plan/plan.js';
import { listChanges } from '../planner/session.js';
import { runsOf } from '../run/records.js';
import { latestSpec } from '../spec/generate.js';
import type { Spec } from '../spec/spec.js';
import { listTasks } from '../store/projections.js';
import { EpicService } from './epics.js';

/**
 * The whole project's work as a checklist and a calendar (v3/PLAN.md §6.3 «Historial»):
 * Épica → Sprint → Historia → Tarea. Dates come from the events: facts, not plans.
 */
export type CheckState = 'unida' | 'en_curso' | 'pendiente' | 'bloqueada' | 'cancelada';

export type HistoryTask = {
  id: string;
  titulo: string;
  estado: TaskState | 'sin_ejecutar';
  marca: CheckState;
  rol: string | null;
  cuenta: string | null;
  inicio: string | null;
  fin: string | null;
  intentos: number;
  resumen: string | null;
};
export type HistoryStory = { id: string; titulo: string; tareas: HistoryTask[]; hechas: number; total: number };
export type HistorySprint = {
  id: string;
  titulo: string;
  fase: string;
  creado: string;
  entregado: string | null;
  prioridad: number;
  fecha_objetivo: string | null;
  retrasado: boolean;
  historias: HistoryStory[];
  hechas: number;
  total: number;
};
export type HistoryEpic = { id: string | null; titulo: string; objetivo: string; estado: string; fecha_objetivo: string | null; sprints: HistorySprint[]; hechas: number; total: number };
export type CalendarEvent = { fecha: string; tipo: 'sprint_creado' | 'sprint_entregado' | 'tarea_iniciada' | 'tarea_unida' | 'tarea_bloqueada'; sprint: string; tarea: string | null; titulo: string };
export type History = { epicas: HistoryEpic[]; calendario: CalendarEvent[] };

const mark = (s: TaskState | 'sin_ejecutar'): CheckState => {
  if (s === 'integrada') return 'unida';
  if (s === 'cancelada' || s === 'invalidada') return 'cancelada';
  if (s === 'bloqueada' || s === 'esperando_respuesta' || s === 'pausada') return 'bloqueada';
  if (s === 'pendiente' || s === 'lista' || s === 'sin_ejecutar') return 'pendiente';
  return 'en_curso';
};

/** Tasks grouped by the use case their criteria belong to; the rest are «Base técnica». */
function stories(plan: Plan, spec: Spec | null, tasks: HistoryTask[]): HistoryStory[] {
  const ucOf = new Map((spec?.criterios ?? []).map((c) => [c.id, c.caso_uso_id]));
  const ucName = new Map((spec?.casos_uso ?? []).map((u) => [u.id, u.nombre]));
  const groups = new Map<string, HistoryTask[]>();
  for (const t of tasks) {
    const def = plan.tareas.find((x) => x.id === t.id);
    const uc = def?.criterios.map((c) => ucOf.get(c)).find(Boolean) ?? 'base';
    groups.set(uc, [...(groups.get(uc) ?? []), t]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === 'base' ? -1 : b === 'base' ? 1 : a.localeCompare(b)))
    .map(([id, list]) => ({
      id,
      titulo: id === 'base' ? 'Base técnica (sin caso de uso)' : `${id} ${ucName.get(id) ?? ''}`.trim(),
      tareas: list,
      hechas: list.filter((t) => t.marca === 'unida').length,
      total: list.filter((t) => t.marca !== 'cancelada').length,
    }));
}

export function buildHistory(engine: Engine, today = new Date().toISOString().slice(0, 10)): History {
  const db = engine.store.db;
  const epics = new EpicService(engine);
  const links = new Map(epics.links().map((l) => [l.change_id, l]));
  const calendario: CalendarEvent[] = [];

  // Transitions of every task, once: start (ejecutando), end (integrada), blocks.
  const moves = db.prepare("SELECT run_id, task_id, payload, occurred_at FROM events WHERE type = 'tarea.estado_cambiado' ORDER BY seq").all() as {
    run_id: string;
    task_id: string;
    payload: string;
    occurred_at: string;
  }[];
  const times = new Map<string, { inicio: string | null; fin: string | null; bloqueos: string[] }>();
  for (const m of moves) {
    const to = (JSON.parse(m.payload) as { to: string }).to;
    const k = `${m.run_id}/${m.task_id}`;
    const t = times.get(k) ?? { inicio: null, fin: null, bloqueos: [] };
    if (to === 'ejecutando' && !t.inicio) t.inicio = m.occurred_at;
    if (to === 'integrada') t.fin = m.occurred_at;
    if (to === 'bloqueada') t.bloqueos.push(m.occurred_at);
    times.set(k, t);
  }
  const delivered = new Map(
    (
      db.prepare("SELECT aggregate_id, payload, occurred_at FROM events WHERE type = 'cambio.fase_cambiada' ORDER BY seq").all() as {
        aggregate_id: string;
        payload: string;
        occurred_at: string;
      }[]
    )
      .filter((e) => (JSON.parse(e.payload) as { to: string }).to === 'entregado')
      .map((e) => [e.aggregate_id, e.occurred_at]),
  );

  const sprints: (HistorySprint & { epic: string | null })[] = listChanges(engine)
    .slice()
    .reverse()
    .map((c) => {
      const link = links.get(c.change_id);
      const plan = latestPlan(engine, c.change_id)?.plan ?? null;
      const spec = latestSpec(engine, c.change_id)?.spec ?? null;
      const run = runsOf(engine, c.change_id)[0] ?? null;
      const rows = run ? new Map(listTasks(db, run.run_id).map((t) => [t.task_id, t])) : new Map();
      const execs = run
        ? new Map(
            (
              db.prepare('SELECT task_id, level, account, attempt, summary FROM task_exec WHERE run_id = ?').all(run.run_id) as {
                task_id: string;
                level: string | null;
                account: string | null;
                attempt: number;
                summary: string | null;
              }[]
            ).map((e) => [e.task_id, e]),
          )
        : new Map();
      const tasks: HistoryTask[] = (plan?.tareas ?? []).map((d) => {
        const row = rows.get(d.id);
        const estado = (row?.state as TaskState | undefined) ?? 'sin_ejecutar';
        const t = run ? times.get(`${run.run_id}/${d.id}`) : undefined;
        const e = execs.get(d.id);
        if (t?.inicio) calendario.push({ fecha: t.inicio, tipo: 'tarea_iniciada', sprint: c.change_id, tarea: d.id, titulo: d.titulo });
        if (t?.fin) calendario.push({ fecha: t.fin, tipo: 'tarea_unida', sprint: c.change_id, tarea: d.id, titulo: d.titulo });
        for (const b of t?.bloqueos ?? []) calendario.push({ fecha: b, tipo: 'tarea_bloqueada', sprint: c.change_id, tarea: d.id, titulo: d.titulo });
        return {
          id: d.id,
          titulo: d.titulo,
          estado,
          marca: mark(estado),
          rol: e?.level ?? null,
          cuenta: e?.account ?? null,
          inicio: t?.inicio ?? null,
          fin: t?.fin ?? null,
          intentos: e?.attempt ?? 0,
          resumen: e?.summary ?? null,
        };
      });
      calendario.push({ fecha: c.created_at, tipo: 'sprint_creado', sprint: c.change_id, tarea: null, titulo: c.title });
      const entregado = delivered.get(c.change_id) ?? null;
      if (entregado) calendario.push({ fecha: entregado, tipo: 'sprint_entregado', sprint: c.change_id, tarea: null, titulo: c.title });
      const target = link?.target_date ?? null;
      const live = tasks.filter((t) => t.marca !== 'cancelada');
      return {
        epic: link?.epic_id ?? null,
        id: c.change_id,
        titulo: c.title,
        fase: c.phase,
        creado: c.created_at,
        entregado,
        prioridad: link?.priority ?? 0,
        fecha_objetivo: target,
        // Late means past its target and not delivered: the date is never moved to hide it.
        retrasado: Boolean(target && !entregado && c.phase !== 'cancelado' && target < today),
        historias: plan ? stories(plan, spec, tasks) : [],
        hechas: live.filter((t) => t.marca === 'unida').length,
        total: live.length,
      };
    });

  const group = (id: string | null): HistorySprint[] =>
    sprints
      .filter((s) => s.epic === id)
      .sort((a, b) => b.prioridad - a.prioridad || a.creado.localeCompare(b.creado))
      .map(({ epic: _epic, ...s }) => s);
  const epicas: HistoryEpic[] = epics.list().map((e) => {
    const list = group(e.epic_id);
    return {
      id: e.epic_id,
      titulo: e.title,
      objetivo: e.goal,
      estado: e.state,
      fecha_objetivo: e.target_date,
      sprints: list,
      hechas: list.reduce((n, s) => n + s.hechas, 0),
      total: list.reduce((n, s) => n + s.total, 0),
    };
  });
  const loose = group(null);
  if (loose.length)
    epicas.push({
      id: null,
      titulo: 'Sin épica',
      objetivo: 'Sprints que todavía no pertenecen a ninguna épica.',
      estado: 'abierta',
      fecha_objetivo: null,
      sprints: loose,
      hechas: loose.reduce((n, s) => n + s.hechas, 0),
      total: loose.reduce((n, s) => n + s.total, 0),
    });
  calendario.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return { epicas, calendario };
}

/** The checklist as Markdown, to share or paste in a document. */
export function historyMarkdown(h: History): string {
  const box = { unida: '[x]', en_curso: '[~]', pendiente: '[ ]', bloqueada: '[!]', cancelada: '[-]' } as const;
  const out: string[] = ['# Historial del proyecto', ''];
  for (const e of h.epicas) {
    out.push(`## ${e.titulo} (${e.hechas}/${e.total})`, '');
    if (e.objetivo) out.push(e.objetivo, '');
    for (const s of e.sprints) {
      out.push(`### Sprint: ${s.titulo} — ${s.fase} (${s.hechas}/${s.total})${s.retrasado ? ' · RETRASADO' : ''}`, '');
      for (const st of s.historias) {
        out.push(`- **${st.titulo}** (${st.hechas}/${st.total})`);
        for (const t of st.tareas) out.push(`  - ${box[t.marca]} ${t.id} ${t.titulo}${t.resumen ? ` — ${t.resumen}` : ''}`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}
