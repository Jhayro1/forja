import { type ChildProcess, spawn } from 'node:child_process';

export type LoginProvider = 'claude' | 'codex';
export type LoginStatus = 'iniciando' | 'esperando' | 'listo' | 'error' | 'cancelado';
export type LoginView = { proveedor: LoginProvider; estado: LoginStatus; url: string | null; pide_codigo: boolean; salida: string[]; mensaje: string | null };

/**
 * How each official CLI signs in without a terminal (checked in F0): both print a
 * sign-in URL. Claude then waits for the code shown after signing in, on stdin;
 * Codex listens on localhost:1455 and finishes by itself (WSL forwards localhost
 * to the Windows browser).
 */
export const LOGIN_COMMANDS: Record<LoginProvider, { file: string; args: string[]; asksCode: boolean }> = {
  claude: { file: 'claude', args: ['auth', 'login'], asksCode: true },
  codex: { file: 'codex', args: ['login'], asksCode: false },
};

const URL_RE = /https:\/\/\S+/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;
const MAX_MS = 10 * 60_000;

type Session = { view: LoginView; child: ChildProcess; timer: NodeJS.Timeout; codeSent: () => void };

/** Sign-in sessions of the provider CLIs, driven from the panel. One per provider. */
export class ProviderLogins {
  private readonly sessions = new Map<LoginProvider, Session>();

  constructor(
    private readonly commands = LOGIN_COMMANDS,
    private readonly maxMs = MAX_MS,
  ) {}

  start(provider: LoginProvider): LoginView {
    this.cancel(provider, true);
    const cmd = this.commands[provider];
    const view: LoginView = { proveedor: provider, estado: 'iniciando', url: null, pide_codigo: false, salida: [], mensaje: null };
    let codeSent = false;
    const child = spawn(cmd.file, cmd.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    const onText = (chunk: Buffer) => {
      const text = chunk.toString('utf8').replace(ANSI, '');
      for (const line of text.split('\n')) if (line.trim()) view.salida.push(line.trim());
      view.salida = view.salida.slice(-40);
      const url = URL_RE.exec(text)?.[0];
      if (url && !view.url) {
        view.url = url;
        view.estado = 'esperando';
        view.pide_codigo = cmd.asksCode;
      } else if (codeSent && view.estado === 'esperando' && text.trim()) {
        // Output after a code means it was rejected (Claude: «Invalid code…») and it waits for another.
        codeSent = false;
        view.pide_codigo = cmd.asksCode;
        view.mensaje = view.salida.at(-1) ?? null;
      }
    };
    child.stdout!.on('data', onText);
    child.stderr!.on('data', onText);
    child.on('error', (error) => {
      view.estado = 'error';
      view.mensaje = (error as NodeJS.ErrnoException).code === 'ENOENT' ? `${provider} no está instalado: instálalo primero` : error.message;
    });
    child.on('exit', (code) => {
      clearTimeout(session.timer);
      if (view.estado === 'cancelado' || view.estado === 'error') return;
      view.estado = code === 0 ? 'listo' : 'error';
      view.pide_codigo = false;
      view.mensaje = code === 0 ? 'sesión iniciada' : (view.salida.at(-1) ?? `terminó con código ${code}`);
    });
    const session: Session = {
      view,
      child,
      timer: setTimeout(() => this.cancel(provider), this.maxMs),
      codeSent: () => {
        codeSent = true;
      },
    };
    session.timer.unref();
    this.sessions.set(provider, session);
    return view;
  }

  get(provider: LoginProvider): LoginView | null {
    return this.sessions.get(provider)?.view ?? null;
  }

  submitCode(provider: LoginProvider, code: string): LoginView {
    const s = this.sessions.get(provider);
    if (s?.view.estado !== 'esperando') throw new Error('no hay un inicio de sesión esperando un código');
    if (!s.view.pide_codigo) throw new Error(`${provider} no pide código: termina de iniciar sesión en el navegador`);
    const clean = code.trim();
    if (!/^[\w#.~-]{4,4096}$/.test(clean)) throw new Error('ese código no tiene el formato esperado');
    s.child.stdin!.write(`${clean}\n`);
    s.codeSent();
    s.view.pide_codigo = false;
    s.view.mensaje = 'verificando el código…';
    return s.view;
  }

  cancel(provider: LoginProvider, quiet = false): LoginView | null {
    const s = this.sessions.get(provider);
    if (!s) return null;
    clearTimeout(s.timer);
    if (s.view.estado === 'iniciando' || s.view.estado === 'esperando') {
      s.view.estado = 'cancelado';
      s.view.mensaje = quiet ? null : 'cancelado';
      s.child.kill('SIGTERM');
    }
    return s.view;
  }

  close(): void {
    for (const p of [...this.sessions.keys()]) this.cancel(p, true);
  }
}
