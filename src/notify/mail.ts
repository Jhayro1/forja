import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTransport } from 'nodemailer';
import { z } from 'zod';
import { decryptLocal, encryptLocal } from '../security/local-secret.js';

export { decryptLocal, encryptLocal };

/**
 * Email notices over any SMTP (v3/PLAN.md §5.6 and §6.10). Built for Auralis Mail app
 * passwords but works with Gmail or any server. The password is stored ENCRYPTED
 * (AES-256-GCM with a local 0600 key) and never goes back to the browser.
 * `FORJA_SMTP_*` variables win over the saved settings (server mode).
 */
export const NOTICE_KINDS = ['chat', 'trabajos', 'runs', 'pendientes', 'observaciones'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const NOTICE_LABELS: Record<NoticeKind, string> = {
  chat: 'El planeador respondió (si tardó más de un minuto)',
  trabajos: 'Terminó un trabajo (especificar, dividir, validar…)',
  runs: 'Un run terminó, se detuvo o se bloqueó',
  pendientes: 'Algo espera tu respuesta (preguntas, bloqueos)',
  observaciones: 'Hay observaciones nuevas de revisión o QA',
};

const Security = z.enum(['tls', 'starttls', 'ninguna']);

export const MailSettingsInput = z
  .object({
    activo: z.boolean(),
    host: z.string().trim().min(1).max(253),
    puerto: z.number().int().min(1).max(65535),
    seguridad: Security,
    usuario: z.string().trim().max(254),
    /** Omitted or empty: keep the saved one. */
    clave: z.string().max(1024).optional(),
    remitente: z.email().max(254),
    nombre_remitente: z.string().trim().max(80).default('Forja'),
    destinatario: z.email().max(254),
    avisos: z.partialRecord(z.enum(NOTICE_KINDS), z.boolean()).default({}),
  })
  .strict();
export type MailSettingsInput = z.infer<typeof MailSettingsInput>;

const Stored = MailSettingsInput.omit({ clave: true }).extend({ clave_cifrada: z.string().nullable() });
type Stored = z.infer<typeof Stored>;

export type MailSettings = Omit<Stored, 'clave_cifrada'> & { clave: string | null };

/** What the panel sees: never the password, only whether there is one. */
export type MailView = Omit<Stored, 'clave_cifrada'> & { clave_guardada: boolean; desde_entorno: boolean; avisos_disponibles: { id: NoticeKind; texto: string }[] };

export class MailError extends Error {}

export type Message = { asunto: string; texto: string };
export type Sender = (settings: MailSettings, message: Message) => Promise<void>;

export const smtpSender: Sender = async (s, m) => {
  const transport = createTransport({
    host: s.host,
    port: s.puerto,
    secure: s.seguridad === 'tls',
    requireTLS: s.seguridad === 'starttls',
    ...(s.usuario ? { auth: { user: s.usuario, pass: s.clave ?? '' } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({ from: { name: s.nombre_remitente, address: s.remitente }, to: s.destinatario, subject: m.asunto, text: m.texto });
  } finally {
    transport.close();
  }
};

function fromEnv(env: NodeJS.ProcessEnv): MailSettings | null {
  if (!env.FORJA_SMTP_HOST) return null;
  const sec = env.FORJA_SMTP_SECURE;
  const port = Number(env.FORJA_SMTP_PORT ?? (sec === 'tls' || sec === 'true' ? 465 : 587));
  return {
    activo: true,
    host: env.FORJA_SMTP_HOST,
    puerto: port,
    seguridad: sec === 'tls' || sec === 'true' ? 'tls' : sec === 'ninguna' ? 'ninguna' : 'starttls',
    usuario: env.FORJA_SMTP_USER ?? '',
    clave: env.FORJA_SMTP_PASSWORD ?? null,
    remitente: env.FORJA_SMTP_FROM ?? env.FORJA_SMTP_USER ?? '',
    nombre_remitente: env.FORJA_SMTP_FROM_NAME ?? 'Forja',
    destinatario: env.FORJA_SMTP_TO ?? env.FORJA_DUENO_EMAIL ?? '',
    avisos: Object.fromEntries(NOTICE_KINDS.map((k) => [k, true])),
  };
}

export class MailService {
  private readonly file: string;

  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly sender: Sender = smtpSender,
  ) {
    this.file = join(home, 'correo.json');
  }

  private stored(): Stored | null {
    if (!existsSync(this.file)) return null;
    try {
      return Stored.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return null;
    }
  }

  /** Effective settings (environment first), with the password decrypted; null if not configured. */
  settings(): MailSettings | null {
    const env = fromEnv(this.env);
    if (env) return env;
    const s = this.stored();
    if (!s) return null;
    const { clave_cifrada, ...rest } = s;
    return { ...rest, clave: clave_cifrada ? decryptLocal(this.home, clave_cifrada) : null };
  }

  view(): MailView | null {
    const avisos_disponibles = NOTICE_KINDS.map((id) => ({ id, texto: NOTICE_LABELS[id] }));
    const env = fromEnv(this.env);
    if (env) {
      const { clave, ...rest } = env;
      return { ...rest, clave_guardada: Boolean(clave), desde_entorno: true, avisos_disponibles };
    }
    const s = this.stored();
    if (!s) return null;
    const { clave_cifrada, ...rest } = s;
    return { ...rest, clave_guardada: Boolean(clave_cifrada), desde_entorno: false, avisos_disponibles };
  }

  save(input: unknown): MailView {
    if (fromEnv(this.env)) throw new MailError('el correo está configurado con variables FORJA_SMTP_* en el servidor: cámbialo ahí');
    const parsed = MailSettingsInput.safeParse(input);
    if (!parsed.success) throw new MailError(parsed.error.issues.map((i) => `${i.path.join('.') || 'correo'}: ${i.message}`).join('; '));
    const { clave, ...rest } = parsed.data;
    const previous = this.stored();
    const clave_cifrada = clave ? encryptLocal(this.home, clave) : (previous?.clave_cifrada ?? null);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...rest, clave_cifrada }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    return this.view()!;
  }

  /** Whether notices of this kind should go out. */
  wants(kind: NoticeKind): boolean {
    const s = this.settings();
    return Boolean(s?.activo && s.destinatario && s.avisos[kind] !== false);
  }

  async send(message: Message): Promise<void> {
    const s = this.settings();
    if (!s) throw new MailError('el correo no está configurado');
    if (!s.destinatario) throw new MailError('falta el destinatario de los avisos');
    await this.sendTo(s.destinatario, message);
  }

  /** Sends to a given address with the configured server (login codes go to the owner). */
  async sendTo(to: string, message: Message): Promise<void> {
    const s = this.settings();
    if (!s) throw new MailError('el correo no está configurado');
    try {
      await this.sender({ ...s, destinatario: to }, { asunto: message.asunto.slice(0, 200), texto: message.texto.slice(0, 20_000) });
    } catch (error) {
      throw new MailError(`no se pudo enviar el correo: ${(error as Error).message}`);
    }
  }

  /** Sends a notice if its kind is enabled; never throws (a notice must not break the work). */
  async notice(kind: NoticeKind, message: Message, log: (line: string) => void = () => {}): Promise<boolean> {
    if (!this.wants(kind)) return false;
    try {
      await this.send(message);
      return true;
    } catch (error) {
      log(`⚠ aviso por correo: ${(error as Error).message}`);
      return false;
    }
  }

  async test(): Promise<void> {
    await this.send({
      asunto: 'Forja · correo de prueba',
      texto: 'Si lees esto, Forja ya puede avisarte por correo cuando termine un trabajo o algo espere tu respuesta.\n\n— Forja',
    });
  }
}

/** A link to the panel for the notice body, when Forja knows its public URL (server mode). */
export function panelLink(env: NodeJS.ProcessEnv = process.env): string {
  return env.FORJA_URL_PUBLICA ? `\n\nAbre el panel: ${env.FORJA_URL_PUBLICA.replace(/\/$/, '')}/` : '';
}
