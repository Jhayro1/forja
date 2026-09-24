import { TEXTOS } from '../i18n/textos.js';
import { taskMinutes } from '../plan/estimate.js';
import { type PlanTask, waves } from '../plan/plan.js';
import { etaLabel } from './eta.js';
import { compactTokens, elapsed, type RunSnapshot, type TaskView } from './snapshot.js';

/**
 * Plain-text descriptions shared by the CLI and the terminal board, so both
 * show the same words for the same state.
 */

export const STATE_LABEL: Record<string, string> = TEXTOS.estadoTarea;
export const STATE_ICON: Record<string, string> = TEXTOS.iconoEstado;

export const modelOf = (t: TaskView): string => (t.exec.provider ? `${t.exec.provider}:${t.exec.model ?? '?'}` : '—');

/** Short «what is it doing» line for a task. */
export function taskActivityLine(t: TaskView, now = Date.now()): string {
  if (t.state === 'ejecutando' || t.state === 'reservada') {
    const a = t.activity;
    const tokens = a?.tokensKind === 'estimado' ? `≈${compactTokens(a.tokens)}` : compactTokens(a?.tokens ?? null);
    return `${elapsed(a?.startedAt ?? null, now)} ${tokens} tok › ${a?.current ?? 'arrancando'}`;
  }
  if (t.state === 'esperando_respuesta') return t.exec.question?.split('\n')[0] ?? '';
  if (t.state === 'bloqueada') return t.exec.last_error ?? '';
  if (t.state === 'pendiente') return t.dependsOn.length ? `← ${t.dependsOn.join(', ')}` : '';
  if (t.state === 'lista' && t.exec.quality_failures > 0) return `reintento ${t.exec.quality_failures + 1}: ${t.exec.last_error ?? ''}`;
  if (t.state === 'integrada' && t.exec.integrated_sha) return `en ${t.exec.integrated_sha.slice(0, 8)}`;
  return '';
}

export function progressLine(s: RunSnapshot): string {
  const running = s.tasks.filter((t) => t.state === 'reservada' || t.state === 'ejecutando').length;
  return `${s.integrated}/${s.total} integradas · ${running} agente(s) trabajando${s.eta ? ` · ${etaLabel(s.eta)}` : ''}`;
}

export function taskDetailLines(t: TaskView, def: PlanTask | undefined): string[] {
  const e = t.exec;
  const steps = (JSON.parse(e.steps ?? '[]') as { paso: string; ok: boolean; detalle?: string }[]).map(
    (s) => `  ${s.ok ? '✔' : '✘'} ${s.paso}${s.detalle && !s.ok ? `: ${s.detalle.split('\n')[0]}` : ''}`,
  );
  const files = JSON.parse(e.files ?? '[]') as string[];
  const lines = [
    `${t.id} · ${t.title}`,
    `Estado: ${STATE_LABEL[t.state] ?? t.state} (${t.state})`,
    ...(def
      ? [
          `Tipo: ${def.tipo} · complejidad ${def.complejidad}${def.red ? ' · usa red' : ''}`,
          `Objetivo: ${def.objetivo}`,
          ...(def.criterios.length ? [`Criterios: ${def.criterios.join(', ')}`] : []),
          ...(def.depende_de.length ? [`Depende de: ${def.depende_de.join(', ')}`] : []),
          ...(def.escribe.length ? [`Puede escribir: ${def.escribe.join(', ')}`] : []),
        ]
      : []),
    '',
    `Intento: ${e.attempt} · fallos de calidad: ${e.quality_failures} · nivel: ${e.level ?? '—'}`,
    `Modelo: ${modelOf(t)}`,
    `Base: ${e.base_sha?.slice(0, 12) ?? '—'} · candidato: ${e.candidate_sha?.slice(0, 12) ?? '—'} · integrado: ${e.integrated_sha?.slice(0, 12) ?? '—'}`,
    ...(t.activity ? [`Actividad: ${taskActivityLine(t)}`] : []),
    ...(files.length ? ['', 'Archivos cambiados:', ...files.map((f) => `  ${f}`)] : []),
    ...(steps.length ? ['', 'Verificación:', ...steps] : []),
    ...(e.question ? ['', 'Pregunta del agente:', ...e.question.split('\n').map((l) => `  ${l}`)] : []),
    ...(e.answer ? ['Tu respuesta:', ...e.answer.split('\n').map((l) => `  ${l}`)] : []),
    ...(e.feedback
      ? [
          '',
          'Indicaciones para el próximo intento:',
          ...e.feedback
            .split('\n')
            .slice(0, 30)
            .map((l) => `  ${l}`),
        ]
      : []),
    ...(e.last_error ? ['', `Último error: ${e.last_error}`] : []),
  ];
  return lines;
}

/** Task filters of the board (MEJORAS 6.2). */
export const TASK_FILTERS = ['todas', 'activas', 'para_ti', 'pendientes', 'terminadas'] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];
export const FILTER_LABEL: Record<TaskFilter, string> = { todas: 'todas', activas: 'en curso', para_ti: 'esperan algo de ti', pendientes: 'por empezar', terminadas: 'terminadas' };

export function matchesFilter(t: TaskView, f: TaskFilter): boolean {
  switch (f) {
    case 'todas':
      return true;
    case 'activas':
      return ['reservada', 'ejecutando', 'verificando', 'verificada', 'integrando'].includes(t.state);
    case 'para_ti':
      return ['esperando_respuesta', 'bloqueada', 'pausada'].includes(t.state);
    case 'pendientes':
      return t.state === 'pendiente' || t.state === 'lista';
    case 'terminadas':
      return ['integrada', 'invalidada', 'cancelada'].includes(t.state);
  }
}

/**
 * Dependencies as text (MEJORAS 6.3): waves with their current state, the
 * critical path of what is left (the chain that decides when the run ends),
 * what waits on what, and which tasks unblock the most work.
 */
export function dependencyLines(s: RunSnapshot): string[] {
  const plan = s.plan;
  if (!plan) return ['Todavía no hay plan.'];
  const state = new Map(s.tasks.map((t) => [t.id, t.state]));
  const label = (id: string) => `${STATE_ICON[state.get(id) ?? 'pendiente'] ?? '·'} ${id}`;
  const done = (id: string) => ['integrada', 'invalidada', 'cancelada'].includes(state.get(id) ?? '');
  const byId = new Map(plan.tareas.map((t) => [t.id, t]));
  const out = ['Olas del plan (estado actual):'];
  waves(plan.tareas).forEach((w, i) => out.push(`  Ola ${i + 1}: ${w.map((id) => `${label(id)} ${byId.get(id)?.titulo ?? ''}`.trim()).join('  ·  ')}`));

  // Longest remaining chain by estimated minutes.
  const memo = new Map<string, { minutes: number; chain: string[] }>();
  const longest = (id: string): { minutes: number; chain: string[] } => {
    const known = memo.get(id);
    if (known) return known;
    const t = byId.get(id)!;
    const own = done(id) ? 0 : taskMinutes(t);
    const next = plan.tareas.filter((x) => x.depende_de.includes(id)).map((x) => longest(x.id));
    const best = next.sort((a, b) => b.minutes - a.minutes)[0] ?? { minutes: 0, chain: [] };
    const r = { minutes: own + best.minutes, chain: done(id) ? best.chain : [id, ...best.chain] };
    memo.set(id, r);
    return r;
  };
  const roots = plan.tareas.filter((t) => t.depende_de.every((d) => done(d) || !byId.has(d)) && !done(t.id));
  const critical = roots.map((t) => longest(t.id)).sort((a, b) => b.minutes - a.minutes)[0];
  out.push('');
  out.push(
    critical?.chain.length ? `Camino crítico de lo que falta: ${critical.chain.join(' → ')} (~${Math.round(critical.minutes)} min sin reintentos extra)` : 'Camino crítico: no queda nada por hacer.',
  );

  const waiting = plan.tareas
    .filter((t) => !done(t.id))
    .flatMap((t) => {
      const missing = t.depende_de.filter((d) => !done(d));
      return missing.length ? [`  ${t.id} espera a ${missing.map((d) => `${d} (${STATE_LABEL[state.get(d) ?? 'pendiente'] ?? state.get(d)})`).join(', ')}`] : [];
    });
  out.push('', waiting.length ? 'Esperando:' : 'Nada espera a otra tarea.', ...waiting);
  const unblocks = plan.tareas
    .map((t) => ({ id: t.id, next: plan.tareas.filter((x) => x.depende_de.includes(t.id)).map((x) => x.id) }))
    .filter((x) => x.next.length && !done(x.id))
    .sort((a, b) => b.next.length - a.next.length);
  if (unblocks.length) out.push('', 'Desbloquean a otras:', ...unblocks.map((u) => `  ${u.id} → ${u.next.join(', ')}`));
  return out;
}
