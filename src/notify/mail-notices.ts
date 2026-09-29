import { createHash } from 'node:crypto';
import { newId } from '../domain/ids.js';
import type { PendingItem } from '../run/snapshot.js';
import type { EventStore } from '../store/event-store.js';
import { type MailService, type Message, type NoticeKind, panelLink } from './mail.js';

export const MAIL_SENT = 'correo.enviado';

const alreadySent = (store: EventStore, key: string): boolean => Boolean(store.db.prepare('SELECT 1 FROM events WHERE type = ? AND aggregate_id = ? LIMIT 1').get(MAIL_SENT, key));

/**
 * Sends one notice per `key`, ever: the key is recorded as an event after sending, so a
 * restarted `forja run` or panel does not repeat it. Returns whether it went out.
 */
export async function mailOnce(store: EventStore, mail: MailService, kind: NoticeKind, key: string, message: Message, log?: (line: string) => void): Promise<boolean> {
  if (!mail.wants(kind) || alreadySent(store, key)) return false;
  if (!(await mail.notice(kind, message, log))) return false;
  store.execute({ request_id: newId('req'), type: 'registrar_correo', input: { key } }, () => ({
    result: null,
    events: [{ type: MAIL_SENT, aggregate_type: 'correo', aggregate_id: key, payload: { kind, asunto: message.asunto.slice(0, 200) } }],
  }));
  return true;
}

/** One email per new pending item of a run (its text is part of the key: a new question is a new notice). */
export async function mailPending(store: EventStore, mail: MailService, project: string, pending: PendingItem[], log?: (line: string) => void): Promise<number> {
  let sent = 0;
  for (const p of pending) {
    const key = `pendiente:${p.kind}:${p.id}:${createHash('sha256').update(p.text).digest('hex').slice(0, 16)}`;
    const ok = await mailOnce(
      store,
      mail,
      'pendientes',
      key,
      { asunto: `Forja · ${project}: ${p.id} espera tu respuesta`, texto: `Proyecto: ${project}\n${p.id}: ${p.text.slice(0, 1500)}\n\nQué hacer: ${p.action}${panelLink()}` },
      log,
    );
    if (ok) sent++;
  }
  return sent;
}
