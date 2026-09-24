import { emitKeypressEvents } from 'node:readline';
import { dependencyLines, FILTER_LABEL, TASK_FILTERS } from '../run/describe.js';
import type { RunSnapshot, TaskView } from '../run/snapshot.js';
import { screen as ansi, colorsEnabled, type Paint, painter } from './ansi.js';
import { type BoardModel, renderBoard, type TextScreen, textBodyRows, textScroll, visibleTasks } from './board.js';

/** An external action waiting for approval, as the board shows it (preview without secrets). */
export type PendingAction = { id: string; hash: string; title: string; preview: string[] };

/**
 * Everything the board needs from the rest of Forja (dependency inversion: the
 * board knows nothing about SQLite, Git or processes). The CLI wires a real
 * source; tests pass a fake one.
 */
export interface BoardSource {
  readonly project: string;
  snapshot(): RunSnapshot | null;
  runLog(runId: string): string[];
  runnerAlive(): boolean;
  taskDetail(task: TaskView): string[];
  taskLog(task: TaskView): string[];
  taskContext(task: TaskView): string[];
  taskDiff(task: TaskView): Promise<string[]>;
  /** Mutations go through the same domain functions as the CLI. They throw with a user message. */
  answer(task: TaskView, text: string): void;
  retry(task: TaskView, note: string | null): void;
  togglePause(task: TaskView): string;
  stop(): string;
  /** Plan summary shown before approving: the same data the panel shows (MEJORAS 6.4). */
  planSummary(): string[];
  approvePlan(): string;
  pendingActions(): PendingAction[];
  /** Approves exactly the preview the user saw (`hash`); executing stays in the terminal with the vault. */
  approveAction(id: string, hash: string): string;
}

const YES = /^s[ií]?$/i;

export type Key = { name?: string; ctrl?: boolean; sequence?: string };

type PromptAction = (value: string) => string | Promise<string>;

export class BoardApp {
  readonly model: BoardModel;
  private promptAction: PromptAction | null = null;
  /** Re-reads the content of an open text screen (logs follow the agent live). */
  private textSource: (() => string[] | Promise<string[]>) | null = null;
  private flashUntil = 0;

  constructor(
    private readonly source: BoardSource,
    private readonly size: () => { width: number; height: number },
    private readonly now: () => number = Date.now,
  ) {
    this.model = { project: source.project, snapshot: null, selected: 0, runLog: [], runnerAlive: false, screen: { kind: 'principal' }, prompt: null, flash: null, now: now(), filter: 'todas' };
  }

  async refresh(): Promise<void> {
    const m = this.model;
    m.now = this.now();
    m.snapshot = this.source.snapshot();
    m.runnerAlive = this.source.runnerAlive();
    m.runLog = m.snapshot?.run ? this.source.runLog(m.snapshot.run.run_id) : [];
    m.selected = Math.min(m.selected, Math.max(0, visibleTasks(m).length - 1));
    if (m.flash && m.now > this.flashUntil) m.flash = null;
    if (m.screen.kind === 'texto' && this.textSource) {
      m.screen.lines = await this.textSource();
      if (m.screen.search) m.screen.hits = hitsOf(m.screen.lines, m.screen.search);
    }
  }

  render(paint: Paint): string[] {
    const { width, height } = this.size();
    return renderBoard(this.model, width, height, paint);
  }

  private flash(text: string, ms = 4000): void {
    this.model.flash = text;
    this.flashUntil = this.now() + ms;
  }

  private selectedTask(): TaskView | undefined {
    return visibleTasks(this.model)[this.model.selected];
  }

  /** Selects `task` in the list, clearing the filter if it hides it. */
  private select(task: TaskView): void {
    if (!visibleTasks(this.model).includes(task)) this.model.filter = 'todas';
    this.model.selected = visibleTasks(this.model).indexOf(task);
  }

  private async openText(title: string, load: () => string[] | Promise<string[]>, follow = false, style: TextScreen['style'] = 'plain'): Promise<void> {
    this.textSource = load;
    const lines = await load();
    this.model.screen = { kind: 'texto', title, lines, scroll: 0, follow, style, search: null, hits: [] };
  }

  /** Walks the proposed actions one by one: «si» approves, anything else leaves it for later. */
  private async reviewActions(queue: PendingAction[]): Promise<void> {
    const next = queue[0];
    if (!next) {
      this.model.screen = { kind: 'principal' };
      this.textSource = null;
      return;
    }
    await this.openText(`Acción ${next.id} · ${next.title} (${queue.length} por revisar)`, () => next.preview);
    this.ask(`¿Aprobar ${next.id}? Escribe «si» para aprobar (otra cosa la deja pendiente):`, async (value) => {
      const msg = YES.test(value.trim()) ? this.source.approveAction(next.id, next.hash) : `${next.id} sigue pendiente`;
      await this.reviewActions(queue.slice(1));
      return msg;
    });
  }

  private ask(label: string, action: PromptAction): void {
    this.model.prompt = { label, value: '' };
    this.promptAction = action;
  }

  /** Returns false when the board should close. */
  async handleKey(str: string | undefined, key: Key): Promise<boolean> {
    const m = this.model;
    if (key.ctrl && key.name === 'c') return false;

    if (m.prompt) {
      if (key.name === 'escape') {
        m.prompt = null;
        this.promptAction = null;
      } else if (key.name === 'return' || key.name === 'enter') {
        const action = this.promptAction!;
        const value = m.prompt.value;
        m.prompt = null;
        this.promptAction = null;
        try {
          this.flash(await action(value));
        } catch (error) {
          this.flash(`✘ ${(error as Error).message}`, 6000);
        }
        await this.refresh();
      } else if (key.name === 'backspace') {
        m.prompt.value = [...m.prompt.value].slice(0, -1).join('');
      } else if (str && !key.ctrl && str >= ' ' && str !== '\x7f') {
        m.prompt.value += str;
      }
      return true;
    }

    if (m.screen.kind !== 'principal') return this.handleTextKey(str, key);

    const tasks = visibleTasks(m);
    const task = this.selectedTask();
    switch (key.name ?? str) {
      case 'q':
      case 'escape':
        return false;
      case 'up':
      case 'k':
        m.selected = Math.max(0, m.selected - 1);
        break;
      case 'down':
      case 'j':
        m.selected = Math.min(Math.max(0, tasks.length - 1), m.selected + 1);
        break;
      case 'pageup':
        m.selected = Math.max(0, m.selected - 10);
        break;
      case 'pagedown':
        m.selected = Math.min(Math.max(0, tasks.length - 1), m.selected + 10);
        break;
      case '?':
        m.screen = { kind: 'ayuda' };
        break;
      case 'return':
      case 'enter':
        if (task) await this.openText(`${task.id} · detalle`, () => this.source.taskDetail(this.selectedTask() ?? task));
        break;
      case 'l':
        if (task) await this.openText(`${task.id} · registro del agente`, () => this.source.taskLog(this.selectedTask() ?? task), true);
        break;
      case 'c':
        if (task) await this.openText(`${task.id} · instrucciones que recibió el agente`, () => this.source.taskContext(task));
        break;
      case 'd':
        if (task) await this.openText(`${task.id} · diferencias`, () => this.source.taskDiff(task), false, 'diff');
        break;
      case 'f': {
        m.filter = TASK_FILTERS[(TASK_FILTERS.indexOf(m.filter) + 1) % TASK_FILTERS.length]!;
        m.selected = 0;
        this.flash(`filtro: ${FILTER_LABEL[m.filter]}`, 2000);
        break;
      }
      case 'g':
        await this.openText('Dependencias', () => (this.model.snapshot ? dependencyLines(this.model.snapshot) : ['Todavía no hay plan.']));
        break;
      case 'p':
        if (!task) break;
        try {
          this.flash(this.source.togglePause(task));
        } catch (error) {
          this.flash(`✘ ${(error as Error).message}`, 6000);
        }
        break;
      case 'a': {
        if (!m.snapshot?.pending.some((p) => p.kind === 'aprobacion')) {
          this.flash('no hay un plan esperando aprobación');
          break;
        }
        await this.openText('Plan · aprobar', () => this.source.planSummary());
        this.ask('¿Aprobar el plan tal como lo ves? Escribe «si» para aprobar:', (value) => {
          m.screen = { kind: 'principal' };
          this.textSource = null;
          return YES.test(value.trim()) ? this.source.approvePlan() : 'el plan sigue sin aprobar';
        });
        break;
      }
      case 'x': {
        const queue = this.source.pendingActions();
        if (!queue.length) {
          this.flash('no hay acciones externas esperando aprobación');
          break;
        }
        await this.reviewActions(queue);
        break;
      }
      case 'r': {
        const all = m.snapshot?.tasks ?? [];
        const target = task?.state === 'esperando_respuesta' ? task : all.find((t) => t.state === 'esperando_respuesta');
        if (!target) {
          this.flash('ninguna tarea tiene preguntas para ti');
          break;
        }
        this.select(target);
        this.ask(`Respuesta para ${target.id} (${(target.exec.question ?? '').split('\n')[0]!.slice(0, 60)}):`, (value) => {
          if (!value.trim()) throw new Error('respuesta vacía: no se envió');
          this.source.answer(target, value.trim());
          return `✔ respuesta enviada: ${target.id} vuelve a la cola${this.model.runnerAlive ? '' : ' (retoma con forja run)'}`;
        });
        break;
      }
      case 't': {
        if (task?.state !== 'bloqueada') {
          this.flash('elige una tarea bloqueada para reintentarla');
          break;
        }
        this.ask(`Reintentar ${task.id}. Nota para el agente (enter = sin nota, esc = cancelar):`, (value) => {
          this.source.retry(task, value.trim() || null);
          return `✔ ${task.id} vuelve a la cola`;
        });
        break;
      }
      case 's':
        if (!m.runnerAlive) {
          this.flash('no hay un forja run activo');
          break;
        }
        this.ask('¿Detener el run? Los agentes en curso terminan y se retoma con forja run. Escribe «si» para confirmar:', (value) => {
          if (!YES.test(value.trim())) return 'no se detuvo';
          return this.source.stop();
        });
        break;
      default:
        break;
    }
    return true;
  }

  private handleTextKey(str: string | undefined, key: Key): boolean {
    const m = this.model;
    if (m.screen.kind === 'ayuda') {
      m.screen = { kind: 'principal' };
      return true;
    }
    const s = m.screen as TextScreen;
    const { height } = this.size();
    const page = textBodyRows(height);
    const current = textScroll(s, height);
    const maxScroll = Math.max(0, s.lines.length - page);
    const go = (to: number) => {
      s.scroll = Math.min(Math.max(0, to), maxScroll);
      s.follow = s.scroll >= maxScroll && s.follow;
    };
    // Next/previous mark; when the view cannot move (the mark is on the last page), wrap around.
    const jump = (marks: number[], forward: boolean) => {
      const target = forward ? following(marks, current) : previous(marks, current);
      if (target === undefined) return;
      s.follow = false;
      go(target);
      if (s.scroll === current) go(forward ? marks[0]! : marks.at(-1)!);
    };
    switch (key.name ?? str) {
      case 'q':
      case 'escape':
      case 'left':
        m.screen = { kind: 'principal' };
        this.textSource = null;
        break;
      case 'up':
      case 'k':
        s.follow = false;
        go(current - 1);
        break;
      case 'down':
      case 'j':
        go(current + 1);
        break;
      case 'pageup':
        s.follow = false;
        go(current - page);
        break;
      case 'pagedown':
      case 'space':
        go(current + page);
        break;
      case 'g':
        if (str === 'G') {
          s.follow = true;
          go(maxScroll);
        } else {
          s.follow = false;
          go(0);
        }
        break;
      case '/':
        this.ask('Buscar:', (value) => {
          s.search = value.trim() || null;
          s.hits = s.search ? hitsOf(s.lines, s.search) : [];
          if (!s.search) return 'búsqueda borrada';
          const first = s.hits.find((i) => i >= current) ?? s.hits[0];
          if (first === undefined) return `«${s.search}» no aparece`;
          s.follow = false;
          go(first);
          return `«${s.search}»: ${s.hits.length} línea(s)`;
        });
        break;
      case 'n':
        jump(s.hits ?? [], str !== 'N');
        break;
      case ']':
        jump(fileStarts(s), true);
        break;
      case '[':
        jump(fileStarts(s), false);
        break;
      default:
        break;
    }
    return true;
  }
}

/** Lines (0-based) containing `term`, case-insensitive. */
export function hitsOf(lines: string[], term: string): number[] {
  const t = term.toLowerCase();
  return lines.flatMap((l, i) => (l.toLowerCase().includes(t) ? [i] : []));
}

const following = (marks: number[], at: number): number | undefined => marks.find((i) => i > at) ?? marks[0];
const previous = (marks: number[], at: number): number | undefined => [...marks].reverse().find((i) => i < at) ?? marks.at(-1);
const fileStarts = (s: TextScreen): number[] => (s.style === 'diff' ? s.lines.flatMap((l, i) => (l.startsWith('diff --git') ? [i] : [])) : []);

export type BoardIo = { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };

/**
 * Full-screen interactive loop. Returns when the user quits or `until` settles
 * (e.g. the run launched by the same `forja run --tablero` finished).
 */
export async function runBoard(source: BoardSource, opts: { refreshMs?: number; until?: Promise<unknown>; io?: BoardIo } = {}): Promise<void> {
  const { stdin, stdout } = opts.io ?? { stdin: process.stdin, stdout: process.stdout };
  const paint = painter(colorsEnabled());
  const app = new BoardApp(source, () => ({ width: stdout.columns || 80, height: stdout.rows || 24 }));
  let drawing = false;
  const draw = async () => {
    if (drawing) return;
    drawing = true;
    try {
      try {
        await app.refresh();
      } catch (error) {
        // Keep showing the last good state; the problem is visible, not swallowed.
        app.model.flash = `⚠ no se pudo actualizar: ${(error as Error).message}`;
      }
      const lines = app.render(paint);
      stdout.write(`${ansi.home}${lines.map((l) => `${l}${ansi.clearLine}`).join('\n')}${ansi.clearBelow}`);
    } finally {
      drawing = false;
    }
  };

  emitKeypressEvents(stdin);
  const raw = stdin.isTTY;
  if (raw) stdin.setRawMode(true);
  stdin.resume();
  stdout.write(`${ansi.enterAlt}${ansi.hideCursor}`);

  await new Promise<void>((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      stdin.off('keypress', onKey);
      stdout.off('resize', onResize);
      resolve();
    };
    const onKey = (str: string | undefined, key: Key | undefined) => {
      void app.handleKey(str, key ?? {}).then((keep) => (keep ? draw() : close()));
    };
    const onResize = () => void draw();
    const timer = setInterval(() => void draw(), opts.refreshMs ?? 1000);
    stdin.on('keypress', onKey);
    stdout.on('resize', onResize);
    void opts.until?.finally(close);
    void draw();
  });

  stdout.write(`${ansi.showCursor}${ansi.leaveAlt}`);
  if (raw) stdin.setRawMode(false);
  stdin.pause();
}
