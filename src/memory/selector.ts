import { matchesGlob } from 'node:path';
import type { Plan, PlanTask } from '../plan/plan.js';
import { acceptanceFilesFor } from '../verify/verify.js';
import { fileId } from './build.js';
import type { Confidence, GraphStore } from './graph-store.js';

/**
 * Context selectors (V2-061). The simple one is the MVP rule (files the task
 * declares it reads + its acceptance tests). The graph one starts from the
 * same seeds and adds, with a reason for each file: tests that verify its
 * criteria, what the seeds import, files written by the tasks it depends on,
 * dependents of what it will change and files that mention its use cases.
 * Mandatory spec content (criteria, rules, decisions) is handled by the
 * context builder and is never subject to this ranking.
 */

export type SelectedFile = { path: string; reason: string; score: number; confidence: Confidence };

const matching = (tree: string[], globs: string[]) => tree.filter((f) => globs.some((g) => f === g || matchesGlob(f, g)));

export function simpleSelection(task: PlanTask, plan: Plan, tree: string[]): SelectedFile[] {
  const globs = [...task.lee, ...(task.tipo === 'implementacion' ? acceptanceFilesFor(plan, task) : [])];
  return matching(tree, globs).map((path) => ({ path, reason: 'declarado por la tarea', score: 100, confidence: 'seguro' }));
}

export function graphSelection(graph: GraphStore, task: PlanTask, plan: Plan, tree: string[], opts: { maxFiles?: number } = {}): SelectedFile[] {
  const inTree = new Set(tree);
  const picked = new Map<string, SelectedFile>();
  const offer = (path: string, score: number, reason: string, confidence: Confidence) => {
    if (!inTree.has(path)) return;
    const s = confidence === 'posible' ? Math.round(score * 0.6) : score;
    const cur = picked.get(path);
    if (!cur || cur.score < s) picked.set(path, { path, reason, score: s, confidence });
  };
  const pathOf = (id: string) => (id.startsWith('archivo:') ? id.slice('archivo:'.length) : null);

  for (const f of simpleSelection(task, plan, tree)) offer(f.path, 100, f.reason, 'seguro');
  const writes = matching(tree, task.escribe);
  for (const f of writes) offer(f, 95, 'la tarea lo modifica', 'seguro');

  // Tests that verify this task's criteria.
  for (const c of task.criterios) {
    for (const e of graph.in(`criterio:${c}`, ['verifica'])) {
      const p = pathOf(e.src);
      if (p) offer(p, 90, `prueba que verifica ${c}`, e.confidence);
    }
  }
  // Files written by the tasks this one depends on (their contracts are what it builds on).
  for (const d of task.depende_de) {
    for (const e of graph.out(`tarea:${d}`, ['afecta'])) {
      const p = pathOf(e.dst);
      if (p) offer(p, 80, `escrito por ${d}, del que depende`, 'seguro');
    }
  }
  // What the seeds import (depth 2), and who imports what the task will change (breakage risk).
  const seeds = [...picked.keys()];
  const visited = new Set<string>(seeds);
  let frontier = seeds;
  for (let depth = 1; depth <= 2; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const e of graph.out(fileId(f), ['importa'])) {
        const p = pathOf(e.dst);
        if (!p || visited.has(p)) continue;
        visited.add(p);
        next.push(p);
        offer(p, depth === 1 ? 70 : 45, `${f} lo importa${depth === 2 ? ' (indirecto)' : ''}`, e.confidence);
      }
    }
    frontier = next;
  }
  for (const f of writes) {
    for (const e of graph.in(fileId(f), ['importa'])) {
      const p = pathOf(e.src);
      if (p) offer(p, 55, `importa ${f}, que la tarea cambia`, e.confidence);
    }
  }
  // Files that mention the task's use cases or rules.
  const ucs = new Set(task.criterios.map((c) => `caso_uso:${c.slice(3, 9)}`));
  for (const uc of ucs) {
    for (const e of graph.in(uc, ['menciona'])) {
      const p = pathOf(e.src);
      if (p) offer(p, 40, `menciona ${uc.slice('caso_uso:'.length)}`, e.confidence);
    }
  }
  return [...picked.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, opts.maxFiles ?? 15);
}
