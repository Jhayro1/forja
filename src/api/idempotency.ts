import type { Db } from '../store/sqlite.js';

/**
 * Stored answers to mutations by Idempotency-Key (MEJORAS 3.7). The key is
 * scoped by method and path, and remembers a hash of the request body: the same
 * key with a different body is refused instead of replaying an unrelated answer.
 */
export type StoredAnswer = { status: number; body: unknown; requestHash: string };

export interface IdempotencyStore {
  get(key: string): StoredAnswer | undefined;
  set(key: string, answer: StoredAnswer): void;
}

/** In-process store (tests, or when there is no database). */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, StoredAnswer>();

  constructor(private readonly max = 500) {}

  get(key: string): StoredAnswer | undefined {
    return this.map.get(key);
  }

  set(key: string, answer: StoredAnswer): void {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, answer);
  }
}

/** Persistent store in the checkout's database: a retry after restarting `forja ui` still replays. */
export class SqliteIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly db: Db,
    private readonly ttlMs = 24 * 60 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): StoredAnswer | undefined {
    const row = this.db.prepare('SELECT status, body, request_hash, created_at FROM api_idempotency WHERE key = ?').get(key) as
      | { status: number; body: string; request_hash: string; created_at: number }
      | undefined;
    if (!row || this.now() - row.created_at > this.ttlMs) return undefined;
    return { status: row.status, body: JSON.parse(row.body) as unknown, requestHash: row.request_hash };
  }

  set(key: string, answer: StoredAnswer): void {
    this.db.prepare('DELETE FROM api_idempotency WHERE created_at < ?').run(this.now() - this.ttlMs);
    this.db
      .prepare('INSERT OR REPLACE INTO api_idempotency (key, status, body, request_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(key, answer.status, JSON.stringify(answer.body), answer.requestHash, this.now());
  }
}
