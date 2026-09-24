import { createHash } from 'node:crypto';
import type { ConnectionStore } from '../actions/connections.js';
import type { ActionService, SecretResolver } from '../actions/protocol.js';
import { newId } from '../domain/ids.js';
import type { EventStore } from '../store/event-store.js';

/**
 * Notifications when something waits for the user (MEJORAS 7). Each one is a
 * typed external action (`webhook.evento`) that goes through the same
 * protocol as any other — preview, hash, isolated executor, audit — approved
 * by a STANDING policy the user activated once. The policy fixes exactly what
 * leaves the machine: by default only the project, the kind and the id (no
 * question text, no code), and it stops working if the connection changes.
 */
export const NEV = { activated: 'notificaciones.activadas', deactivated: 'notificaciones.desactivadas', sent: 'notificacion.enviada' } as const;

export const NOTIFY_OPERATION = 'webhook.evento';
export const NOTIFY_EVENT = 'forja.pendiente';
export const POLICY_ACTOR = 'politica:notificaciones';
const TEXT_LIMIT = 280;

export type NotificationPolicy = { connection: string; connection_version: number; include_text: boolean; path: string; actor: string; at: string };

/** What a notice is about: a pending item of the run («pregunta_tarea», «tarea_bloqueada»…) or a test. */
export type Notice = { kind: string; id: string; text: string };

export class NotificationError extends Error {}

export class NotificationService {
  /** Warnings already shown by this process (a changed connection is said once, not every tick). */
  private readonly warned = new Set<string>();

  constructor(
    private readonly store: EventStore,
    private readonly connections: ConnectionStore,
    private readonly actions: ActionService,
    private readonly project: string,
  ) {}

  policy(): NotificationPolicy | null {
    const row = this.store.db.prepare('SELECT type, payload FROM events WHERE type IN (?, ?) ORDER BY seq DESC LIMIT 1').get(NEV.activated, NEV.deactivated) as
      | { type: string; payload: string }
      | undefined;
    return row?.type === NEV.activated ? (JSON.parse(row.payload) as NotificationPolicy) : null;
  }

  /** Activating is the explicit decision: it links the connection for webhook.evento and fixes the data shape. */
  activate(connection: string, opts: { includeText?: boolean; path?: string; actor?: string } = {}): NotificationPolicy {
    const conn = this.connections.get(connection);
    const current = this.actions.links().find((l) => l.connection === connection && l.active && l.version === conn.version);
    if (!current?.operations.includes(NOTIFY_OPERATION)) this.actions.link(connection, [...(current?.operations ?? []), NOTIFY_OPERATION]);
    const policy: NotificationPolicy = {
      connection,
      connection_version: conn.version,
      include_text: opts.includeText ?? false,
      path: opts.path ?? '/',
      actor: opts.actor ?? 'local',
      at: new Date().toISOString(),
    };
    this.emit(NEV.activated, policy);
    return policy;
  }

  deactivate(actor = 'local'): void {
    if (!this.policy()) throw new NotificationError('las notificaciones no están activas');
    this.emit(NEV.deactivated, { actor, at: new Date().toISOString() });
  }

  /** Exactly the parameters sent for one pending item under `policy`. */
  paramsFor(item: Notice, policy: NotificationPolicy): Record<string, unknown> {
    const datos: Record<string, unknown> = { proyecto: this.project, tipo: item.kind, id: item.id };
    if (policy.include_text) datos.texto = item.text.length > TEXT_LIMIT ? `${item.text.slice(0, TEXT_LIMIT)}…` : item.text;
    return { evento: NOTIFY_EVENT, datos, ruta: policy.path };
  }

  /**
   * Sends one notification per pending item not notified before (by kind, id and
   * text). Returns lines for the run log; failures are visible there and in the audit.
   */
  async notify(items: readonly Notice[], secret: SecretResolver): Promise<string[]> {
    const policy = this.policy();
    if (!policy || items.length === 0) return [];
    const conn = this.connections.all().find((c) => c.name === policy.connection);
    if (!conn || conn.version !== policy.connection_version) {
      return this.warnOnce(
        `conn:${policy.connection}:${conn?.version ?? 'x'}`,
        `⚠ notificaciones en pausa: la conexión «${policy.connection}» cambió o no existe; revísala y vuelve a activarlas (forja notificaciones activar)`,
      );
    }
    const sent = this.sentKeys();
    const out: string[] = [];
    for (const item of items) {
      const key = keyOf(item);
      if (sent.has(key)) continue;
      try {
        const proposed = this.actions.propose({ type: NOTIFY_OPERATION, connection: policy.connection, params: this.paramsFor(item, policy), origin: 'notificaciones' });
        this.actions.approve(proposed.action_id, proposed.hash, POLICY_ACTOR);
        const done = await this.actions.execute(proposed.action_id, secret);
        this.emit(NEV.sent, { key, action_id: done.action_id, state: done.state, kind: item.kind, id: item.id }, `notificar:${key}`);
        out.push(done.state === 'confirmada' ? `✉ aviso enviado: ${item.kind} ${item.id}` : `⚠ aviso de ${item.id}: ${done.state} (${done.result?.detail ?? 'sin detalle'})`);
      } catch (error) {
        out.push(...this.warnOnce(`err:${key}`, `⚠ no se pudo avisar de ${item.id}: ${(error as Error).message}`));
      }
    }
    return out;
  }

  private sentKeys(): Set<string> {
    const rows = this.store.db.prepare('SELECT payload FROM events WHERE type = ?').all(NEV.sent) as { payload: string }[];
    return new Set(rows.map((r) => (JSON.parse(r.payload) as { key: string }).key));
  }

  private warnOnce(id: string, line: string): string[] {
    if (this.warned.has(id)) return [];
    this.warned.add(id);
    return [line];
  }

  private emit(type: string, payload: object, requestId = newId('req')): void {
    this.store.execute({ request_id: requestId, type, input: payload }, () => ({
      result: null,
      events: [{ type, aggregate_type: 'notificaciones', aggregate_id: 'notificaciones', payload: payload as Record<string, unknown> }],
    }));
  }
}

/** Same item, same text → notified once; a new question on the same task is a new notice. */
export const keyOf = (item: Notice): string => createHash('sha256').update(`${item.kind}\0${item.id}\0${item.text}`).digest('hex').slice(0, 20);
