import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { git } from '../git/git.js';
import type { Plan } from '../plan/plan.js';
import type { Spec } from '../spec/spec.js';
import { EXTRACTORS, extractorFor } from './extract/index.js';
import type { ImportRef } from './extract/types.js';
import type { GraphStore } from './graph-store.js';

/**
 * Incremental graph build (V2-060/061). Parsing is the expensive part and is
 * skipped for files whose content hash and extractor version did not change.
 * Cheap passes (import resolution, spec and plan nodes) are always redone, so
 * a new file can resolve imports of unchanged files and nothing goes stale.
 */

export const GRAPH_BUILDER_VERSION = 'grafo-1';
const MAX_FILE_BYTES = 512 * 1024;
/** Never read, even if versioned: they may contain secrets or are not source (v2/08). */
const EXCLUDED = [/(^|\/)\.env(\.|$)/, /\.(pem|key|p12|pfx|crt|jks)$/i, /(^|\/)node_modules\//, /(^|\/)(dist|build|coverage)\//, /(^|\/)\.forja\//, /\.(min\.js|map|lock)$/, /(^|\/)package-lock\.json$/];

export const fileId = (path: string) => `archivo:${path}`;
export const symbolId = (path: string, name: string) => `simbolo:${path}#${name}`;
const isTest = (path: string) => /(\.|_)(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)(test|tests|__tests__)\//.test(path) || /(^|\/)test_[^/]+\.py$/.test(path);

export type BuildReport = {
  archivos: number;
  analizados: number;
  reutilizados: number;
  eliminados: number;
  excluidos: number;
  limitaciones: { archivo: string; nota: string }[];
  sin_resolver: { archivo: string; importa: string }[];
};

function specIdNode(id: string): string {
  if (id.startsWith('CA-')) return `criterio:${id}`;
  if (id.startsWith('UC-')) return `caso_uso:${id}`;
  if (id.startsWith('REQ-') || id.startsWith('RNF-')) return `requisito:${id}`;
  if (id.startsWith('CT-')) return `contrato:${id}`;
  if (id.startsWith('R-')) return `regla:${id}`;
  if (id.startsWith('E-')) return `entidad:${id}`;
  return `tarea:${id}`;
}

export async function buildGraph(graph: GraphStore, input: { repoPath: string; spec?: Spec | null; plan?: Plan | null; connections?: string[] }): Promise<BuildReport> {
  const tree = (await git(input.repoPath, ['ls-files'])).stdout.split('\n').filter(Boolean);
  const report: BuildReport = { archivos: 0, analizados: 0, reutilizados: 0, eliminados: 0, excluidos: 0, limitaciones: [], sin_resolver: [] };
  const extractorsVersion = `${GRAPH_BUILDER_VERSION}|${EXTRACTORS.map((e) => e.version).join(',')}`;

  graph.tx(() => {
    if (graph.meta('version') !== extractorsVersion) {
      // A new extractor or builder invalidates every previous analysis.
      for (const t of ['edges', 'nodes', 'files']) graph.db.exec(`DELETE FROM ${t}`);
      graph.setMeta('version', extractorsVersion);
    }
  });

  const candidates = tree.filter((p) => {
    if (!extractorFor(p)) return false;
    if (EXCLUDED.some((re) => re.test(p))) {
      report.excluidos++;
      return false;
    }
    return true;
  });
  const present = new Set(candidates);

  // 1) Parse changed files (the only expensive step).
  for (const path of candidates) {
    const full = join(input.repoPath, path);
    if (!existsSync(full) || statSync(full).size > MAX_FILE_BYTES) {
      report.excluidos++;
      present.delete(path);
      continue;
    }
    const buf = readFileSync(full);
    if (buf.includes(0)) {
      report.excluidos++;
      present.delete(path);
      continue;
    }
    report.archivos++;
    const extractor = extractorFor(path)!;
    const hash = createHash('sha256').update(buf).digest('hex');
    const prev = graph.fileRecord(path);
    if (prev && prev.hash === hash && prev.extractor === extractor.version) {
      report.reutilizados++;
      continue;
    }
    const x = extractor.extract(buf.toString('utf8'));
    graph.tx(() => {
      graph.dropSource(fileId(path));
      graph.addNode({ id: fileId(path), kind: 'archivo', label: path, source: fileId(path), data: { lenguaje: extractor.id, prueba: isTest(path), imports: x.imports, hash } });
      for (const s of x.symbols) {
        graph.addNode({ id: symbolId(path, s.name), kind: 'simbolo', label: s.name, source: fileId(path), data: { tipo: s.kind, exportado: s.exported, linea: s.line } });
        graph.addEdge({ src: fileId(path), dst: symbolId(path, s.name), kind: 'define', confidence: 'seguro', source: fileId(path), method: extractor.version });
      }
      for (const id of x.mentions) {
        const kind = isTest(path) && id.startsWith('CA-') ? 'verifica' : 'menciona';
        graph.addEdge({ src: fileId(path), dst: specIdNode(id), kind, confidence: kind === 'verifica' ? 'seguro' : 'posible', source: fileId(path), method: `${extractor.version}:ids` });
      }
      graph.setFile(path, hash, extractor.version, x.notes);
    });
    report.analizados++;
  }

  // 2) Files that disappeared.
  for (const f of graph.files()) {
    if (!present.has(f.path)) {
      graph.tx(() => graph.removeFile(f.path));
      report.eliminados++;
    }
  }

  // 3) Import resolution against the CURRENT file set (cheap, always redone).
  graph.tx(() => {
    graph.dropSource('resolucion');
    const rows = graph.db.prepare("SELECT id, label, data FROM nodes WHERE kind = 'archivo'").all() as { id: string; label: string; data: string }[];
    for (const r of rows) {
      const data = JSON.parse(r.data) as { imports: ImportRef[] };
      const extractor = extractorFor(r.label)!;
      for (const imp of data.imports) {
        const res = extractor.resolve(imp.specifier, r.label, present);
        if (res && 'path' in res) {
          graph.addEdge({ src: r.id, dst: fileId(res.path), kind: 'importa', confidence: res.confidence === 'seguro' && imp.confidence === 'seguro' ? 'seguro' : 'posible', source: 'resolucion', method: extractor.version });
        } else if (res && 'package' in res) {
          graph.addNode({ id: `paquete:${res.package}`, kind: 'paquete', label: res.package, source: 'resolucion' });
          graph.addEdge({ src: r.id, dst: `paquete:${res.package}`, kind: 'importa', confidence: 'seguro', source: 'resolucion', method: extractor.version });
        } else {
          report.sin_resolver.push({ archivo: r.label, importa: imp.specifier });
        }
      }
    }
  });
  for (const f of graph.files()) for (const n of f.notes) report.limitaciones.push({ archivo: f.path, nota: n });

  // 4) Spec and plan (cheap; rebuilt every time from the approved documents).
  graph.tx(() => {
    graph.dropSource('spec');
    graph.dropSource('plan');
    graph.dropSource('conexiones');
    const s = input.spec;
    if (s) {
      const add = (id: string, kind: Parameters<GraphStore['addNode']>[0]['kind'], label: string, data?: Record<string, unknown>) => graph.addNode({ id, kind, label, source: 'spec', ...(data ? { data } : {}) });
      const edge = (src: string, dst: string, kind: Parameters<GraphStore['addEdge']>[0]['kind']) => graph.addEdge({ src, dst, kind, confidence: 'seguro', source: 'spec', method: 'spec' });
      for (const r of s.requisitos) add(`requisito:${r.id}`, 'requisito', r.texto);
      for (const r of s.reglas) add(`regla:${r.id}`, 'regla', r.texto);
      for (const e of s.entidades) add(`entidad:${e.id}`, 'entidad', e.nombre);
      for (const c of s.contratos) add(`contrato:${c.id}`, 'contrato', c.descripcion);
      for (const d of s.decisiones) add(`decision:${d.id}`, 'decision', d.texto, { estado: d.estado });
      for (const u of s.casos_uso) {
        add(`caso_uso:${u.id}`, 'caso_uso', u.nombre);
        for (const r of u.requisitos) edge(`caso_uso:${u.id}`, `requisito:${r}`, 'cubre');
        for (const r of u.reglas) edge(`caso_uso:${u.id}`, `regla:${r}`, 'aplica');
        for (const e of u.entidades) edge(`caso_uso:${u.id}`, `entidad:${e}`, 'usa');
      }
      for (const c of s.criterios) {
        add(`criterio:${c.id}`, 'criterio', `${c.dado} / ${c.cuando} / ${c.entonces}`);
        edge(`criterio:${c.id}`, `caso_uso:${c.caso_uso_id}`, 'cubre');
      }
      // Entities ↔ code symbols by name: only «posible» (a name is not a proof).
      const symbols = graph.db.prepare("SELECT id, label FROM nodes WHERE kind = 'simbolo'").all() as { id: string; label: string }[];
      for (const e of s.entidades) {
        const word = e.nombre.toLowerCase().replace(/\s+/g, '');
        if (word.length < 4) continue;
        for (const sym of symbols) if (sym.label.toLowerCase().includes(word)) graph.addEdge({ src: `entidad:${e.id}`, dst: sym.id, kind: 'menciona', confidence: 'posible', source: 'spec', method: 'nombre' });
      }
    }
    const p = input.plan;
    if (p) {
      for (const t of p.tareas) {
        graph.addNode({ id: `tarea:${t.id}`, kind: 'tarea', label: t.titulo, source: 'plan', data: { tipo: t.tipo } });
        const edge = (dst: string, kind: Parameters<GraphStore['addEdge']>[0]['kind']) => graph.addEdge({ src: `tarea:${t.id}`, dst, kind, confidence: 'seguro', source: 'plan', method: 'plan' });
        for (const c of t.criterios) edge(`criterio:${c}`, t.tipo === 'pruebas' ? 'verifica' : 'implementa');
        for (const d of t.depende_de) edge(`tarea:${d}`, 'depende');
        for (const f of tree.filter((x) => t.escribe.some((g) => x === g || matchesGlob(x, g)))) edge(fileId(f), 'afecta');
      }
    }
    for (const c of input.connections ?? []) graph.addNode({ id: `conexion:${c}`, kind: 'conexion', label: c, source: 'conexiones' });
  });
  graph.setMeta('construido', new Date().toISOString());
  return report;
}
