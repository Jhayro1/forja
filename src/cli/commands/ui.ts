import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { type IdempotencyStore, MemoryIdempotencyStore, SqliteIdempotencyStore } from '../../api/idempotency.js';
import { accountsModule } from '../../api/modules/accounts.js';
import { connectionsModule } from '../../api/modules/connections.js';
import { jobsModule } from '../../api/modules/jobs.js';
import { mailModule } from '../../api/modules/mail.js';
import { memoryModule } from '../../api/modules/memory.js';
import { planningModule } from '../../api/modules/planning.js';
import { projectsModule } from '../../api/modules/projects.js';
import { runsModule } from '../../api/modules/runs.js';
import { settingsModule } from '../../api/modules/settings.js';
import { systemModule } from '../../api/modules/system.js';
import { workModule } from '../../api/modules/work.js';
import { OwnerAuth } from '../../api/owner-auth.js';
import { type ApiModule, ApiServer } from '../../api/server.js';
import { MailService } from '../../notify/mail.js';
import { forjaHome } from '../../registry/home.js';
import { Vault, vaultPaths } from '../../vault/vault.js';
import { CliError, EXIT, print } from '../context.js';
import { type BusyFlag, EngineConnectionsBackend, EngineMemoryBackend, EnginePlanningBackend, EngineRunsBackend } from '../engine-backend.js';
import type { EngineContext } from '../engine-context.js';
import { ProjectJobsBackend } from '../jobs-backend.js';
import { openBrowser } from '../open-browser.js';
import { PanelProjects } from '../panel-host.js';
import { RegistryProjectsBackend } from '../projects-backend.js';
import { vaultPassphrase } from '../secret-input.js';
import { ProjectSettingsBackend } from '../settings-backend.js';
import { MachineSystemBackend } from '../system-backend.js';
import { EngineWorkBackend } from '../work-backend.js';

/**
 * Modules the panel offers for a project. Each milestone adds its own module
 * here (connections in M5, memory in M6) without touching the server.
 */
export type PanelResources = {
  vault: Vault | null;
  /** Reopens the project (after forja.yaml changes). */
  reload: () => void;
  /** Holds the project open while in-process work (a planner turn) uses it. */
  busy: BusyFlag;
};
export type ModuleFactory = (ctx: EngineContext, res: PanelResources) => ApiModule;

/** One planning backend per open project: the chat and the action plans share its «thinking» state. */
const planners = new WeakMap<EngineContext, EnginePlanningBackend>();
function plannerFor(ctx: EngineContext, busy: BusyFlag): EnginePlanningBackend {
  let p = planners.get(ctx);
  if (!p) {
    p = new EnginePlanningBackend(ctx, busy);
    planners.set(ctx, p);
  }
  return p;
}

export const PANEL_MODULES: ModuleFactory[] = [
  (ctx) => runsModule(new EngineRunsBackend(ctx)),
  (ctx, res) => connectionsModule(new EngineConnectionsBackend(ctx, res.vault)),
  (ctx) => memoryModule(new EngineMemoryBackend(ctx)),
  (ctx, res) => planningModule(plannerFor(ctx, res.busy)),
  (ctx, res) => workModule(new EngineWorkBackend(ctx, plannerFor(ctx, res.busy))),
  (ctx) => jobsModule(new ProjectJobsBackend(ctx)),
  (ctx, res) => settingsModule(new ProjectSettingsBackend(ctx, res.reload)),
];

/** Modules that work without a project (system setup, choosing a project…). */
export type GlobalResources = { home: string; projects: PanelProjects; system: MachineSystemBackend };
export type GlobalModuleFactory = (res: GlobalResources) => ApiModule;
export const GLOBAL_MODULES: GlobalModuleFactory[] = [
  (res) => systemModule(res.system),
  (res) => accountsModule(res.system),
  (res) => mailModule(new MailService(res.home)),
  (res) => projectsModule(new RegistryProjectsBackend(res.home, res.projects)),
];

/** Replays by Idempotency-Key in the open project's database; in memory while there is none. */
function idempotencyFor(projects: PanelProjects): IdempotencyStore {
  const memory = new MemoryIdempotencyStore();
  const current = () => {
    const ctx = projects.context();
    return ctx ? new SqliteIdempotencyStore(ctx.store.db) : memory;
  };
  return { get: (key) => current().get(key), set: (key, answer) => current().set(key, answer) };
}

export type PanelOptions = {
  port?: number;
  vault: Vault | null;
  /** Server mode (`forja servidor`): listen on `host`, everything behind the owner login. */
  server?: { host: string; publicUrl: string; auth: OwnerAuth };
};

/** Starts the panel; returns its URL, a way to issue login links, and a stopper. */
export async function startPanel(opts: PanelOptions): Promise<{ url: string; link: () => string; projects: PanelProjects; stop: () => Promise<void> }> {
  const home = forjaHome();
  const projects: PanelProjects = new PanelProjects((ctx) =>
    PANEL_MODULES.map((f) =>
      f(ctx, {
        vault: opts.vault,
        reload: () => projects.select(ctx.checkout.checkout_id),
        busy: {
          set: (reason) => {
            projects.busy = reason;
          },
        },
      }),
    ),
  );
  projects.openDefault();
  const system = new MachineSystemBackend(home);
  const server = new ApiServer({
    global: GLOBAL_MODULES.map((f) => f({ home, projects, system })),
    project: projects,
    idempotency: idempotencyFor(projects),
    ...(opts.port ? { port: opts.port } : {}),
    ...(opts.server ? { host: opts.server.host, server: { auth: opts.server.auth, publicUrl: opts.server.publicUrl, trustProxy: process.env.FORJA_CONFIAR_PROXY !== '0' } } : {}),
  });
  const { url } = await server.listen();
  return {
    url,
    link: () => `${url}/#codigo=${server.sessions.issueCode()}`,
    projects,
    stop: async () => {
      await server.close();
      system.close();
      projects.close();
    },
  };
}

/**
 * Sends the owner's verification or reset code: by email when SMTP is configured, and
 * otherwise to the server log, which only whoever administers the server can read.
 */
function codeSender(home: string) {
  return async (to: string, purpose: 'verificar' | 'recuperar', code: string): Promise<'correo' | 'registro'> => {
    const what = purpose === 'verificar' ? 'verificar tu correo' : 'cambiar tu contraseña';
    const mail = new MailService(home);
    if (mail.settings()) {
      try {
        await mail.sendTo(to, { asunto: `Forja · tu código para ${what}`, texto: `Tu código es ${code}.\nVence en 15 minutos. Si no lo pediste, ignora este correo.` });
        return 'correo';
      } catch (error) {
        print(`⚠ no se pudo enviar el código por correo: ${(error as Error).message}`);
      }
    }
    print(`[forja] código para ${what} (${to}): ${code} — vence en 15 minutos`);
    return 'registro';
  };
}

export function registerUiCommands(program: Command): void {
  program
    .command('servidor')
    .description('sirve el panel en un servidor (Doko…) con login del dueño: sin sesión no responde ninguna ruta')
    .option('--puerto <n>', 'puerto (por defecto $PORT o 8080)', (v) => Number.parseInt(v, 10))
    .option('--host <ip>', 'dirección en la que escuchar', '0.0.0.0')
    .action(async (opts: { puerto?: number; host: string }) => {
      const publicUrl = process.env.FORJA_URL_PUBLICA;
      const owner = process.env.FORJA_DUENO_EMAIL;
      if (!publicUrl || !/^https?:\/\/[^/]+\/?$/.test(publicUrl)) throw new CliError('define FORJA_URL_PUBLICA con la URL pública, por ejemplo https://forja.tudominio.com', EXIT.input);
      if (!owner) throw new CliError('define FORJA_DUENO_EMAIL con el correo del dueño: es el único que puede registrarse y entrar', EXIT.input);
      const port = opts.puerto ?? Number.parseInt(process.env.PORT ?? '8080', 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError('el puerto debe estar entre 1 y 65535');
      const home = forjaHome();
      let auth: OwnerAuth;
      try {
        auth = new OwnerAuth(home, owner, codeSender(home));
      } catch (error) {
        throw new CliError((error as Error).message, EXIT.input);
      }
      // The owner's browser is elsewhere: provider sign-ins use device codes (see provider-login.ts).
      process.env.FORJA_LOGIN_REMOTO = '1';
      const panel = await startPanel({ vault: null, port, server: { host: opts.host, publicUrl, auth } });
      print(`Forja (modo servidor) escuchando en ${opts.host}:${port} · ${panel.url}`);
      print(auth.status().registro_abierto ? `Registro abierto sólo para ${auth.ownerEmail}: entra a ${panel.url}/login y crea la cuenta.` : 'Registro cerrado. Sólo el dueño puede entrar.');
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      print('Servidor detenido.');
      await panel.stop();
    });

  program
    .command('ui')
    .description('abre el panel web local (sólo en esta máquina: 127.0.0.1)')
    .option('--puerto <n>', 'puerto (por defecto, uno libre)', (v) => Number.parseInt(v, 10))
    .option('--boveda', 'abre la bóveda para ejecutar acciones aprobadas desde el panel (se cierra sola por inactividad)')
    .option('--boveda-minutos <n>', 'minutos sin uso tras los que se cierra la bóveda', (v) => Number.parseInt(v, 10), 15)
    .option('--sin-navegador', 'no abre el navegador (sólo muestra el enlace)')
    .option('--salir-sin-entrada', 'termina cuando se cierra la entrada estándar (así lo usa la app de escritorio: si la app se cierra, el panel también)')
    .action(async (opts: { puerto?: number; boveda?: boolean; bovedaMinutos: number; sinNavegador?: boolean; salirSinEntrada?: boolean }) => {
      if (opts.puerto !== undefined && (!Number.isInteger(opts.puerto) || opts.puerto < 1 || opts.puerto > 65535)) throw new CliError('--puerto debe estar entre 1 y 65535');
      if (!Number.isInteger(opts.bovedaMinutos) || opts.bovedaMinutos < 1 || opts.bovedaMinutos > 240) throw new CliError('--boveda-minutos debe estar entre 1 y 240');
      let vault: Vault | null = null;
      if (opts.boveda) {
        try {
          vault = Vault.open(vaultPaths(forjaHome()), await vaultPassphrase(), { idleMs: opts.bovedaMinutos * 60_000 });
        } catch (error) {
          throw new CliError((error as Error).message, EXIT.precondition);
        }
      }
      const panel = await startPanel({ vault, ...(opts.puerto ? { port: opts.puerto } : {}) });
      try {
        const ctx = panel.projects.context();
        const link = panel.link();
        const opened = !opts.sinNavegador && (await openBrowser(link));
        print(ctx ? `Forja · «${ctx.config.nombre}» en ${panel.url}` : `Forja en ${panel.url}`);
        if (opened) print('✔ Se abrió en tu navegador.');
        else print(`Abre este enlace en tu navegador (sirve una sola vez y vence en 5 minutos):\n  ${link}`);
        if (vault) print(`Bóveda abierta para ejecutar acciones aprobadas; se cierra tras ${opts.bovedaMinutos} min sin uso.`);
        print('');
        print('Deja esta ventana abierta mientras usas Forja.');
        print('Enter = enlace nuevo · Ctrl-C = cerrar (los trabajos en curso siguen corriendo)');
        const rl = createInterface({ input: process.stdin, terminal: false });
        rl.on('line', () => print(`  ${panel.link()}`));
        await new Promise<void>((resolve) => {
          process.once('SIGINT', resolve);
          process.once('SIGTERM', resolve);
          if (opts.salirSinEntrada) rl.once('close', resolve);
        });
        rl.close();
        print('\nPanel cerrado.');
      } finally {
        vault?.close();
        await panel.stop();
      }
    });
}
