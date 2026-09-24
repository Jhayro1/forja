import type { Plan, PlanTask } from '../plan/plan.js';
import type { GraphStore } from './graph-store.js';
import { graphSelection, simpleSelection } from './selector.js';

/**
 * Selector evaluation (V2-061 · «mejora medida frente al selector simple»).
 * Recall: share of the files a task really needed that the selector offered.
 * Size: how many files it offered (more files = more tokens). The graph is
 * only worth enabling if it raises recall without bloating the package.
 */
export type EvalCase = { task: PlanTask; needed: string[]; source: string };
export type SelectorScore = { recall: number | null; archivos_promedio: number; aciertos: number; necesarios: number };
export type EvalReport = { casos: number; simple: SelectorScore; grafo: SelectorScore; por_caso: { tarea: string; fuente: string; necesarios: string[]; simple: string[]; grafo: string[] }[]; recomendacion: 'grafo' | 'simple' | 'sin_datos'; motivo: string };

function score(selected: string[][], needed: string[][]): SelectorScore {
  let hits = 0;
  let total = 0;
  for (let i = 0; i < needed.length; i++) {
    const s = new Set(selected[i]);
    total += needed[i]!.length;
    hits += needed[i]!.filter((f) => s.has(f)).length;
  }
  return { recall: total ? Math.round((hits / total) * 100) / 100 : null, archivos_promedio: selected.length ? Math.round((selected.reduce((a, x) => a + x.length, 0) / selected.length) * 10) / 10 : 0, aciertos: hits, necesarios: total };
}

export function evaluateSelectors(graph: GraphStore, plan: Plan, tree: string[], cases: EvalCase[]): EvalReport {
  const useful = cases.filter((c) => c.needed.length > 0);
  const simple = useful.map((c) => simpleSelection(c.task, plan, tree).map((f) => f.path));
  const grafo = useful.map((c) => graphSelection(graph, c.task, plan, tree).map((f) => f.path));
  const needed = useful.map((c) => c.needed);
  const s = score(simple, needed);
  const g = score(grafo, needed);
  let recomendacion: EvalReport['recomendacion'] = 'sin_datos';
  let motivo = 'no hay casos con archivos necesarios conocidos: corre tareas y vuelve a evaluar';
  if (useful.length && s.recall !== null && g.recall !== null) {
    const better = g.recall > s.recall;
    recomendacion = better ? 'grafo' : 'simple';
    motivo = better
      ? `el grafo encuentra ${Math.round(g.recall * 100)}% de lo necesario frente a ${Math.round(s.recall * 100)}% (con ${g.archivos_promedio} archivos por tarea frente a ${s.archivos_promedio})`
      : `el grafo no mejora al selector simple en estos casos (${Math.round(g.recall * 100)}% frente a ${Math.round(s.recall * 100)}%)`;
  }
  return {
    casos: useful.length,
    simple: s,
    grafo: g,
    por_caso: useful.map((c, i) => ({ tarea: c.task.id, fuente: c.source, necesarios: c.needed, simple: simple[i]!, grafo: grafo[i]! })),
    recomendacion,
    motivo,
  };
}
