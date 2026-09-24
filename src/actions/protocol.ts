import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashJson } from '../domain/hash.js';
import { newId } from '../domain/ids.js';
import { Redactor } from '../security/redact.js';
import { AEV, type ActionState } from '../store/action-projections.js';
import type { EventStore } from '../store/event-store.js';
import { ConnectionStore, type Connection } from './connections.js';
import type { ExecutorOrder, ExecutorResult } from './executor-main.js';
import { operation, urlUnder } from './operations.js';

/**
 * External action protocol (V2-051, v2/06): proposal → validation → preview →
 * approval bound to the preview's hash (with expiry) → exclusive reservation
 * → execution in a separate process → classified result. An uncertain result
 * is never retried blindly: only by resending the SAME idempotency key to a
 * service that honors it, or by an explicit human reconciliation.
 */

export class ActionError extends Error {}

export type ActionRow = {
  action_id: string;
  type: string;
  connection: string;
  connection_version: number;
  params: Record<string, unknown>;
  preview: Record<string, unknown>;
  hash: string;
  idempotency_key: string;
  origin: string;
  expires_at: string;
  state: ActionState;
  /** State as the user should see it: approvals expire. */
  view_state: ActionState | 'caducada';
  approved_by: string | null;
  attempts: number;
  result: { state?: string; detail?: string; evidence?: Record<string, unknown>; conciliada?: boolean; note?: string } | null;
};

type Raw = Omit<ActionRow, 'params' | 'preview' | 'result' | 'view_state'> & { params: string; preview: string; result: string | null };

export type LinkRow = { connection: string; version: number; operations: string[]; active: boolean };

/** Resolves a vault secret by name (null if the vault is closed or it does not exist). */
export type SecretResolver = (name: string) => string | null;

const PROPOSAL_TTL_MS = 30 * 60_000;
export const DEFAULT_EXECUTOR = fileURLToPath(new URL('./executor-main.js', import.meta.url));

export class ActionService {
  private readonly now: () => number;

  constructor(
    private readonly store: EventStore,
    private readonly connections: ConnectionStore,
    private readonly opts: { now?: () => number; executorScript?: string; timeoutMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  private emit(type: string, id: string, payload: Record<string, unknown>, requestId = newId('req')): void {
    this.store.execute({ request_id: requestId, type, input: { id, payload } }, () => ({
      result: null,
      events: [{ type, aggregate_type: type.startsWith('conexion') ? 'conexion' : 'accion', aggregate_id: id, payload }],
    }));
  }

  // ---------- links (per checkout, explicit user decision) ----------

  links(): LinkRow[] {
    return (this.store.db.prepare('SELECT * FROM connection_links ORDER BY connection').all() as { connection: string; version: number; operations: string; active: number }[]).map((l) => ({
      connection: l.connection,
      version: l.version,
      operations: JSON.parse(l.operations) as string[],
      active: l.active === 1,
    }));
  }

  link(name: string, operations: string[]): LinkRow {
    const conn = this.connections.get(name);
    for (const op of operations) operation(op);
    return this.linkResource(name, conn.version, operations);
  }

  /** Records an explicit authorization of a versioned resource (connection or `mcp:<server>`) in this checkout. */
  linkResource(name: string, version: number, operations: string[]): LinkRow {
    if (!operations.length) throw new ActionError('indica al menos una operación permitida');
    this.emit(AEV.linked, name, { connection: name, version, operations: [...new Set(operations)].sort() });
    return this.links().find((l) => l.connection === name)!;
  }

  unlink(name: string): void {
    if (!this.links().some((l) => l.connection === name && l.active)) throw new ActionError(`la conexión «${name}» no está vinculada`);
    this.emit(AEV.unlinked, name, { connection: name });
  }

  /** The connection is usable for `op` in this checkout, at its CURRENT version. */
  private authorized(name: string, op: string): { conn: Connection; link: LinkRow } {
    const conn = this.connections.get(name);
    const link = this.links().find((l) => l.connection === name && l.active);
    if (!link) throw new ActionError(`la conexión «${name}» no está vinculada a este proyecto: forja conexion vincular ${name} --operaciones ${op}`);
    if (link.version !== conn.version) throw new ActionError(`la conexión «${name}» cambió (versión ${conn.version}; vinculada la ${link.version}): vuelve a vincularla`);
    if (!link.operations.includes(op)) throw new ActionError(`la operación ${op} no está permitida para «${name}» en este proyecto`);
    return { conn, link };
  }

  // ---------- actions ----------

  private toRow(r: Raw): ActionRow {
    const expired = (r.state === 'propuesta' || r.state === 'aprobada') && Date.parse(r.expires_at) < this.now();
    return { ...r, params: JSON.parse(r.params), preview: JSON.parse(r.preview), result: r.result ? JSON.parse(r.result) : null, view_state: expired ? 'caducada' : r.state };
  }

  get(id: string): ActionRow {
    const r = this.store.db.prepare('SELECT * FROM actions WHERE action_id = ?').get(id) as Raw | undefined;
    if (!r) throw new ActionError(`no existe la acción ${id}`);
    return this.toRow(r);
  }

  list(): ActionRow[] {
    return (this.store.db.prepare('SELECT * FROM actions ORDER BY created_seq DESC').all() as Raw[]).map((r) => this.toRow(r));
  }

  /** Validates and previews a typed operation. Editing anything later means a new proposal. */
  propose(input: { type: string; connection: string; params: unknown; origin: string }): ActionRow {
    const op = operation(input.type);
    const parsed = op.params.safeParse(input.params);
    if (!parsed.success) throw new ActionError(`parámetros inválidos: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ')}`);
    const { conn, link } = this.authorized(input.connection, op.id);
    let preview: Record<string, unknown>;
    try {
      preview = op.preview(conn, parsed.data);
      op.request(conn, parsed.data);
    } catch (error) {
      throw new ActionError((error as Error).message);
    }
    const id = newId('acc');
    const idempotencyKey = `forja-${id}`;
    const expiresAt = new Date(this.now() + PROPOSAL_TTL_MS).toISOString();
    const params = parsed.data as Record<string, unknown>;
    // Everything the approval covers: any change produces a different hash.
    const hash = hashJson({ id, type: op.id, connection: conn.name, connection_version: conn.version, operations: link.operations, params, expires_at: expiresAt, idempotency_key: idempotencyKey });
    this.emit(AEV.proposed, id, { type: op.id, connection: conn.name, connection_version: conn.version, params, preview, hash, idempotency_key: idempotencyKey, origin: input.origin, expires_at: expiresAt });
    return this.get(id);
  }

  approve(id: string, hash: string, actor: string): ActionRow {
    const a = this.get(id);
    if (a.state === 'aprobada' && a.hash === hash) return a; // Double approval: same result, no new event.
    if (a.view_state === 'caducada') throw new ActionError('la propuesta caducó: vuelve a proponerla');
    if (a.state !== 'propuesta') throw new ActionError(`la acción está ${a.state}: no se puede aprobar`);
    if (a.hash !== hash) throw new ActionError('el hash no coincide con la vista previa: revisa la acción actual antes de aprobar');
    this.emit(AEV.approved, id, { hash, actor }, `aprobar:${id}:${hash}`);
    return this.get(id);
  }

  discard(id: string, actor: string, reason: string): ActionRow {
    const a = this.get(id);
    if (a.state !== 'propuesta' && a.state !== 'aprobada') throw new ActionError(`la acción está ${a.state}: ya no se puede descartar`);
    this.emit(AEV.discarded, id, { actor, reason });
    return this.get(id);
  }

  /**
   * Executes an approved action, or resends an uncertain one to an idempotent
   * service with the same key. The reservation (state «ejecutando», approval
   * consumed) is committed BEFORE the effect, atomically with the checks.
   */
  async execute(id: string, secret: SecretResolver): Promise<ActionRow> {
    const before = this.get(id);
    const { conn } = this.authorized(before.connection, before.type);
    const credential = conn.secret ? secret(conn.secret) : null;
    if (conn.secret && credential === null) throw new ActionError(`no se pudo leer el secreto «${conn.secret}»: abre la bóveda o guárdalo con forja boveda guardar ${conn.secret}`);

    let attempt = 0;
    this.store.execute({ request_id: newId('req'), type: AEV.executing, input: { id } }, () => {
      const a = this.get(id);
      const retry = a.state === 'desconocido' && conn.idempotent;
      if (a.state === 'desconocido' && !conn.idempotent) throw new ActionError('resultado desconocido y el servicio no garantiza idempotencia: concílialo a mano (forja accion conciliar)');
      if (a.state !== 'aprobada' && !retry) throw new ActionError(`la acción está ${a.view_state}: sólo se ejecuta una acción aprobada`);
      if (a.state === 'aprobada' && a.view_state === 'caducada') throw new ActionError('la aprobación caducó: vuelve a proponer la acción');
      if (a.connection_version !== conn.version) throw new ActionError('la conexión cambió desde la propuesta: vuelve a proponer la acción');
      attempt = a.attempts + 1;
      return { result: null, events: [{ type: AEV.executing, aggregate_type: 'accion', aggregate_id: id, payload: { attempt } }] };
    });

    const action = this.get(id);
    const op = operation(action.type);
    const order: ExecutorOrder = {
      request: op.request(conn, op.params.parse(action.params)),
      idempotencyKey: action.idempotency_key,
      auth: credential ? { header: conn.auth_header, value: conn.auth_scheme ? `${conn.auth_scheme} ${credential}` : credential } : null,
      allowLocal: conn.allow_local,
      timeoutMs: this.opts.timeoutMs ?? 30_000,
    };
    const outcome = await this.runExecutor(order);
    const redactor = new Redactor();
    if (credential) redactor.add({ name: conn.secret!, value: credential });
    const { state, detail } = classify(outcome);
    const evidence = JSON.parse(redactor.redact(JSON.stringify({ ...outcome, attempt }))) as Record<string, unknown>;
    this.emit(AEV.result, id, { state, detail: redactor.redact(detail), evidence });
    return this.get(id);
  }

  /** Lowest-impact check of a connection: GET its test path through the same isolated executor. */
  async probe(name: string, secret: SecretResolver): Promise<{ ok: boolean; detail: string }> {
    const conn = this.connections.get(name);
    if (!conn.test_path) throw new ActionError(`la conexión «${name}» no define una ruta de prueba (--prueba /salud)`);
    const credential = conn.secret ? secret(conn.secret) : null;
    if (conn.secret && credential === null) throw new ActionError(`no se pudo leer el secreto «${conn.secret}» de la bóveda`);
    const r = await this.runExecutor({
      request: { method: 'GET', url: urlUnder(conn.base_url, conn.test_path), body: null, precondition: null },
      idempotencyKey: `forja-prueba-${newId('prueba')}`,
      auth: credential ? { header: conn.auth_header, value: conn.auth_scheme ? `${conn.auth_scheme} ${credential}` : credential } : null,
      allowLocal: conn.allow_local,
      timeoutMs: this.opts.timeoutMs ?? 30_000,
    });
    if (r.phase === 'respuesta') return { ok: r.status >= 200 && r.status < 300, detail: `respondió ${r.status}` };
    return { ok: false, detail: r.detail };
  }

  /** Separate process, empty environment and working directory; killed at the deadline. */
  private runExecutor(order: ExecutorOrder): Promise<ExecutorResult> {
    const cwd = mkdtempSync(join(tmpdir(), 'forja-ejecutor-'));
    return new Promise<ExecutorResult>((resolve) => {
      const child = spawn(process.execPath, [this.opts.executorScript ?? DEFAULT_EXECUTOR], { cwd, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let settled = false;
      const done = (r: ExecutorResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rmSync(cwd, { recursive: true, force: true });
        resolve(r);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done({ phase: 'incierto', detail: 'el ejecutor no terminó a tiempo' });
      }, order.timeoutMs + 5_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => (out += c));
      child.on('error', (e) => done({ phase: 'no_enviado', detail: `no arrancó el ejecutor: ${e.message}` }));
      child.on('close', () => {
        try {
          done(JSON.parse(out.trim().split('\n').at(-1) ?? '') as ExecutorResult);
        } catch {
          done({ phase: 'incierto', detail: 'el ejecutor terminó sin informar el resultado' });
        }
      });
      child.stdin.end(JSON.stringify(order));
    });
  }

  /** Human decision for an uncertain result after checking the service. */
  reconcile(id: string, effect: boolean, actor: string, note: string): ActionRow {
    const a = this.get(id);
    if (a.state !== 'desconocido' && a.state !== 'ejecutando') throw new ActionError(`la acción está ${a.state}: no hay nada que conciliar`);
    this.emit(AEV.reconciled, id, { state: effect ? 'confirmada' : 'sin_efecto', actor, note });
    return this.get(id);
  }

  /**
   * An action left «ejecutando» by a process that died: its effect is unknown.
   * Recorded as such, never assumed done or not done.
   */
  recoverInterrupted(olderThanMs = (this.opts.timeoutMs ?? 30_000) + 60_000): string[] {
    const stale = this.store.db
      .prepare("SELECT a.action_id, e.recorded_at FROM actions a JOIN events e ON e.seq = a.updated_seq WHERE a.state = 'ejecutando'")
      .all() as { action_id: string; recorded_at: string }[];
    const out: string[] = [];
    for (const s of stale) {
      if (this.now() - Date.parse(s.recorded_at) < olderThanMs) continue;
      this.emit(AEV.result, s.action_id, { state: 'desconocido', detail: 'el ejecutor se interrumpió: no se sabe si el servicio aplicó la acción', evidence: {} });
      out.push(s.action_id);
    }
    return out;
  }
}

/** Result table of v2/06. */
export function classify(r: ExecutorResult): { state: 'confirmada' | 'rechazada' | 'desconocido' | 'sin_efecto'; detail: string } {
  switch (r.phase) {
    case 'bloqueado':
      return { state: 'rechazada', detail: r.detail };
    case 'precondicion':
      return { state: 'rechazada', detail: `precondición no cumplida: ${r.detail}` };
    case 'no_enviado':
      return { state: 'sin_efecto', detail: r.detail };
    case 'incierto':
      return { state: 'desconocido', detail: `resultado desconocido: ${r.detail}` };
    case 'respuesta':
      if (r.status >= 200 && r.status < 300) return { state: 'confirmada', detail: `el servicio respondió ${r.status}` };
      if (r.status === 412) return { state: 'rechazada', detail: 'el recurso cambió desde la vista previa (412): no se aplicó' };
      if (r.status >= 400 && r.status < 500) return { state: 'rechazada', detail: `el servicio rechazó la acción (${r.status})` };
      // 5xx or an unfollowed redirect: it may have been partially applied.
      return { state: 'desconocido', detail: `respuesta ${r.status}: el efecto no se puede asegurar` };
  }
}
