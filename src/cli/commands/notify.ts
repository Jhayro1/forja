import type { Command } from 'commander';
import { ConnectionError, ConnectionStore } from '../../actions/connections.js';
import type { SecretResolver } from '../../actions/protocol.js';
import { MailService } from '../../notify/mail.js';
import { mailPending } from '../../notify/mail-notices.js';
import { NotificationError, NotificationService } from '../../notify/notifier.js';
import { forjaHome } from '../../registry/home.js';
import { currentChange, runSnapshot } from '../../run/snapshot.js';
import { systemKeyring, vaultAccount } from '../../vault/keyring.js';
import { Vault, vaultPaths } from '../../vault/vault.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { type EngineContext, openEngine } from '../engine-context.js';
import { actionService, withSecrets } from './actions.js';

export function notificationService(ctx: EngineContext): NotificationService {
  return new NotificationService(ctx.store, ConnectionStore.in(ctx.home), actionService(ctx), ctx.config.nombre);
}

function domain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof NotificationError || error instanceof ConnectionError) throw new CliError(error.message, EXIT.precondition);
    throw error;
  }
}

/**
 * Secrets for a run nobody is watching: never prompts. The vault opens with
 * FORJA_BOVEDA_CLAVE or the key saved in the system keyring; otherwise null.
 */
function unattendedVault(): Vault | null {
  const passphrase = process.env.FORJA_BOVEDA_CLAVE ?? systemKeyring()?.get(vaultAccount(vaultPaths(forjaHome()).file)) ?? null;
  if (!passphrase) return null;
  try {
    return Vault.open(vaultPaths(forjaHome()), passphrase);
  } catch {
    return null;
  }
}

/**
 * While `forja run` works: every `everyMs`, notify what newly waits for the
 * user. No policy → nothing runs. Returns the function that stops it after a
 * last round (what the run left waiting when it ended is notified too).
 */
export function startRunNotifications(ctx: EngineContext, say: (line: string) => void, everyMs = 10_000): () => Promise<void> {
  const service = notificationService(ctx);
  const policy = service.policy();
  // Email notices (v3 §5.6) work on their own, with or without a webhook policy.
  const mail = new MailService(ctx.home);
  if (!policy && !mail.wants('pendientes')) return async () => {};
  const conn = policy
    ? ConnectionStore.in(ctx.home)
        .all()
        .find((c) => c.name === policy.connection)
    : undefined;
  const vault = conn?.secret ? unattendedVault() : null;
  if (conn?.secret && !vault)
    say(`⚠ avisos sin credencial: la conexión «${conn.name}» usa un secreto y la bóveda no se puede abrir sin preguntarte (guarda la clave con forja boveda llavero guardar)`);
  const secret: SecretResolver = (name) => (vault?.isOpen && vault.has(name) ? vault.get(name) : null);
  let busy: Promise<void> | null = null;
  const round = async () => {
    try {
      const change = currentChange(ctx.engine);
      if (!change) return;
      const pending = runSnapshot(ctx.engine, change).pending;
      if (policy) for (const line of await service.notify(pending, secret)) say(line);
      const mailed = await mailPending(ctx.store, mail, ctx.config.nombre, pending, say);
      if (mailed) say(`✉ ${mailed} aviso(s) por correo`);
    } catch (error) {
      say(`⚠ avisos: ${(error as Error).message}`);
    }
  };
  // One round at a time: a slow webhook never overlaps the next round.
  const tick = (): Promise<void> => (busy ??= round().finally(() => (busy = null)));
  const timer = setInterval(() => void tick(), everyMs);
  void tick();
  return async () => {
    clearInterval(timer);
    await tick();
    vault?.close();
  };
}

/** `forja notificaciones`: a standing, explicit policy for «pendiente de ti» notices (MEJORAS 7). */
export function registerNotificationCommands(program: Command): void {
  const n = program.command('notificaciones').description('avisos cuando algo espera de ti (preguntas, bloqueos, pausas), por un webhook que tú eliges');

  n.command('ver', { isDefault: true })
    .description('política activa y exactamente qué datos salen en cada aviso')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const service = notificationService(ctx);
        const policy = service.policy();
        const sample = policy ? service.paramsFor({ kind: 'pregunta_tarea', id: 'T-003', text: '(texto de la pregunta)' }, policy) : null;
        if (g.json) return printJson({ politica: policy, ejemplo: sample });
        if (!policy) return print('Las notificaciones están desactivadas. Actívalas con: forja notificaciones activar <conexion> [--con-texto]');
        print(`Avisos activos por «${policy.connection}» (versión ${policy.connection_version}, ruta ${policy.path}) desde ${policy.at.slice(0, 16).replace('T', ' ')}.`);
        print(`Cada aviso envía exactamente: ${JSON.stringify(sample)}`);
        print(policy.include_text ? 'Incluye el texto del pendiente (hasta 280 caracteres).' : 'No incluye textos ni código: sólo proyecto, tipo e id.');
      } finally {
        ctx.close();
      }
    });

  n.command('activar <conexion>')
    .description('activa los avisos por una conexión HTTP (la vincula para webhook.evento); cada aviso queda en la auditoría')
    .option('--con-texto', 'incluir el texto del pendiente (p. ej. la pregunta del agente), hasta 280 caracteres')
    .option('--ruta <ruta>', 'ruta del webhook dentro de la conexión', '/')
    .action((name: string, o: { conTexto?: boolean; ruta: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const service = notificationService(ctx);
        const policy = domain(() => service.activate(name, { includeText: Boolean(o.conTexto), path: o.ruta }));
        if (g.json) return printJson(policy);
        print(`✔ avisos activos por «${name}». Cada aviso envía: ${JSON.stringify(service.paramsFor({ kind: 'pregunta_tarea', id: 'T-003', text: '…' }, policy))}`);
        print('  Si la conexión cambia, los avisos se pausan hasta que los vuelvas a activar.');
      } finally {
        ctx.close();
      }
    });

  n.command('desactivar')
    .description('deja de enviar avisos')
    .action((_o: unknown, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        domain(() => notificationService(ctx).deactivate());
        print('✔ avisos desactivados');
      } finally {
        ctx.close();
      }
    });

  n.command('probar')
    .description('envía un aviso de prueba con la política activa')
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = openEngine(cmd.optsWithGlobals<GlobalOptions>());
      try {
        const service = notificationService(ctx);
        const policy = service.policy();
        if (!policy) throw new CliError('las notificaciones no están activas: forja notificaciones activar <conexion>', EXIT.precondition);
        const conn = domain(() => ConnectionStore.in(ctx.home).get(policy.connection));
        const lines = await withSecrets(Boolean(conn.secret), (resolve) => service.notify([{ kind: 'prueba', id: `prueba-${Date.now()}`, text: 'aviso de prueba de Forja' }], resolve));
        for (const l of lines) print(l);
      } finally {
        ctx.close();
      }
    });
}
