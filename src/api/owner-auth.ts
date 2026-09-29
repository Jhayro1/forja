import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ApiError } from './http.js';
import type { Session } from './session.js';

/**
 * Owner login for server mode (v3/PLAN.md §6.9), modeled on Winkstec ERP: the sign-up
 * screen exists but is CLOSED — only the address in `FORJA_DUENO_EMAIL` can register,
 * verify it with a 6-digit code and sign in. Nobody else ever gets a session.
 *
 * - Passwords: scrypt (N=2^15, r=8, p=1) with a random salt.
 * - 5 wrong passwords lock the account for 15 minutes; per-IP limits on every entry point.
 * - Sessions persist on disk (a container restart does not log out) and are stored as
 *   SHA-256 of the cookie value, so reading the file does not give a usable session.
 */

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 } as const;
const SESSION_MS = 7 * 24 * 3_600_000;
const CODE_MS = 15 * 60_000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;

const Code = z.object({ hash: z.string(), expires: z.number(), attempts: z.number().int(), purpose: z.enum(['verificar', 'recuperar']) }).strict();
const Owner = z
  .object({
    email: z.string(),
    password: z.string(),
    verified: z.boolean(),
    created: z.string(),
    failed: z.number().int().default(0),
    locked_until: z.number().default(0),
    code: Code.nullable().default(null),
  })
  .strict();
type Owner = z.infer<typeof Owner>;
const StoredSession = z.object({ id_hash: z.string(), csrf: z.string(), expires: z.number(), created: z.string(), ip: z.string().nullable() }).strict();
type StoredSession = z.infer<typeof StoredSession>;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }, (e, k) => (e ? reject(e) : resolve(k))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [kind, n, salt, key] = stored.split('$');
  if (kind !== 'scrypt' || Number(n) !== SCRYPT.N || !salt || !key) return false;
  const actual = await derive(password, Buffer.from(salt, 'base64'));
  const expected = Buffer.from(key, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Password rules: long enough to resist guessing, short enough for scrypt. */
export function checkPassword(password: string): void {
  if (password.length < 10) throw new ApiError(422, 'clave_debil', 'la contraseña debe tener al menos 10 caracteres');
  if (password.length > 200) throw new ApiError(422, 'clave_larga', 'la contraseña es demasiado larga');
}

/** Fixed-window counters per key (IP or email), in memory: a restart only resets the windows. */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; until: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(bucket: string, key: string, max: number, windowMs: number): void {
    const k = `${bucket}:${key}`;
    const t = this.now();
    const hit = this.hits.get(k);
    if (!hit || hit.until <= t) {
      this.hits.set(k, { n: 1, until: t + windowMs });
      return;
    }
    hit.n++;
    if (hit.n > max) {
      const minutes = Math.max(1, Math.ceil((hit.until - t) / 60_000));
      throw new ApiError(429, 'demasiados_intentos', `demasiados intentos; espera ${minutes} min`, true);
    }
  }
}

export type CodeSender = (to: string, purpose: 'verificar' | 'recuperar', code: string) => Promise<'correo' | 'registro'>;

export type AuthMessage = { mensaje: string };

export class OwnerAuth {
  private readonly dir: string;
  private readonly limits: RateLimiter;

  constructor(
    home: string,
    readonly ownerEmail: string,
    private readonly sendCode: CodeSender,
    private readonly now: () => number = Date.now,
  ) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error('FORJA_DUENO_EMAIL no es un correo válido');
    this.ownerEmail = normalizeEmail(ownerEmail);
    this.dir = join(home, 'servidor');
    this.limits = new RateLimiter(now);
  }

  // ─── persistence ───
  private path(name: string): string {
    return join(this.dir, name);
  }

  private readJson<T>(name: string, schema: z.ZodType<T>, fallback: T): T {
    const p = this.path(name);
    if (!existsSync(p)) return fallback;
    try {
      return schema.parse(JSON.parse(readFileSync(p, 'utf8')));
    } catch {
      return fallback;
    }
  }

  private writeJson(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = this.path(`${name}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, this.path(name));
  }

  private owner(): Owner | null {
    return this.readJson('dueno.json', Owner.nullable(), null);
  }

  private saveOwner(o: Owner): void {
    this.writeJson('dueno.json', o);
  }

  private sessionsList(): StoredSession[] {
    const t = this.now();
    return this.readJson('sesiones.json', z.array(StoredSession), []).filter((s) => s.expires > t);
  }

  // ─── public state ───
  /** Like the ERP: the sign-up screen only opens while there is no verified owner. */
  status(): { registro_abierto: boolean } {
    return { registro_abierto: !this.owner()?.verified };
  }

  private isOwner(email: string): boolean {
    return safeEq(sha(normalizeEmail(email)), sha(this.ownerEmail));
  }

  private async issueCode(o: Owner, purpose: 'verificar' | 'recuperar'): Promise<Owner> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const next = { ...o, code: { hash: sha(`${purpose}:${code}`), expires: this.now() + CODE_MS, attempts: 0, purpose } };
    this.saveOwner(next);
    await this.sendCode(o.email, purpose, code);
    return next;
  }

  private checkCode(o: Owner, purpose: 'verificar' | 'recuperar', code: string): boolean {
    const c = o.code;
    if (!c || c.purpose !== purpose || c.expires < this.now() || c.attempts >= 5) return false;
    if (safeEq(c.hash, sha(`${purpose}:${code.trim()}`))) return true;
    this.saveOwner({ ...o, code: { ...c, attempts: c.attempts + 1 } });
    return false;
  }

  // ─── flows ───
  async register(input: { email: string; clave: string }, ip: string): Promise<AuthMessage> {
    this.limits.consume('registro:ip', ip, 10, 3_600_000);
    if (!this.isOwner(input.email)) {
      throw new ApiError(403, 'registro_cerrado', 'El registro está cerrado: esta instalación de Forja sólo admite a su dueño.');
    }
    checkPassword(input.clave);
    const current = this.owner();
    // Once the owner exists the door is closed for everyone, the owner included (like the ERP).
    if (current?.verified) throw new ApiError(403, 'registro_cerrado', 'El registro está cerrado: esta instalación de Forja sólo admite a su dueño.');
    const generic = { mensaje: 'Si el correo puede registrarse, te llegó un código de verificación.' };
    const owner: Owner = { email: this.ownerEmail, password: await hashPassword(input.clave), verified: false, created: new Date(this.now()).toISOString(), failed: 0, locked_until: 0, code: null };
    await this.issueCode(owner, 'verificar');
    return generic;
  }

  async verify(input: { email: string; codigo: string }, ip: string): Promise<AuthMessage> {
    this.limits.consume('verificar:ip', ip, 20, 3_600_000);
    const o = this.owner();
    if (!o || o.verified || !this.isOwner(input.email) || !this.checkCode(o, 'verificar', input.codigo)) throw new ApiError(400, 'codigo_invalido', 'el código no es válido, ya se usó o venció');
    this.saveOwner({ ...o, verified: true, code: null });
    return { mensaje: 'Correo verificado: ya puedes iniciar sesión.' };
  }

  async resendCode(email: string, ip: string): Promise<AuthMessage> {
    this.limits.consume('reenviar:ip', ip, 5, 3_600_000);
    const o = this.owner();
    if (o && !o.verified && this.isOwner(email)) await this.issueCode(o, 'verificar');
    return { mensaje: 'Si hay un registro pendiente, te llegó un código nuevo.' };
  }

  async login(input: { email: string; clave: string }, ip: string): Promise<Session> {
    this.limits.consume('entrar:ip', ip, 20, 15 * 60_000);
    const o = this.owner();
    const denied = new ApiError(401, 'credenciales', 'correo o contraseña incorrectos');
    if (!o || !this.isOwner(input.email)) {
      // Same work as a real check: the response time does not reveal the owner's address.
      await verifyPassword(`scrypt$${SCRYPT.N}$AAAAAAAAAAAAAAAAAAAAAA==$AAAA`, input.clave);
      throw denied;
    }
    if (o.locked_until > this.now()) {
      throw new ApiError(423, 'cuenta_bloqueada', `demasiados intentos fallidos; espera ${Math.ceil((o.locked_until - this.now()) / 60_000)} min`, true);
    }
    if (!(await verifyPassword(o.password, input.clave))) {
      const failed = o.failed + 1;
      this.saveOwner({ ...o, failed, locked_until: failed >= LOCK_AFTER ? this.now() + LOCK_MS : 0 });
      throw denied;
    }
    if (!o.verified) throw new ApiError(403, 'sin_verificar', 'verifica tu correo con el código antes de entrar');
    this.saveOwner({ ...o, failed: 0, locked_until: 0 });
    return this.createSession(ip);
  }

  async requestReset(email: string, ip: string): Promise<AuthMessage> {
    this.limits.consume('recuperar:ip', ip, 5, 3_600_000);
    const o = this.owner();
    if (o?.verified && this.isOwner(email)) await this.issueCode(o, 'recuperar');
    return { mensaje: 'Si el correo es el del dueño, te llegó un código para cambiar la contraseña.' };
  }

  async confirmReset(input: { email: string; codigo: string; clave: string }, ip: string): Promise<AuthMessage> {
    this.limits.consume('recuperar-confirmar:ip', ip, 20, 3_600_000);
    checkPassword(input.clave);
    const o = this.owner();
    if (!o || !this.isOwner(input.email) || !this.checkCode(o, 'recuperar', input.codigo)) throw new ApiError(400, 'codigo_invalido', 'el código no es válido, ya se usó o venció');
    this.saveOwner({ ...o, password: await hashPassword(input.clave), code: null, failed: 0, locked_until: 0 });
    this.revokeAll();
    return { mensaje: 'Contraseña cambiada: inicia sesión con la nueva.' };
  }

  async changePassword(session: Session, input: { actual: string; nueva: string }): Promise<AuthMessage> {
    checkPassword(input.nueva);
    const o = this.owner();
    if (!o || !(await verifyPassword(o.password, input.actual))) throw new ApiError(403, 'credenciales', 'la contraseña actual no es correcta');
    this.saveOwner({ ...o, password: await hashPassword(input.nueva) });
    // Other devices are signed out; this one stays.
    this.writeJson(
      'sesiones.json',
      this.sessionsList().filter((s) => safeEq(s.id_hash, sha(session.id))),
    );
    return { mensaje: 'Contraseña cambiada. Se cerraron las demás sesiones.' };
  }

  // ─── sessions (same shape as the local SessionManager) ───
  private createSession(ip: string): Session {
    const id = randomBytes(32).toString('base64url');
    const session: Session = { id, csrf: randomBytes(32).toString('base64url'), expiresAt: this.now() + SESSION_MS };
    const stored: StoredSession = { id_hash: sha(id), csrf: session.csrf, expires: session.expiresAt, created: new Date(this.now()).toISOString(), ip };
    this.writeJson('sesiones.json', [...this.sessionsList().slice(-19), stored]);
    return session;
  }

  get(id: string | undefined): Session | null {
    if (!id || id.length > 200) return null;
    const h = sha(id);
    const s = this.sessionsList().find((x) => safeEq(x.id_hash, h));
    return s ? { id, csrf: s.csrf, expiresAt: s.expires } : null;
  }

  revoke(id: string): void {
    const h = sha(id);
    this.writeJson(
      'sesiones.json',
      this.sessionsList().filter((s) => !safeEq(s.id_hash, h)),
    );
  }

  revokeAll(): void {
    this.writeJson('sesiones.json', []);
  }
}
