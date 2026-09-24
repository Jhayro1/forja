import { STATE_ICON, STATE_LABEL, modelOf, progressLine, taskActivityLine } from '../run/describe.js';
import { agentTasks, compactTokens, type RunSnapshot, type TaskView } from '../run/snapshot.js';
import type { ChangePhase } from '../store/planning-projections.js';
import { fit, sanitize, type Paint, type Style } from './ansi.js';

/**
 * Pure rendering of the terminal board (V2-039): model in, lines out. The
 * interactive shell (app.ts) owns input and timing; this file owns layout, so
 * it can be tested at any size without a terminal.
 */

export type TextScreen = { kind: 'texto'; title: string; lines: string[]; scroll: number; follow: boolean };

export type Screen = { kind: 'principal' } | { kind: 'ayuda' } | TextScreen;

export type BoardModel = {
  project: string;
  snapshot: RunSnapshot | null;
  /** Index into snapshot.tasks. */
  selected: number;
  runLog: string[];
  /** Whether a `forja run` process is alive for this project. */
  runnerAlive: boolean;
  screen: Screen;
  /** Inline input or confirmation at the bottom. */
  prompt: { label: string; value: string } | null;
  flash: string | null;
  now: number;
};

export const KEYS_MAIN = '[↑↓] mover [enter] detalle [l]ogs [d]iff [c]ontexto [r]esponder [t] reintentar [s] detener [?] ayuda [q] salir';
/** For narrow terminals (80 columns): the rest is in the help screen. */
export const KEYS_MAIN_SHORT = '[↑↓] [enter] [l]ogs [d]iff [r]esponder [s] detener [?] ayuda [q] salir';
export const KEYS_TEXT = '[↑↓/PgUp/PgDn] desplazar  [g/G] inicio/fin  [q/esc] volver';

export const HELP_LINES = [
  'Tablero de Forja',
  '',
  'Muestra el cambio en curso y su ejecución en vivo. Lee el mismo estado que',
  '`forja estado`; puede abrirse mientras `forja run` trabaja en otra terminal.',
  '',
  'Teclas en la vista principal:',
  '  ↑ ↓ / k j     elegir tarea',
  '  enter         detalle: objetivo, criterios, intentos, base, verificación',
  '  l             registro en vivo del agente de la tarea',
  '  d             diferencia (diff) del candidato de la tarea',
  '  c             instrucciones exactas que recibió el agente',
  '  r             responder la pregunta de la tarea elegida',
  '  t             reintentar una tarea bloqueada (con nota opcional)',
  '  s             detener el run: no lanza tareas nuevas; los agentes en curso',
  '                siguen y se retoman con forja run',
  '  q             salir (el run sigue si lo lanzaste con forja run)',
  '',
  'Estados (texto además de color):',
  ...Object.entries(STATE_LABEL).map(([k, v]) => `  ${STATE_ICON[k]} ${k.padEnd(20)} ${v}`),
];

const STATE_STYLE: Partial<Record<string, Style>> = {
  integrada: 'green',
  ejecutando: 'cyan',
  reservada: 'cyan',
  verificando: 'blue',
  verificada: 'blue',
  integrando: 'blue',
  esperando_respuesta: 'yellow',
  bloqueada: 'red',
  pausada: 'yellow',
  invalidada: 'dim',
  cancelada: 'dim',
  pendiente: 'dim',
};

const PHASES: { phase: ChangePhase; label: string }[] = [
  { phase: 'descubrir', label: 'Descubrir' },
  { phase: 'especificar', label: 'Especificar' },
  { phase: 'dividir', label: 'Plan' },
  { phase: 'aprobar', label: 'Aprobar' },
  { phase: 'ejecutar', label: 'Ejecutar' },
  { phase: 'entregado', label: 'Entregado' },
];

function phaseLine(s: RunSnapshot, paint: Paint): string {
  const current = PHASES.findIndex((p) => p.phase === s.change.phase);
  return PHASES.map((p, i) => {
    if (s.change.phase === 'entregado' || i < current) return paint(`${p.label} ✔`, 'green');
    if (i === current) return paint(`${p.label} ●`, 'bold', 'cyan');
    return paint(p.label, 'dim');
  }).join('  ');
}

function rule(title: string, width: number, right = '', edge: [string, string] = ['├', '┤']): string {
  const left = `${edge[0]}─ ${title} `;
  const r = right ? ` ${right} ─${edge[1]}` : `─${edge[1]}`;
  const fill = Math.max(0, width - [...left].length - [...r].length);
  return fit(`${left}${'─'.repeat(fill)}${r}`, width);
}

const row = (text: string, width: number) => `│ ${fit(text, width - 4)} │`;

function taskRow(t: TaskView, width: number, now: number, paint: Paint, selected: boolean): string {
  const state = paint(`${STATE_ICON[t.state] ?? ' '} ${(STATE_LABEL[t.state] ?? t.state).padEnd(19)}`, STATE_STYLE[t.state] ?? 'dim');
  const head = `${selected ? '›' : ' '} ${t.id.padEnd(6)} ${fit(sanitize(t.title), 22)} ${state} ${fit(modelOf(t), 18)} `;
  const text = `${head}${sanitize(taskActivityLine(t, now))}`;
  return selected ? `│${paint(fit(` ${text}`, width - 3), 'inverse')} │` : row(text, width);
}

/** Window of `height` rows around `selected`, keeping it visible. */
export function windowAround(total: number, selected: number, height: number): [number, number] {
  if (total <= height) return [0, total];
  const start = Math.min(Math.max(0, selected - Math.floor(height / 2)), total - height);
  return [start, start + height];
}

function renderMain(m: BoardModel, width: number, height: number, paint: Paint): string[] {
  const s = m.snapshot;
  const out: string[] = [];
  if (!s) {
    out.push(rule(`Forja · ${m.project}`, width, '', ['┌', '┐']));
    out.push(row('No hay cambios todavía. Empieza con: forja planear "lo que quieres construir"', width));
    return out;
  }
  const runLabel = s.run ? `run ${s.run.run_id.slice(-8)} · ${s.run.state}${m.runnerAlive ? ' ●' : ''}` : 'sin run';
  out.push(rule(`Forja · ${m.project} · ${sanitize(s.change.title)}`, width, runLabel, ['┌', '┐']));
  out.push(row(phaseLine(s, paint), width));
  if (s.run) out.push(row(`${progressLine(s)}${s.run.detail ? ` · ${sanitize(s.run.detail)}` : ''}`, width));
  else out.push(row(`Siguiente paso: ${s.nextStep}`, width));

  // Fixed sections first, then the task list takes the remaining height.
  const agents = agentTasks(s);
  const agentLines = agents.length
    ? agents.map((t) => `${paint('▶', 'cyan')} ${t.id.padEnd(6)} ${fit(sanitize(t.title), 22)} ${fit(modelOf(t), 18)} ${sanitize(taskActivityLine(t, m.now))}`)
    : [paint(m.runnerAlive ? 'ningún agente trabajando en este momento' : 'nadie ejecutando: lanza o retoma con forja run', 'dim')];
  const pending = s.pending.slice(0, 4).map((p) => `${paint(p.kind === 'tarea_bloqueada' ? '✘' : '?', p.kind === 'tarea_bloqueada' ? 'red' : 'yellow')} ${p.id}: ${sanitize(p.text.split('\n')[0]!)}  → ${p.action}`);
  const usage = s.usage.length
    ? s.usage.map((u) => `${u.role} ${compactTokens(u.tokens)} tok (${u.calls})${u.costMicro !== null ? ` ≈US$ ${(u.costMicro / 1e6).toFixed(2)}` : ''}`).join(' · ')
    : 'sin consumo registrado en este run';
  const logLines = m.runLog.map(sanitize);

  const fixed = out.length + (1 + agentLines.length) + (pending.length ? 1 + pending.length : 0) + 2;
  // Rows left for the task list and the run log (each section also needs its rule).
  const available = Math.max(0, height - fixed - 1);
  const wantedTasks = Math.max(1, s.tasks.length);
  const wantedLog = logLines.length ? logLines.length + 1 : 0;
  let taskRows: number;
  let logRows: number;
  if (wantedTasks + wantedLog <= available) {
    // Everything fits: extra space goes to the task list as padding.
    logRows = logLines.length;
    taskRows = available - wantedLog;
  } else {
    logRows = logLines.length ? Math.min(logLines.length, Math.max(2, Math.floor(available / 4))) : 0;
    taskRows = Math.max(1, available - (logRows ? logRows + 1 : 0));
  }
  // Prefer showing the log over blank task rows.
  if (taskRows > wantedTasks && logLines.length > logRows) {
    const extra = Math.min(taskRows - wantedTasks, logLines.length - logRows);
    logRows += extra;
    taskRows -= extra;
  }

  out.push(rule(`Agentes (${agents.length})`, width));
  for (const l of agentLines) out.push(row(l, width));

  out.push(rule(`Tareas ${s.tasks.length ? `(${s.tasks.length})` : ''}`, width, s.tasks.length ? `${m.selected + 1}/${s.tasks.length}` : ''));
  if (s.tasks.length === 0) {
    out.push(row(s.plan ? `Plan de ${s.plan.tareas.length} tareas; todavía no se ejecuta. ${s.nextStep}` : `Siguiente paso: ${s.nextStep}`, width));
    for (let i = 1; i < taskRows; i++) out.push(row('', width));
  } else {
    const [from, to] = windowAround(s.tasks.length, m.selected, taskRows);
    for (let i = from; i < to; i++) out.push(taskRow(s.tasks[i]!, width, m.now, paint, i === m.selected));
    for (let i = to - from; i < taskRows; i++) out.push(row('', width));
  }

  if (pending.length) {
    out.push(rule(paint(`Pendiente de ti (${s.pending.length})`, 'yellow', 'bold'), width));
    for (const l of pending) out.push(row(l, width));
  }
  if (logRows) {
    out.push(rule('Registro', width));
    for (const l of logLines.slice(-logRows)) out.push(row(l, width));
  }
  out.push(rule('Consumo', width));
  out.push(row(usage, width));
  return out;
}

/** Body rows of a text screen at terminal height `height` (title, border and keys take 3). */
export const textBodyRows = (height: number): number => Math.max(1, height - 3);

function renderText(screen: TextScreen | { kind: 'ayuda' }, width: number, height: number): string[] {
  const title = screen.kind === 'ayuda' ? 'Ayuda' : screen.title;
  const source = screen.kind === 'ayuda' ? HELP_LINES : screen.lines;
  const body = textBodyRows(height);
  const scroll = screen.kind === 'texto' ? textScroll(screen, height) : 0;
  const range = source.length > body ? `${scroll + 1}-${Math.min(source.length, scroll + body)}/${source.length}` : '';
  const out = [rule(sanitize(title), width, range, ['┌', '┐'])];
  for (let i = 0; i < body; i++) {
    const l = source[scroll + i];
    out.push(row(l === undefined ? '' : sanitize(l), width));
  }
  out.push(`└${'─'.repeat(Math.max(0, width - 2))}┘`);
  return out;
}

/** Scroll position actually shown, so key handling clamps the same way. */
export function textScroll(screen: TextScreen, height: number): number {
  const maxScroll = Math.max(0, screen.lines.length - textBodyRows(height));
  return screen.follow ? maxScroll : Math.min(Math.max(0, screen.scroll), maxScroll);
}

export function renderBoard(m: BoardModel, width: number, height: number, paint: Paint): string[] {
  const w = Math.max(40, width);
  const h = Math.max(12, height);
  const bottom: string[] = [];
  let body: string[];
  if (m.screen.kind === 'principal') {
    const keys = [...KEYS_MAIN].length + 4 <= w ? KEYS_MAIN : KEYS_MAIN_SHORT;
    bottom.push(`└${fit(paint(` ${keys} `, 'dim'), w - 2)}┘`);
    if (m.prompt || m.flash) bottom.push('');
    body = renderMain(m, w, h - bottom.length, paint);
  } else {
    body = renderText(m.screen, w, h);
    bottom.push(fit(paint(KEYS_TEXT, 'dim'), w));
    body = body.slice(0, h - 1);
  }
  if (m.prompt) bottom.splice(-1, 1, fit(`${paint(m.prompt.label, 'bold')} ${m.prompt.value}█`, w));
  else if (m.flash && m.screen.kind === 'principal') bottom.splice(-1, 1, fit(paint(m.flash, 'yellow'), w));
  // Exactly h lines: the shell redraws in place without scrolling.
  const room = h - bottom.length;
  body = body.slice(0, room);
  while (body.length < room) body.splice(m.screen.kind === 'principal' ? body.length : body.length - 1, 0, row('', w));
  return [...body, ...bottom];
}
