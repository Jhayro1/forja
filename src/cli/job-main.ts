import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MailService, panelLink } from '../notify/mail.js';
import { forjaHome } from '../registry/home.js';
import { currentIdentity } from '../registry/lock.js';
import { tailLines } from './jobs.js';

/**
 * Watches ONE panel job (a `forja …` command or an install) outside the panel's
 * process: the panel can close or restart while a run keeps going. Reads
 * <dir>/orden.json, writes its identity, streams output to <dir>/salida.log and
 * leaves <dir>/resultado.json when the command ends. SIGINT/SIGTERM are passed
 * on to the command's whole process group (for `forja run`, SIGINT = orderly stop).
 */
const dir = process.argv[2];
if (!dir) throw new Error('uso: job-main <carpeta del trabajo>');

const order = JSON.parse(readFileSync(join(dir, 'orden.json'), 'utf8')) as { file: string; args: string[]; cwd: string };
const writeJson = (name: string, data: unknown) => {
  writeFileSync(join(dir, `${name}.tmp`), JSON.stringify(data));
  renameSync(join(dir, `${name}.tmp`), join(dir, name));
};
writeJson('proceso.json', currentIdentity());

const log = openSync(join(dir, 'salida.log'), 'a', 0o600);
const child = spawn(order.file, order.args, {
  cwd: order.cwd,
  stdio: ['ignore', log, log],
  detached: true,
  env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
});
closeSync(log);
// The command leads its own process group: a forced cancel kills the whole group directly.
if (child.pid) writeJson('hijo.json', { pid: child.pid });

const forward = (signal: NodeJS.Signals) => {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

/** Email notice when the job ends (v3 §5.6); the result is already on disk, so a slow SMTP delays nothing. */
async function notify(code: number | null, signal: string | null): Promise<void> {
  try {
    const meta = JSON.parse(readFileSync(join(dir!, 'trabajo.json'), 'utf8')) as { tipo: string; titulo: string };
    const ok = code === 0;
    const state = ok ? 'terminó bien' : signal ? 'se detuvo' : 'terminó con error';
    const lines = tailLines(join(dir!, 'salida.log'), 16 * 1024).slice(-15);
    await new MailService(forjaHome()).notice(meta.tipo === 'run' ? 'runs' : 'trabajos', {
      asunto: `Forja · ${meta.titulo}: ${state}`,
      texto: `Proyecto: ${basename(order.cwd)}\nTrabajo: ${meta.titulo}\nResultado: ${state}${code !== null ? ` (código ${code})` : ''}\n\nÚltimas líneas:\n${lines.join('\n')}${panelLink()}`,
    });
  } catch {
    // A notice never changes the job's result.
  }
}

child.on('error', (error) => {
  writeJson('resultado.json', { codigo: 127, senal: null, fin: new Date().toISOString(), detalle: error.message });
  void notify(127, null).finally(() => process.exit(0));
});
child.on('exit', (code, signal) => {
  writeJson('resultado.json', { codigo: code, senal: signal, fin: new Date().toISOString() });
  void notify(code, signal).finally(() => process.exit(0));
});
