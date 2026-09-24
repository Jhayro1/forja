import { existsSync, readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { git } from '../../git/git.js';
import { buildGraph } from '../../memory/build.js';
import { type EvalCase, evaluateSelectors } from '../../memory/evaluate.js';
import { GraphStore } from '../../memory/graph-store.js';
import { LessonError, LessonService } from '../../memory/lessons.js';
import { graphSelection, simpleSelection } from '../../memory/selector.js';
import { latestPlan } from '../../plan/divide.js';
import type { Plan } from '../../plan/plan.js';
import { writeConfig } from '../../registry/config.js';
import { filesReadBy } from '../../run/activity.js';
import { currentChange } from '../../run/snapshot.js';
import { launchDir } from '../../runtime/launcher.js';
import { latestSpec } from '../../spec/generate.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { type EngineContext, openEngine } from '../engine-context.js';

function currentPlan(ctx: EngineContext): Plan {
  const change = currentChange(ctx.engine);
  const plan = change ? latestPlan(ctx.engine, change.change_id)?.plan : undefined;
  if (!plan) throw new CliError('todavía no hay plan: la memoria de tareas necesita forja dividir', EXIT.precondition);
  return plan;
}

async function build(ctx: EngineContext, graph: GraphStore) {
  const change = currentChange(ctx.engine);
  return buildGraph(graph, {
    repoPath: ctx.checkout.path,
    spec: change ? (latestSpec(ctx.engine, change.change_id)?.spec ?? null) : null,
    plan: change ? (latestPlan(ctx.engine, change.change_id)?.plan ?? null) : null,
  });
}

const tree = async (path: string) => (await git(path, ['ls-files'])).stdout.split('\n').filter(Boolean);

/** Real needs from history: files agents opened by themselves in each task's launches. */
function historyCases(ctx: EngineContext, plan: Plan, files: string[]): EvalCase[] {
  const rows = ctx.store.db.prepare("SELECT task_id, launch_id, provider FROM usage WHERE task_id IS NOT NULL AND role IN ('trabajador', 'complejo')").all() as {
    task_id: string;
    launch_id: string;
    provider: string;
  }[];
  const byTask = new Map<string, Set<string>>();
  for (const r of rows) {
    const dir = launchDir(ctx.dataDir, r.launch_id);
    if (!existsSync(dir)) continue;
    const set = byTask.get(r.task_id) ?? new Set<string>();
    for (const f of filesReadBy(dir, r.provider, files)) set.add(f);
    byTask.set(r.task_id, set);
  }
  return plan.tareas.filter((t) => byTask.has(t.id)).map((t) => ({ task: t, needed: [...byTask.get(t.id)!].sort(), source: 'historial: archivos que el agente leyó por su cuenta' }));
}

export function registerMemoryCommands(program: Command): void {
  const memoria = program.command('memoria').description('grafo de conocimiento del proyecto (índice reconstruible) y lecciones revisadas');

  memoria
    .command('construir')
    .description('analiza el repositorio y la especificación (incremental: sólo reanaliza lo que cambió)')
    .option('--desde-cero', 'borra el índice y lo reconstruye')
    .action(async (o: { desdeCero?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      if (o.desdeCero) GraphStore.reset(ctx.dataDir);
      const graph = GraphStore.open(ctx.dataDir);
      try {
        const r = await build(ctx, graph);
        const stats = graph.stats();
        if (g.json) return printJson({ construccion: r, grafo: stats });
        print(`✔ ${r.archivos} archivos: ${r.analizados} analizados, ${r.reutilizados} sin cambios, ${r.eliminados} eliminados del índice, ${r.excluidos} excluidos (secretos, binarios, generados)`);
        print(
          `  Nodos: ${
            Object.entries(stats.nodos)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ') || 'ninguno'
          }`,
        );
        print(
          `  Aristas: ${
            Object.entries(stats.aristas)
              .map(([k, v]) => `${k} ${v}`)
              .join(' · ') || 'ninguna'
          } (${stats.posibles} «posibles»: inferidas, no demostradas)`,
        );
        if (r.sin_resolver.length)
          print(
            `  ! ${r.sin_resolver.length} import(s) sin resolver (alias o rutas que no existen), p. ej. ${r.sin_resolver
              .slice(0, 3)
              .map((x) => `${x.archivo} → ${x.importa}`)
              .join('; ')}`,
          );
        for (const l of r.limitaciones.slice(0, 8)) print(`  ! ${l.archivo}: ${l.nota}`);
        print('  Limitaciones del análisis: sintáctico; no sigue llamadas entre funciones ni imports dinámicos. La ausencia de una arista no prueba ausencia de impacto.');
      } finally {
        graph.close();
        ctx.close();
      }
    });

  memoria
    .command('buscar <texto>')
    .description('busca nodos (ids, archivos, símbolos, casos de uso…) y muestra sus relaciones')
    .action((text: string, _o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      const graph = GraphStore.open(ctx.dataDir);
      try {
        const nodes = graph.search(text);
        if (g.json) return printJson({ nodos: nodes.map((n) => ({ ...n, salen: graph.out(n.id), entran: graph.in(n.id) })) });
        if (!nodes.length) return print('Sin resultados (¿construiste el índice? forja memoria construir)');
        for (const n of nodes) {
          print(`${n.id}  (${n.kind}) ${n.label.slice(0, 80)}`);
          for (const e of graph.out(n.id).slice(0, 8)) print(`    → ${e.kind} ${e.dst}${e.confidence === 'posible' ? ' (posible)' : ''}`);
          for (const e of graph.in(n.id).slice(0, 8)) print(`    ← ${e.kind} ${e.src}${e.confidence === 'posible' ? ' (posible)' : ''}`);
        }
      } finally {
        graph.close();
        ctx.close();
      }
    });

  memoria
    .command('contexto <tarea>')
    .description('explica qué archivos recibiría una tarea con cada selector y por qué')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      const graph = GraphStore.open(ctx.dataDir);
      try {
        const plan = currentPlan(ctx);
        const task = plan.tareas.find((t) => t.id === id.toUpperCase());
        if (!task) throw new CliError(`no existe la tarea ${id} en el plan`, EXIT.input);
        await build(ctx, graph);
        const files = await tree(ctx.checkout.path);
        const simple = simpleSelection(task, plan, files);
        const grafo = graphSelection(graph, task, plan, files, { maxFiles: ctx.config.contexto.max_archivos });
        if (g.json) return printJson({ tarea: task.id, modo: ctx.config.contexto.modo, simple, grafo });
        print(`${task.id} · ${task.titulo} (modo actual: ${ctx.config.contexto.modo})`);
        print('Siempre incluidos (no se recortan): criterios, reglas de sus casos de uso, decisiones aprobadas y lecciones aprobadas.');
        print(`\nSelector simple (${simple.length}):`);
        for (const f of simple) print(`  ${f.path}`);
        print(`\nSelector de grafo (${grafo.length}):`);
        for (const f of grafo) print(`  ${f.path.padEnd(40)} ${f.reason}${f.confidence === 'posible' ? ' (posible)' : ''}`);
      } finally {
        graph.close();
        ctx.close();
      }
    });

  memoria
    .command('evaluar')
    .description('compara el selector de grafo con el simple (historial real o un corpus etiquetado)')
    .option('--corpus <archivo>', 'JSON { casos: [{ tarea, necesarios: [archivos] }] } sobre el plan actual')
    .option('--aplicar', 'si el grafo gana, activa contexto.modo = grafo en forja.yaml')
    .action(async (o: { corpus?: string; aplicar?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      const graph = GraphStore.open(ctx.dataDir);
      try {
        const plan = currentPlan(ctx);
        await build(ctx, graph);
        const files = await tree(ctx.checkout.path);
        let cases: EvalCase[];
        if (o.corpus) {
          const raw = JSON.parse(readFileSync(o.corpus, 'utf8')) as { casos: { tarea: string; necesarios: string[] }[] };
          cases = raw.casos.map((c) => {
            const task = plan.tareas.find((t) => t.id === c.tarea);
            if (!task) throw new CliError(`el corpus nombra ${c.tarea}, que no está en el plan`);
            return { task, needed: c.necesarios, source: 'corpus etiquetado' };
          });
        } else cases = historyCases(ctx, plan, files);
        const r = evaluateSelectors(graph, plan, files, cases);
        let applied = false;
        if (o.aplicar && r.recomendacion === 'grafo') {
          writeConfig(ctx.checkout.path, { ...ctx.config, contexto: { ...ctx.config.contexto, modo: 'grafo' } });
          applied = true;
        }
        if (g.json) return printJson({ evaluacion: r, aplicado: applied });
        print(
          `Casos: ${r.casos} · simple: ${r.simple.recall === null ? '—' : `${Math.round(r.simple.recall * 100)}%`} de lo necesario con ${r.simple.archivos_promedio} archivos · grafo: ${r.grafo.recall === null ? '—' : `${Math.round(r.grafo.recall * 100)}%`} con ${r.grafo.archivos_promedio}`,
        );
        print(`Recomendación: ${r.recomendacion} — ${r.motivo}`);
        if (applied) print('✔ contexto.modo = grafo en forja.yaml');
      } finally {
        graph.close();
        ctx.close();
      }
    });

  memoria
    .command('lecciones')
    .description('lecciones propuestas y revisadas')
    .option('--todas', 'incluye aprobadas y rechazadas')
    .action((o: { todas?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const list = new LessonService(ctx.store).list(o.todas ? undefined : 'propuesta');
        if (g.json) return printJson({ lecciones: list });
        if (!list.length) return print(o.todas ? 'No hay lecciones.' : 'No hay lecciones por revisar.');
        for (const l of list) {
          print(`${l.lesson_id} · ${l.state}${l.reviewed_by ? ` por ${l.reviewed_by}` : ''}`);
          print(`  ${l.text}`);
          print(`  evidencia: ${JSON.stringify(l.evidence)}`);
        }
      } finally {
        ctx.close();
      }
    });

  for (const [verb, approve] of [
    ['aprobar', true],
    ['rechazar', false],
  ] as const) {
    memoria
      .command(`${verb} <leccion>`)
      .description(approve ? 'aprueba una lección: pasará al contexto de tareas de su ámbito (nunca a la política)' : 'rechaza una lección')
      .option('--nota <texto>', 'motivo', '')
      .action((id: string, o: { nota: string }, cmd: Command) => {
        const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
        try {
          const l = new LessonService(ctx.store).review(id, approve, 'cli', o.nota);
          print(`✔ ${l.lesson_id} ${l.state}`);
        } catch (error) {
          if (error instanceof LessonError) throw new CliError(error.message, EXIT.precondition);
          throw error;
        } finally {
          ctx.close();
        }
      });
  }
}
