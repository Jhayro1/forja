import { git } from '../git/git.js';
import type { Plan } from '../plan/plan.js';
import type { TaskRow } from '../store/projections.js';
import type { ExecRow } from './records.js';

/**
 * What the other agents of the run are doing (v3/PLAN.md §4.8), for the context of the
 * next launch: who works now and on which files, what the finished tasks changed and
 * export, and who will use this task's result. Deterministic: same run state → same text.
 */
export type TeamLedger = {
  nota: string;
  trabajando_ahora: { tarea: string; titulo: string; objetivo: string; archivos_reservados: string[] }[];
  terminadas: { tarea: string; titulo: string; archivos: string[]; exporta: string[]; resumen: string | null }[];
  dependen_de_ti: { tarea: string; titulo: string }[];
};

const IN_FLIGHT = new Set(['reservada', 'ejecutando', 'verificando', 'verificada', 'integrando']);
const MAX_DONE = 15;
const MAX_EXPORTS = 20;

/** Public names an added line declares (TS/JS, Python, Go, Rust): what the next tasks can reuse. */
const DECLARATIONS = [
  /^\+\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\+def\s+([A-Za-z_]\w*)\s*\(/,
  /^\+class\s+([A-Za-z_]\w*)/,
  /^\+func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*\(/,
  /^\+pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_]\w*)/,
];

export function declaredNames(diff: string): string[] {
  const names: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++')) continue;
    for (const re of DECLARATIONS) {
      const m = re.exec(line);
      if (m?.[1] && !names.includes(m[1])) names.push(m[1]);
    }
  }
  return names;
}

export type LedgerInput = {
  plan: Plan;
  tasks: TaskRow[];
  exec: (taskId: string) => ExecRow;
  /** Names a finished task exports (cached by the caller: an integrated diff never changes). */
  exportsOf: (exec: ExecRow) => Promise<string[]>;
};

export async function buildTeamLedger(input: LedgerInput, taskId: string): Promise<TeamLedger | null> {
  const def = (id: string) => input.plan.tareas.find((t) => t.id === id);
  const others = input.tasks.filter((t) => t.task_id !== taskId);
  const trabajando_ahora = others
    .filter((t) => IN_FLIGHT.has(t.state))
    .map((t) => ({ tarea: t.task_id, titulo: t.title, objetivo: def(t.task_id)?.objetivo ?? '', archivos_reservados: def(t.task_id)?.escribe ?? [] }));
  const done = others
    .filter((t) => t.state === 'integrada')
    .sort((a, b) => b.updated_seq - a.updated_seq)
    .slice(0, MAX_DONE);
  const terminadas: TeamLedger['terminadas'] = [];
  for (const t of done) {
    const e = input.exec(t.task_id);
    let files: string[] = [];
    try {
      files = e.files ? (JSON.parse(e.files) as string[]) : [];
    } catch {
      files = [];
    }
    terminadas.push({ tarea: t.task_id, titulo: t.title, archivos: files.slice(0, 30), exporta: (await input.exportsOf(e)).slice(0, MAX_EXPORTS), resumen: e.summary });
  }
  const dependen_de_ti = input.plan.tareas.filter((t) => t.depende_de.includes(taskId)).map((t) => ({ tarea: t.id, titulo: t.titulo }));
  if (!trabajando_ahora.length && !terminadas.length && !dependen_de_ti.length) return null;
  return {
    nota: 'Otras tareas de este mismo trabajo. Reutiliza lo que ya hicieron las terminadas en vez de reescribirlo, no dependas del contenido actual de los archivos reservados por otra tarea en curso, y respeta lo que esperan las tareas que dependen de ti.',
    trabajando_ahora,
    terminadas,
    dependen_de_ti,
  };
}

/** Exported names of a finished task, read from its candidate diff (null-safe, cached per commit). */
export function exportsReader(repoPath: string): (exec: ExecRow) => Promise<string[]> {
  const cache = new Map<string, string[]>();
  return async (e) => {
    if (!e.base_sha || !e.candidate_sha || e.base_sha === e.candidate_sha) return [];
    const key = `${e.base_sha}..${e.candidate_sha}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const r = await git(repoPath, ['diff', '--unified=0', '--no-color', key]).catch(() => null);
    const names = r ? declaredNames(r.stdout) : [];
    cache.set(key, names);
    return names;
  };
}

/** The line the worker ends with (`RESUMEN: …`), or its last paragraph: what now works thanks to the change. */
export function extractSummary(text: string | null): string | null {
  if (!text) return null;
  const tagged = [...text.matchAll(/^\s*RESUMEN:\s*(.+)$/gm)].at(-1)?.[1];
  const raw =
    tagged ??
    text
      .trim()
      .split(/\n\s*\n/)
      .at(-1) ??
    '';
  const clean = raw.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 400) : null;
}
