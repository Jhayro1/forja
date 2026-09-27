import type { Actividad, Estimacion, Tarea } from './types';

export function elapsed(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '?';
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

function activity(a: Actividad = {}): string {
  const tk = a.tokensKind === 'estimado' ? `≈${tokens(a.tokens)} tok (estimado)` : a.tokensKind === 'medido' ? `${tokens(a.tokens)} tok` : '? tok';
  return `${elapsed(a.startedAt)} · ${tk} · ${a.current || 'arrancando'}`;
}

/** One line of what a task is doing right now. */
export function activityText(t: Tarea): string {
  if (t.estado === 'ejecutando' || t.estado === 'reservada') return activity(t.actividad);
  if (t.estado === 'esperando_respuesta') return t.pregunta ?? '';
  if (t.estado === 'bloqueada') return t.error ?? '';
  return t.error && t.estado === 'lista' ? `reintento: ${t.error}` : '';
}

export function estimateText(e: Estimacion | null | undefined): string | null {
  if (!e) return null;
  const parts = [`~${e.minutos_en_paralelo} min con ${e.paralelo} agentes a la vez`, `~${tokens(e.tokens_total)} tokens`];
  if (e.costo_equivalente_usd !== null) parts.push(`~US$ ${e.costo_equivalente_usd.toFixed(2)} equivalente`);
  return `Estimación (sin calibrar): ${parts.join(' · ')}`;
}

/** Only real https links (they come from a CLI's output). */
export function safeUrl(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url) ? url : null;
}
