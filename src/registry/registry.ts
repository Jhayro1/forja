import { join } from 'node:path';
import { newId } from '../domain/ids.js';
import { openDatabase, transaction, type Db } from '../store/sqlite.js';

export type CheckoutRow = {
  checkout_id: string;
  project_id: string;
  name: string;
  path: string;
  created_at: string;
  last_used_at: string;
  archived: 0 | 1;
};

/**
 * Global registry (~/.forja/registro.db). project_id is logical and versioned in
 * forja.yaml; checkout_id is local: two clones of the same project are two checkouts.
 */
export class Registry {
  private constructor(readonly db: Db) {}

  static open(home: string): Registry {
    const db = openDatabase(join(home, 'registro.db'));
    db.exec(`
      CREATE TABLE IF NOT EXISTS checkouts (
        checkout_id  TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        name         TEXT NOT NULL,
        path         TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        archived     INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    return new Registry(db);
  }

  close(): void {
    this.db.close();
  }

  register(projectId: string, name: string, path: string): CheckoutRow {
    return transaction(this.db, () => {
      const existing = this.byPath(path);
      if (existing) {
        if (existing.project_id !== projectId) throw new Error(`la ruta ${path} ya está registrada con otro proyecto (${existing.name})`);
        return existing;
      }
      const now = new Date().toISOString();
      const row: CheckoutRow = { checkout_id: newId('chk'), project_id: projectId, name, path, created_at: now, last_used_at: now, archived: 0 };
      this.db
        .prepare('INSERT INTO checkouts (checkout_id, project_id, name, path, created_at, last_used_at, archived) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(row.checkout_id, row.project_id, row.name, row.path, row.created_at, row.last_used_at);
      return row;
    });
  }

  byPath(path: string): CheckoutRow | undefined {
    return this.db.prepare('SELECT * FROM checkouts WHERE path = ?').get(path) as CheckoutRow | undefined;
  }

  byId(checkoutId: string): CheckoutRow | undefined {
    return this.db.prepare('SELECT * FROM checkouts WHERE checkout_id = ?').get(checkoutId) as CheckoutRow | undefined;
  }

  byName(name: string): CheckoutRow[] {
    return this.db.prepare('SELECT * FROM checkouts WHERE name = ? AND archived = 0').all(name) as CheckoutRow[];
  }

  list(includeArchived = false): CheckoutRow[] {
    return this.db
      .prepare(`SELECT * FROM checkouts ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY last_used_at DESC`)
      .all() as CheckoutRow[];
  }

  touch(checkoutId: string): void {
    this.db.prepare('UPDATE checkouts SET last_used_at = ? WHERE checkout_id = ?').run(new Date().toISOString(), checkoutId);
  }

  /** Moves a checkout to a new path (the old one must no longer exist; checked by the caller). */
  relink(checkoutId: string, newPath: string): void {
    this.db.prepare('UPDATE checkouts SET path = ? WHERE checkout_id = ?').run(newPath, checkoutId);
  }

  /** Archiving hides the project; it never deletes data (R08). */
  setArchived(checkoutId: string, archived: boolean): void {
    this.db.prepare('UPDATE checkouts SET archived = ? WHERE checkout_id = ?').run(archived ? 1 : 0, checkoutId);
  }

  setActive(checkoutId: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('activo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(checkoutId);
  }

  active(): CheckoutRow | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'activo'").get() as { value: string } | undefined;
    return row ? this.byId(row.value) : undefined;
  }
}
