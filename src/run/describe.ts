import { TEXTOS } from '../i18n/textos.js';
import type { PlanTask } from '../plan/plan.js';
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
  return `${s.integrated}/${s.total} integradas · ${running} agente(s) trabajando`;
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
