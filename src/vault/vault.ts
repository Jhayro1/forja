import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../domain/hash.js';

/**
 * Local vault (V2-050, v2/06 · Secretos). Standard primitives only: scrypt for
 * the key, AES-256-GCM with the whole header as authenticated data. No custom
 * crypto. Values never leave this module except to the action executor.
 *
 * Threats covered: wrong passphrase, any modified byte (header or body), KDF
 * parameters inflated to exhaust memory (rejected BEFORE deriving), an older
 * valid file put back (rollback, via the generation counter kept outside the
 * file). Not covered: a compromised account on this machine, or perfect erasure
 * of secrets from JavaScript memory (documented, not promised).
 */

export const VAULT_FORMAT = 'forja-boveda';
export const VAULT_VERSION = 1;

/** Accepted scrypt costs: enough to slow guessing, bounded so a file cannot DoS us. */
export const KDF_LIMITS = { minLogN: 14, maxLogN: 17, r: 8, maxP: 2, maxMemBytes: 256 * 1024 * 1024 } as const;
export const DEFAULT_KDF = { logN: 15, r: 8, p: 1 } as const;
const MIN_PASSPHRASE = 12;

export class VaultError extends Error {}
/** The file does not authenticate: wrong passphrase or modified content (indistinguishable by design). */
export class VaultAuthError extends VaultError {}
export class VaultRollbackError extends VaultError {}

type KdfParams = { name: 'scrypt'; logN: number; r: number; p: number; salt: string };
type Header = { format: typeof VAULT_FORMAT; version: number; generation: number; kdf: KdfParams; nonce: string };
type Envelope = Header & { tag: string; ciphertext: string };

export type SecretVersion = { version: number; value: string; created_at: string };
export type SecretEntry = { name: string; versions: SecretVersion[]; deleted_at: string | null };
type Body = { entries: Record<string, SecretEntry>; updated_at: string };

export type SecretInfo = { name: string; version: number; created_at: string; previous_versions: number };

/** Previous versions kept after a rotation, for controlled recovery. */
const KEEP_VERSIONS = 3;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function checkKdf(k: KdfParams): void {
  if (k.name !== 'scrypt') throw new VaultError('KDF desconocida');
  if (!Number.isInteger(k.logN) || k.logN < KDF_LIMITS.minLogN || k.logN > KDF_LIMITS.maxLogN) throw new VaultError(`parámetro de KDF fuera de límites (logN=${k.logN})`);
  if (k.r !== KDF_LIMITS.r || !Number.isInteger(k.p) || k.p < 1 || k.p > KDF_LIMITS.maxP) throw new VaultError('parámetros de KDF fuera de límites');
  if (128 * 2 ** k.logN * k.r * k.p > KDF_LIMITS.maxMemBytes / 2) throw new VaultError('la KDF pediría demasiada memoria');
  if (Buffer.from(k.salt, 'base64').length !== 16) throw new VaultError('salt inválida');
}

function deriveKey(passphrase: string, k: KdfParams): Buffer {
  checkKdf(k);
  return scryptSync(passphrase.normalize('NFC'), Buffer.from(k.salt, 'base64'), 32, { N: 2 ** k.logN, r: k.r, p: k.p, maxmem: KDF_LIMITS.maxMemBytes });
}

const aad = (h: Header) => Buffer.from(canonicalJson({ format: h.format, version: h.version, generation: h.generation, kdf: h.kdf, nonce: h.nonce }));

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // Durability of the rename itself.
  const dfd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

function parseEnvelope(text: string): Envelope {
  let e: Envelope;
  try {
    e = JSON.parse(text) as Envelope;
  } catch {
    throw new VaultAuthError('la bóveda está dañada (no es JSON)');
  }
  if (e?.format !== VAULT_FORMAT) throw new VaultAuthError('no es un archivo de bóveda de Forja');
  if (e.version !== VAULT_VERSION) throw new VaultError(`versión de bóveda no soportada: ${e.version}`);
  if (!Number.isInteger(e.generation) || e.generation < 1) throw new VaultAuthError('la bóveda está dañada (generación)');
  if (typeof e.nonce !== 'string' || Buffer.from(e.nonce, 'base64').length !== 12) throw new VaultAuthError('la bóveda está dañada (nonce)');
  if (typeof e.tag !== 'string' || Buffer.from(e.tag, 'base64').length !== 16) throw new VaultAuthError('la bóveda está dañada (etiqueta)');
  checkKdf(e.kdf);
  return e;
}

function decrypt(e: Envelope, key: Buffer): Body {
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.nonce, 'base64'));
    d.setAAD(aad(e));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(e.ciphertext, 'base64')), d.final()]);
    const body = JSON.parse(plain.toString('utf8')) as Body;
    plain.fill(0);
    return body;
  } catch {
    throw new VaultAuthError('no se pudo abrir la bóveda: clave incorrecta o archivo modificado');
  }
}

function encrypt(body: Body, key: Buffer, header: Omit<Header, 'nonce'>): Envelope {
  // Fresh nonce on every write: never reuse (key, nonce) with GCM.
  const h: Header = { ...header, nonce: randomBytes(12).toString('base64') };
  const c = createCipheriv('aes-256-gcm', key, Buffer.from(h.nonce, 'base64'));
  c.setAAD(aad(h));
  const plain = Buffer.from(JSON.stringify(body));
  const ciphertext = Buffer.concat([c.update(plain), c.final()]);
  plain.fill(0);
  return { ...h, tag: c.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

/**
 * The newest generation this machine has seen, kept next to (not inside) the
 * vault: putting back an older, still valid file is detected as a rollback.
 */
class GenerationWatermark {
  constructor(private readonly path: string) {}
  read(): number {
    try {
      return (JSON.parse(readFileSync(this.path, 'utf8')) as { generation: number }).generation;
    } catch {
      return 0;
    }
  }
  write(generation: number): void {
    atomicWrite(this.path, JSON.stringify({ generation }));
  }
}

export type VaultPaths = { file: string; watermark: string; backups: string };

export function vaultPaths(home: string): VaultPaths {
  const dir = join(home, 'boveda');
  return { file: join(dir, 'boveda.json'), watermark: join(dir, 'generacion.json'), backups: join(dir, 'copias') };
}

export type OpenOptions = { idleMs?: number; now?: () => number; acceptRollback?: boolean };

/**
 * An open vault. The key lives only in this object; `close()` zeroes it (best
 * effort in JS) and every later operation is refused. It also closes itself
 * after `idleMs` without use, so a long-lived process does not keep it open.
 */
export class Vault {
  private key: Buffer | null;
  private lastUse: number;

  private constructor(
    private readonly paths: VaultPaths,
    key: Buffer,
    private body: Body,
    private header: Omit<Header, 'nonce'>,
    private readonly opts: OpenOptions,
  ) {
    this.key = key;
    this.lastUse = this.now();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  static exists(paths: VaultPaths): boolean {
    return existsSync(paths.file);
  }

  static create(paths: VaultPaths, passphrase: string, kdf: { logN: number; r: number; p: number } = DEFAULT_KDF): Vault {
    if (existsSync(paths.file)) throw new VaultError('ya existe una bóveda');
    if ([...passphrase].length < MIN_PASSPHRASE) throw new VaultError(`la clave debe tener al menos ${MIN_PASSPHRASE} caracteres`);
    const k: KdfParams = { name: 'scrypt', ...kdf, salt: randomBytes(16).toString('base64') };
    const vault = new Vault(paths, deriveKey(passphrase, k), { entries: {}, updated_at: new Date().toISOString() }, { format: VAULT_FORMAT, version: VAULT_VERSION, generation: 0, kdf: k }, {});
    vault.persist();
    return vault;
  }

  static open(paths: VaultPaths, passphrase: string, opts: OpenOptions = {}): Vault {
    if (!existsSync(paths.file)) throw new VaultError('no hay bóveda: créala con forja boveda iniciar');
    const e = parseEnvelope(readFileSync(paths.file, 'utf8'));
    const key = deriveKey(passphrase, e.kdf);
    const body = decrypt(e, key);
    const seen = new GenerationWatermark(paths.watermark).read();
    if (e.generation < seen && !opts.acceptRollback) {
      key.fill(0);
      throw new VaultRollbackError(`la bóveda es más vieja (generación ${e.generation}) que la última vista en esta máquina (${seen}): alguien la reemplazó por una copia anterior`);
    }
    const { nonce: _, tag: __, ciphertext: ___, ...header } = e;
    return new Vault(paths, key, body, header, opts);
  }

  /** Checks a file decrypts with the passphrase, without opening it for use. */
  static verifyFile(path: string, passphrase: string): { generation: number; secrets: number } {
    const e = parseEnvelope(readFileSync(path, 'utf8'));
    const key = deriveKey(passphrase, e.kdf);
    try {
      const body = decrypt(e, key);
      return { generation: e.generation, secrets: Object.values(body.entries).filter((x) => !x.deleted_at).length };
    } finally {
      key.fill(0);
    }
  }

  get isOpen(): boolean {
    if (this.key && this.opts.idleMs && this.now() - this.lastUse > this.opts.idleMs) this.close();
    return this.key !== null;
  }

  private use(): Buffer {
    if (!this.isOpen) throw new VaultError('la bóveda está cerrada');
    this.lastUse = this.now();
    return this.key!;
  }

  close(): void {
    this.key?.fill(0);
    this.key = null;
    this.body = { entries: {}, updated_at: '' };
  }

  get generation(): number {
    return this.header.generation;
  }

  private persist(): void {
    const key = this.use();
    this.header = { ...this.header, generation: this.header.generation + 1 };
    this.body.updated_at = new Date().toISOString();
    if (existsSync(this.paths.file)) {
      // Previous file kept for controlled recovery (still encrypted).
      mkdirSync(this.paths.backups, { recursive: true, mode: 0o700 });
      atomicWrite(join(this.paths.backups, `boveda-gen${this.header.generation - 1}.json`), readFileSync(this.paths.file, 'utf8'));
    }
    atomicWrite(this.paths.file, `${JSON.stringify(encrypt(this.body, key, this.header), null, 2)}\n`);
    new GenerationWatermark(this.paths.watermark).write(this.header.generation);
  }

  /** New value for a secret; the previous ones stay for recovery (rotation). */
  set(name: string, value: string): SecretInfo {
    this.use();
    if (!NAME_RE.test(name)) throw new VaultError('nombre inválido: letras, números, punto, guion o guion bajo; empieza con letra');
    if (!value) throw new VaultError('el valor está vacío');
    const now = new Date().toISOString();
    const entry = this.body.entries[name] ?? { name, versions: [], deleted_at: null };
    const version = (entry.versions.at(-1)?.version ?? 0) + 1;
    entry.versions = [...entry.versions, { version, value, created_at: now }].slice(-(KEEP_VERSIONS + 1));
    entry.deleted_at = null;
    this.body.entries[name] = entry;
    this.persist();
    return this.info(entry);
  }

  get(name: string, version?: number): string {
    this.use();
    const entry = this.body.entries[name];
    if (!entry || entry.deleted_at) throw new VaultError(`no existe el secreto «${name}»`);
    const v = version === undefined ? entry.versions.at(-1) : entry.versions.find((x) => x.version === version);
    if (!v) throw new VaultError(`el secreto «${name}» no tiene la versión ${version}`);
    return v.value;
  }

  has(name: string): boolean {
    this.use();
    const e = this.body.entries[name];
    return Boolean(e && !e.deleted_at);
  }

  private info(e: SecretEntry): SecretInfo {
    const last = e.versions.at(-1)!;
    return { name: e.name, version: last.version, created_at: last.created_at, previous_versions: e.versions.length - 1 };
  }

  /** Names and metadata only: values are never listed. */
  list(): SecretInfo[] {
    this.use();
    return Object.values(this.body.entries)
      .filter((e) => !e.deleted_at)
      .map((e) => this.info(e))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Removes the values (all versions) and keeps a tombstone. Old backups still contain them. */
  remove(name: string): void {
    this.use();
    const e = this.body.entries[name];
    if (!e || e.deleted_at) throw new VaultError(`no existe el secreto «${name}»`);
    e.versions = e.versions.map((v) => ({ ...v, value: '' }));
    e.deleted_at = new Date().toISOString();
    this.persist();
  }

  /** Re-encrypts everything with a new passphrase and fresh salt. */
  changePassphrase(newPassphrase: string, kdf: { logN: number; r: number; p: number } = DEFAULT_KDF): void {
    this.use();
    if ([...newPassphrase].length < MIN_PASSPHRASE) throw new VaultError(`la clave debe tener al menos ${MIN_PASSPHRASE} caracteres`);
    const k: KdfParams = { name: 'scrypt', ...kdf, salt: randomBytes(16).toString('base64') };
    const newKey = deriveKey(newPassphrase, k);
    this.key!.fill(0);
    this.key = newKey;
    this.header = { ...this.header, kdf: k };
    this.persist();
  }

  /** All current values, for the redactor of an executor's output. */
  values(): string[] {
    this.use();
    return Object.values(this.body.entries)
      .filter((e) => !e.deleted_at)
      .flatMap((e) => e.versions.map((v) => v.value))
      .filter(Boolean);
  }
}

/**
 * Replaces the vault with a verified copy. The current file is set aside (never
 * deleted) and the watermark accepts the restored generation explicitly.
 */
export function restoreVault(paths: VaultPaths, from: string, passphrase: string): { generation: number; previous: string | null } {
  const info = Vault.verifyFile(from, passphrase);
  let previous: string | null = null;
  if (existsSync(paths.file)) {
    previous = `${paths.file}.apartada-${Date.now()}`;
    renameSync(paths.file, previous);
  }
  atomicWrite(paths.file, readFileSync(from, 'utf8'));
  new GenerationWatermark(paths.watermark).write(info.generation);
  return { generation: info.generation, previous };
}
