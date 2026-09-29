import type { Engine } from '../core/engine.js';
import { newId } from '../domain/ids.js';
import { latestSpec } from '../spec/generate.js';
import type { Spec } from '../spec/spec.js';
import { fileId } from './build.js';
import { GraphStore } from './graph-store.js';

/**
 * Context on request (MEJORAS 5.4, v2/08): instead of reading half the repo
 * blindly, an agent asks — with a reason — for decisions, related files or the
 * relations of one file. Forja answers from the approved spec and the graph,
 * within limits, and records every request (what agents really needed is
 * evidence for `forja memoria evaluar`).
 */

export type ContextRequest = { que: 'decision' | 'relacionados' | 'archivo'; objetivo: string; motivo: string };
export type RequestScope = { runId: string; taskId: string } | null;

export interface ContextProvider {
  answer(scope: RequestScope, req: ContextRequest): string;
}

export const CONTEXT_REQUESTED = 'contexto.pedido';
const MAX_ANSWER = 8_000;
const MAX_PER_TASK = 20;

const words = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9_-]+/)
    .filter((w) => w.length >= 3);

export class EngineContextProvider implements ContextProvider {
  constructor(
    private readonly engine: Engine,
    private readonly changeId: string,
  ) {}

  private spec(): Spec | null {
    return latestSpec(this.engine, this.changeId)?.spec ?? null;
  }

  private count(scope: RequestScope): number {
    if (!scope) return 0;
    return (this.engine.store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND run_id = ? AND task_id = ?').get(CONTEXT_REQUESTED, scope.runId, scope.taskId) as { n: number }).n;
  }

  answer(scope: RequestScope, req: ContextRequest): string {
    if (!req.motivo?.trim()) return 'Indica el motivo: se registra y ayuda a mejorar el contexto de próximas tareas.';
    if (this.count(scope) >= MAX_PER_TASK) return `Límite de ${MAX_PER_TASK} pedidos de contexto para esta tarea: sigue con lo que tienes o pregunta al usuario (NECESITA_ACLARACION).`;
    let text: string;
    try {
      text = req.que === 'decision' ? this.decisions(req.objetivo) : req.que === 'archivo' ? this.fileRelations(req.objetivo) : this.related(req.objetivo);
    } catch (error) {
      text = `No se pudo responder: ${(error as Error).message}`;
    }
    if (text.length > MAX_ANSWER) text = `${text.slice(0, MAX_ANSWER)}\n… [recortado]`;
    this.engine.store.execute({ request_id: newId('req'), type: 'pedir_contexto', input: { que: req.que } }, () => ({
      result: null,
      events: [
        {
          type: CONTEXT_REQUESTED,
          aggregate_type: 'tarea',
          aggregate_id: scope ? `${scope.runId}/${scope.taskId}` : 'sin_tarea',
          ...(scope ? { run_id: scope.runId, task_id: scope.taskId } : {}),
          payload: { que: req.que, objetivo: req.objetivo.slice(0, 300), motivo: req.motivo.slice(0, 300), bytes: text.length },
        },
      ],
    }));
    return text;
  }

  /** Approved decisions, rules and criteria that share words with the question. */
  private decisions(objetivo: string): string {
    const spec = this.spec();
    if (!spec) return 'No hay especificación todavía.';
    const q = new Set(words(objetivo));
    const hits: string[] = [];
    const score = (text: string) => words(text).filter((w) => q.has(w)).length;
    for (const d of spec.decisiones.filter((x) => x.estado === 'aprobada')) if (score(`${d.id} ${d.texto} ${d.motivo}`)) hits.push(`${d.id} (decisión aprobada): ${d.texto} — ${d.motivo}`);
    for (const r of spec.reglas) if (score(`${r.id} ${r.texto}`)) hits.push(`${r.id} (regla): ${r.texto}`);
    for (const c of spec.criterios) if (score(`${c.id} ${c.dado} ${c.cuando} ${c.entonces}`)) hits.push(`${c.id} (criterio): dado ${c.dado}, cuando ${c.cuando}, entonces ${c.entonces}`);
    return hits.length ? hits.join('\n') : 'Ninguna decisión, regla ni criterio aprobado trata eso. Si es una decisión nueva, pregúntala (NECESITA_ACLARACION) en vez de suponerla.';
  }

  private withGraph<T>(fn: (g: GraphStore) => T): T {
    const g = GraphStore.open(this.engine.dataDir);
    try {
      return fn(g);
    } finally {
      g.close();
    }
  }

  /** Files and symbols matching the question, with their direct relations. */
  private related(objetivo: string): string {
    return this.withGraph((g) => {
      const nodes = g.search(objetivo, 12);
      if (!nodes.length) return 'El índice no tiene nada con ese nombre. Prueba con un identificador, un caso de uso (UC-001) o un archivo.';
      return nodes
        .map((n) => {
          const rel = [
            ...g.out(n.id, ['importa', 'usa', 'verifica', 'implementa']).map((e) => `→ ${e.kind} ${e.dst}`),
            ...g.in(n.id, ['importa', 'usa', 'verifica', 'define']).map((e) => `← ${e.kind} ${e.src}`),
          ].slice(0, 8);
          return `${n.id} (${n.kind})${rel.length ? `\n  ${rel.join('\n  ')}` : ''}`;
        })
        .join('\n');
    });
  }

  /** What a file defines, imports and who depends on it (the agent reads its content itself). */
  private changedBy(path: string): string[] {
    return tasksThatChanged(this.engine, path);
  }

  private fileRelations(path: string): string {
    return this.withGraph((g) => {
      const id = fileId(path.replace(/^\.\//, ''));
      if (!g.fileRecord(path.replace(/^\.\//, ''))) return `${path} no está en el índice (¿no existe, es binario, generado o secreto?).`;
      const lines = [
        `Define: ${
          g
            .out(id, ['define'])
            .map((e) => e.dst.split('#')[1])
            .join(', ') || '—'
        }`,
        `Importa: ${
          g
            .out(id, ['importa'])
            .map((e) => e.dst.replace(/^archivo:/, ''))
            .join(', ') || '—'
        }`,
        `Lo importan: ${
          g
            .in(id, ['importa'])
            .map((e) => e.src.replace(/^archivo:/, ''))
            .join(', ') || '—'
        }`,
        `Verifica: ${
          g
            .out(id, ['verifica'])
            .map((e) => e.dst.replace(/^criterio:/, ''))
            .join(', ') || '—'
        }`,
      ];
      const changes = this.changedBy(path.replace(/^\.\//, ''));
      if (changes.length) lines.push('Cambiado por tareas ya unidas:', ...changes.map((c) => `  ${c}`));
      return lines.join('\n');
    });
  }
}

/** Integrated tasks (any run of the checkout) whose change touched `path`, with what they did (v3 §4.8). */
export function tasksThatChanged(engine: Engine, path: string, limit = 8): string[] {
  const rows = engine.store.db
    .prepare(
      "SELECT e.run_id, e.task_id, e.files, e.summary, t.title FROM task_exec e JOIN tasks t ON t.run_id = e.run_id AND t.task_id = e.task_id WHERE t.state = 'integrada' AND e.files LIKE ? ORDER BY e.updated_seq DESC LIMIT 50",
    )
    .all(`%${JSON.stringify(path).slice(1, -1)}%`) as { run_id: string; task_id: string; files: string; summary: string | null; title: string }[];
  const out: string[] = [];
  for (const r of rows) {
    let files: string[] = [];
    try {
      files = JSON.parse(r.files) as string[];
    } catch {
      continue;
    }
    if (!files.includes(path)) continue;
    out.push(`${r.task_id} (${r.run_id}) ${r.title}${r.summary ? ` — ${r.summary}` : ''}`);
    if (out.length >= limit) break;
  }
  return out;
}

/** Requests recorded for a run (or all), newest last. */
export function contextRequests(engine: Engine, runId?: string): { run_id: string | null; task_id: string | null; que: string; objetivo: string; motivo: string; recorded_at: string }[] {
  const rows = (
    runId
      ? engine.store.db.prepare('SELECT run_id, task_id, payload, recorded_at FROM events WHERE type = ? AND run_id = ? ORDER BY seq').all(CONTEXT_REQUESTED, runId)
      : engine.store.db.prepare('SELECT run_id, task_id, payload, recorded_at FROM events WHERE type = ? ORDER BY seq').all(CONTEXT_REQUESTED)
  ) as { run_id: string | null; task_id: string | null; payload: string; recorded_at: string }[];
  return rows.map((r) => ({ run_id: r.run_id, task_id: r.task_id, recorded_at: r.recorded_at, ...(JSON.parse(r.payload) as { que: string; objetivo: string; motivo: string }) }));
}
