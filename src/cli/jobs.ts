import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '../domain/ids.js';
import { isAlive, type ProcessIdentity } from '../registry/lock.js';

export const JOB_MAIN = fileURLToPath(new URL('./job-main.js', import.meta.url));
export const FORJA_BIN = fileURLToPath(new URL('./bin.js', import.meta.url));

export type JobCommand = { title: string; file: string; args: string[]; cwd: string };
export type JobState = 'corriendo' | 'ok' | 'error' | 'cancelado' | 'interrumpido';
export type JobView = { id: string; tipo: string; titulo: string; estado: JobState; inicio: string; fin: string | null; codigo: number | null; ultima_linea: string | null };

type Meta = { id: string; tipo: string; titulo: string; inicio: string };
type Result = { codigo: number | null; senal: string | null; fin: string; detalle?: string };

/** A just-spawned watcher has a few seconds to announce itself before it counts as lost. */
const STARTUP_GRACE_MS = 10_000;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Last `maxBytes` of a log, as clean lines (no colors, no carriage-return spinners). */
export function tailLines(path: string, maxBytes = 64 * 1024): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').replace(ANSI, '').split('\n');
    if (start > 0) lines.shift();
    while (lines.length && lines.at(-1) === '') lines.pop();
    return lines;
  } finally {
    closeSync(fd);
  }
}

/**
 * Long commands started from the panel (specify, divide, run, installs…). Each job
 * runs under its own watcher process (job-main) and lives in files, so it survives
 * the panel closing; its state is always read back from disk. One job at a time
 * per runner (one runner per project, plus one for the system).
 */
export class JobRunner {
  constructor(
    private readonly dir: string,
    private readonly watcher: string = JOB_MAIN,
    private readonly now: () => number = Date.now,
  ) {}

  private jobDir(id: string): string {
    if (!/^job_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error('trabajo inválido');
    return join(this.dir, id);
  }

  start(tipo: string, cmd: JobCommand): JobView {
    const running = this.list().find((j) => j.estado === 'corriendo');
    if (running) throw new Error(`ya hay un trabajo en curso («${running.titulo}»): espera a que termine o cancélalo`);
    const id = newId('job', this.now());
    const dir = join(this.dir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const meta: Meta = { id, tipo, titulo: cmd.title, inicio: new Date(this.now()).toISOString() };
    writeFileSync(join(dir, 'trabajo.json'), JSON.stringify(meta));
    writeFileSync(join(dir, 'orden.json'), JSON.stringify({ file: cmd.file, args: cmd.args, cwd: cmd.cwd }));
    const err = openSync(join(dir, 'vigilante.err'), 'a', 0o600);
    const watcher = spawn(process.execPath, [this.watcher, dir], { detached: true, stdio: ['ignore', 'ignore', err] });
    closeSync(err);
    watcher.unref();
    return this.view(id)!;
  }

  view(id: string): JobView | null {
    const dir = this.jobDir(id);
    const meta = readJson<Meta>(join(dir, 'trabajo.json'));
    if (!meta) return null;
    const result = readJson<Result>(join(dir, 'resultado.json'));
    const proc = readJson<ProcessIdentity>(join(dir, 'proceso.json'));
    const cancelled = existsSync(join(dir, 'cancelado'));
    let estado: JobState;
    if (result) estado = cancelled ? 'cancelado' : result.codigo === 0 ? 'ok' : 'error';
    else if (proc) estado = isAlive(proc) ? 'corriendo' : 'interrumpido';
    else estado = this.now() - Date.parse(meta.inicio) < STARTUP_GRACE_MS ? 'corriendo' : 'interrumpido';
    const last = tailLines(join(dir, 'salida.log'), 4096).at(-1) ?? result?.detalle ?? null;
    return { ...meta, estado, fin: result?.fin ?? null, codigo: result?.codigo ?? null, ultima_linea: last };
  }

  /** Most recent first. */
  list(limit = 15): JobView[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((n) => n.startsWith('job_'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((id) => this.view(id))
      .filter((j): j is JobView => j !== null);
  }

  output(id: string): string[] {
    return tailLines(join(this.jobDir(id), 'salida.log'));
  }

  /** First call asks for an orderly stop (SIGINT); `force` kills it. */
  cancel(id: string, force = false): JobView {
    const job = this.view(id);
    if (!job) throw new Error('ese trabajo no existe');
    if (job.estado !== 'corriendo') throw new Error('ese trabajo ya terminó');
    const proc = readJson<ProcessIdentity>(join(this.jobDir(id), 'proceso.json'));
    if (!proc || !isAlive(proc)) throw new Error('el trabajo todavía está arrancando; vuelve a intentar en un momento');
    writeFileSync(join(this.jobDir(id), 'cancelado'), new Date(this.now()).toISOString());
    const child = readJson<{ pid: number }>(join(this.jobDir(id), 'hijo.json'));
    if (force && child) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone: the watcher records the result.
      }
    } else process.kill(proc.pid, 'SIGINT');
    return this.view(id)!;
  }
}
