import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, transaction, type Db } from '../store/sqlite.js';

/**
 * Knowledge graph of a checkout (M6, v2/08 · Grafo). It is an INDEX: it lives
 * apart from the event store (grafo.db) and can be deleted and rebuilt from
 * versioned sources at any time. Every node and edge records where it came
 * from and how it was extracted; edges carry a confidence.
 */

export type NodeKind = 'requisito' | 'caso_uso' | 'criterio' | 'regla' | 'entidad' | 'contrato' | 'decision' | 'tarea' | 'archivo' | 'simbolo' | 'paquete' | 'conexion';
export type EdgeKind = 'implementa' | 'verifica' | 'depende' | 'define' | 'importa' | 'aplica' | 'afecta' | 'cubre' | 'usa' | 'menciona';
/** «seguro»: demonstrated by syntax; «posible»: inferred (names, dynamic imports, unresolved aliases). */
export type Confidence = 'seguro' | 'posible';

export type GraphNode = { id: string; kind: NodeKind; label: string; source: string; data?: Record<string, unknown> };
export type GraphEdge = { src: string; dst: string; kind: EdgeKind; confidence: Confidence; source: string; method: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL, data TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, confidence TEXT NOT NULL, source TEXT NOT NULL, method TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst, kind);
CREATE INDEX IF NOT EXISTS nodes_source ON nodes(source);
CREATE INDEX IF NOT EXISTS edges_source ON edges(source);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, hash TEXT NOT NULL, extractor TEXT NOT NULL, notes TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class GraphStore {
  private constructor(
    readonly db: Db,
    readonly path: string,
  ) {}

  static open(dataDir: string): GraphStore {
    const path = join(dataDir, 'grafo.db');
    const db = openDatabase(path);
    db.exec(SCHEMA);
    return new GraphStore(db, path);
  }

  /** Deleting the index is always safe: `forja memoria construir` recreates it. */
  static reset(dataDir: string): void {
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `grafo.db${suffix}`), { force: true });
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  meta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Removes everything a source (a file, the spec) contributed, before re-extracting it. */
  dropSource(source: string): void {
    this.db.prepare('DELETE FROM edges WHERE source = ?').run(source);
    this.db.prepare('DELETE FROM nodes WHERE source = ?').run(source);
  }

  addNode(n: GraphNode): void {
    this.db
      .prepare('INSERT INTO nodes (id, kind, label, source, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, label = excluded.label, source = excluded.source, data = excluded.data')
      .run(n.id, n.kind, n.label, n.source, n.data ? JSON.stringify(n.data) : null);
  }

  addEdge(e: GraphEdge): void {
    // A «seguro» edge is never downgraded by a later «posible» one for the same pair.
    this.db
      .prepare(
        `INSERT INTO edges (src, dst, kind, confidence, source, method) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(src, dst, kind) DO UPDATE SET confidence = CASE WHEN edges.confidence = 'seguro' THEN 'seguro' ELSE excluded.confidence END`,
      )
      .run(e.src, e.dst, e.kind, e.confidence, e.source, e.method);
  }

  node(id: string): (GraphNode & { data?: Record<string, unknown> }) | null {
    const r = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as { id: string; kind: NodeKind; label: string; source: string; data: string | null } | undefined;
    return r ? { id: r.id, kind: r.kind, label: r.label, source: r.source, ...(r.data ? { data: JSON.parse(r.data) as Record<string, unknown> } : {}) } : null;
  }

  out(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    const rows = this.db.prepare('SELECT * FROM edges WHERE src = ? ORDER BY dst').all(id) as GraphEdge[];
    return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
  }

  in(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    const rows = this.db.prepare('SELECT * FROM edges WHERE dst = ? ORDER BY src').all(id) as GraphEdge[];
    return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
  }

  search(text: string, limit = 30): GraphNode[] {
    const like = `%${text.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    return this.db.prepare("SELECT id, kind, label, source FROM nodes WHERE id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\' ORDER BY kind, id LIMIT ?").all(like, like, limit) as unknown as GraphNode[];
  }

  fileRecord(path: string): { hash: string; extractor: string } | null {
    return (this.db.prepare('SELECT hash, extractor FROM files WHERE path = ?').get(path) as { hash: string; extractor: string } | undefined) ?? null;
  }

  setFile(path: string, hash: string, extractor: string, notes: string[]): void {
    this.db.prepare('INSERT INTO files (path, hash, extractor, notes) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, extractor = excluded.extractor, notes = excluded.notes').run(path, hash, extractor, JSON.stringify(notes));
  }

  files(): { path: string; hash: string; extractor: string; notes: string[] }[] {
    return (this.db.prepare('SELECT * FROM files ORDER BY path').all() as { path: string; hash: string; extractor: string; notes: string }[]).map((f) => ({ ...f, notes: JSON.parse(f.notes) as string[] }));
  }

  removeFile(path: string): void {
    this.dropSource(`archivo:${path}`);
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
  }

  stats(): { nodos: Record<string, number>; aristas: Record<string, number>; posibles: number } {
    const nodes = this.db.prepare('SELECT kind, COUNT(*) n FROM nodes GROUP BY kind').all() as { kind: string; n: number }[];
    const edges = this.db.prepare('SELECT kind, COUNT(*) n FROM edges GROUP BY kind').all() as { kind: string; n: number }[];
    const possible = (this.db.prepare("SELECT COUNT(*) n FROM edges WHERE confidence = 'posible'").get() as { n: number }).n;
    return { nodos: Object.fromEntries(nodes.map((r) => [r.kind, r.n])), aristas: Object.fromEntries(edges.map((r) => [r.kind, r.n])), posibles: possible };
  }
}
