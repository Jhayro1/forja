import { git } from '../../git/git.js';
import { buildGraph } from '../../memory/build.js';
import { GraphStore } from '../../memory/graph-store.js';
import { graphSelection } from '../../memory/selector.js';
import type { PlanTask } from '../../plan/plan.js';
import type { RunContext } from './run-context.js';

export type RelatedFile = { path: string; reason: string };

/**
 * Graph-selected files for a task (contexto.modo = grafo). The graph is updated
 * incrementally from THIS task's worktree and queried under the same lock, so
 * the selection matches the code the agent will see. Any failure falls back to
 * the simple selector: the graph improves context, it never blocks a launch.
 */
export class GraphContext {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: RunContext) {}

  relatedFiles(task: PlanTask, worktree: string): Promise<RelatedFile[]> {
    const { engine, spec, plan } = this.ctx;
    if (engine.config.contexto.modo !== 'grafo') return Promise.resolve([]);
    const work = this.lock.then(async () => {
      const graph = GraphStore.open(engine.dataDir);
      try {
        await buildGraph(graph, { repoPath: worktree, spec, plan });
        const tree = (await git(worktree, ['ls-files'])).stdout.split('\n').filter(Boolean);
        return graphSelection(graph, task, plan, tree, { maxFiles: engine.config.contexto.max_archivos }).map((f) => ({ path: f.path, reason: `${f.reason}${f.confidence === 'posible' ? ' (posible)' : ''}` }));
      } finally {
        graph.close();
      }
    });
    this.lock = work.catch(() => undefined);
    return work.catch((error: Error) => {
      this.ctx.log(`⚠ ${task.id}: sin contexto del grafo (${error.message}); se usa el selector simple`);
      return [];
    });
  }
}
