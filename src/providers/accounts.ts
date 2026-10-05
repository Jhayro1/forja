import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Several accounts per provider (v3/PLAN.md §4.9). Each account is its own session
 * folder: `CLAUDE_CONFIG_DIR` for Claude Code and `CODEX_HOME` for Codex. The CLI's
 * default folder (`~/.claude`, `~/.codex`) is the `principal` account, so an install
 * without extra accounts behaves exactly as before.
 */
export const ACCOUNT_PROVIDERS = ['claude', 'codex'] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];
export const PRINCIPAL = 'principal';

/** Environment variable that points each CLI at a session folder. */
export const CONFIG_ENV: Record<AccountProvider, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };
/** Session file inside that folder (the only file mounted into the sandbox, D2-21). */
export const CREDENTIAL_NAME: Record<AccountProvider, string> = { claude: '.credentials.json', codex: 'auth.json' };

export const AccountAlias = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'el alias usa minúsculas, números y guiones (hasta 31 caracteres)')
  .refine((a) => a !== PRINCIPAL, '«principal» es la cuenta por defecto del CLI');

const Stored = z
  .object({
    proveedor: z.enum(ACCOUNT_PROVIDERS),
    alias: z.string(),
    activa: z.boolean().default(true),
    /** Most agents at once on this account; null = only the global N limits it. */
    max_agentes: z.number().int().min(1).max(16).nullable().default(null),
    creada: z.string(),
  })
  .strict();
const StoredFile = z.object({ schema_version: z.literal(1), cuentas: z.array(Stored) }).strict();

export type Account = z.infer<typeof Stored> & { principal: boolean };

export function defaultConfigDir(provider: AccountProvider, env: NodeJS.ProcessEnv = process.env): string {
  return env[CONFIG_ENV[provider]] ?? join(homedir(), provider === 'claude' ? '.claude' : '.codex');
}

/** Quota pauses are per account; the principal keeps the old key (`claude`, `codex`). */
export function accountPauseKey(provider: string, alias: string | null | undefined): string {
  return !alias || alias === PRINCIPAL ? provider : `${provider}@${alias}`;
}

export class AccountError extends Error {}

export class AccountStore {
  private readonly file: string;

  constructor(
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.file = join(home, 'cuentas.json');
  }

  private read(): z.infer<typeof Stored>[] {
    if (!existsSync(this.file)) return [];
    try {
      return StoredFile.parse(JSON.parse(readFileSync(this.file, 'utf8'))).cuentas;
    } catch (error) {
      throw new AccountError(`${this.file} no es válido: ${(error as Error).message}`);
    }
  }

  private write(cuentas: z.infer<typeof Stored>[]): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ schema_version: 1, cuentas }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Every account, principal first per provider. */
  list(provider?: AccountProvider): Account[] {
    const stored = this.read();
    const out: Account[] = [];
    for (const p of ACCOUNT_PROVIDERS) {
      if (provider && p !== provider) continue;
      const principal = stored.find((a) => a.proveedor === p && a.alias === PRINCIPAL);
      out.push({ proveedor: p, alias: PRINCIPAL, activa: principal?.activa ?? true, max_agentes: principal?.max_agentes ?? null, creada: principal?.creada ?? '', principal: true });
      for (const a of stored.filter((x) => x.proveedor === p && x.alias !== PRINCIPAL)) out.push({ ...a, principal: false });
    }
    return out;
  }

  get(provider: AccountProvider, alias: string): Account | null {
    return this.list(provider).find((a) => a.alias === alias) ?? null;
  }

  add(provider: AccountProvider, alias: string): Account {
    AccountAlias.parse(alias);
    const stored = this.read();
    if (stored.some((a) => a.proveedor === provider && a.alias === alias)) throw new AccountError(`ya existe la cuenta ${provider}@${alias}`);
    const account = { proveedor: provider, alias, activa: true, max_agentes: null, creada: new Date().toISOString() };
    mkdirSync(this.configDir(provider, alias), { recursive: true, mode: 0o700 });
    this.write([...stored, account]);
    return { ...account, principal: false };
  }

  update(provider: AccountProvider, alias: string, patch: { activa?: boolean; max_agentes?: number | null }): Account {
    const current = this.get(provider, alias);
    if (!current) throw new AccountError(`no existe la cuenta ${provider}@${alias}`);
    const next = Stored.parse({
      proveedor: provider,
      alias,
      activa: patch.activa ?? current.activa,
      max_agentes: patch.max_agentes === undefined ? current.max_agentes : patch.max_agentes,
      creada: current.creada || new Date().toISOString(),
    });
    const stored = this.read().filter((a) => !(a.proveedor === provider && a.alias === alias));
    this.write([...stored, next]);
    return { ...next, principal: alias === PRINCIPAL };
  }

  /** Forgets an extra account and deletes its session folder (the user asked for it). */
  remove(provider: AccountProvider, alias: string): void {
    if (alias === PRINCIPAL) throw new AccountError('la cuenta principal no se elimina: desactívala o cierra su sesión desde el CLI');
    const stored = this.read();
    if (!stored.some((a) => a.proveedor === provider && a.alias === alias)) throw new AccountError(`no existe la cuenta ${provider}@${alias}`);
    this.write(stored.filter((a) => !(a.proveedor === provider && a.alias === alias)));
    rmSync(this.configDir(provider, alias), { recursive: true, force: true });
  }

  configDir(provider: AccountProvider, alias: string): string {
    return alias === PRINCIPAL ? defaultConfigDir(provider, this.env) : join(this.home, 'cuentas', provider, alias);
  }

  credentialFile(provider: AccountProvider, alias: string): string {
    return join(this.configDir(provider, alias), CREDENTIAL_NAME[provider]);
  }

  /** Environment for the CLI to use this account (sign-in, conformance). */
  envFor(provider: AccountProvider, alias: string): Record<string, string> {
    return alias === PRINCIPAL && !this.env[CONFIG_ENV[provider]] ? {} : { [CONFIG_ENV[provider]]: this.configDir(provider, alias) };
  }

  signedIn(provider: AccountProvider, alias: string): boolean {
    if (existsSync(this.credentialFile(provider, alias))) return true;
    // Claude Code on macOS keeps the session in the Keychain; its config file says who is signed in.
    if (provider === 'claude' && alias === PRINCIPAL && process.platform === 'darwin' && !this.env.CLAUDE_CONFIG_DIR) {
      try {
        return Boolean((JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as { oauthAccount?: unknown }).oauthAccount);
      } catch {
        return false;
      }
    }
    return false;
  }
}

export type AccountChoice = { alias: string; credentialFile: string; pauseKey: string };

/**
 * The account for the next launch of `provider`: active, signed in, not paused,
 * under its own limit, and with the fewest agents running (spreads the quota).
 * `null` when none can take work right now.
 */
export function chooseAccount(accounts: AccountStore, provider: AccountProvider, opts: { paused: (key: string) => boolean; running: (alias: string) => number }): AccountChoice | null {
  let best: { a: Account; busy: number } | null = null;
  for (const a of accounts.list(provider)) {
    if (!a.activa || !accounts.signedIn(provider, a.alias)) continue;
    if (opts.paused(accountPauseKey(provider, a.alias))) continue;
    const busy = opts.running(a.alias);
    if (a.max_agentes !== null && busy >= a.max_agentes) continue;
    if (!best || busy < best.busy) best = { a, busy };
  }
  if (!best) return null;
  return { alias: best.a.alias, credentialFile: accounts.credentialFile(provider, best.a.alias), pauseKey: accountPauseKey(provider, best.a.alias) };
}

/**
 * Why no account of `provider` can take a launch, one line per account: deactivated,
 * no session file (and where it was looked for), or paused until when and why.
 */
export function explainNoAccount(accounts: AccountStore, provider: AccountProvider, pauses: { key: string; until: number; reason: string }[]): string {
  const parts: string[] = [];
  for (const a of accounts.list(provider)) {
    const name = a.principal ? `cuenta principal` : `cuenta ${a.alias}`;
    if (!a.activa) {
      parts.push(`${name}: desactivada (actívala en Ajustes → Cuentas)`);
      continue;
    }
    if (!accounts.signedIn(provider, a.alias)) {
      parts.push(`${name}: sin sesión, no existe ${accounts.credentialFile(provider, a.alias)} (inicia sesión con «${provider}» en esta máquina)`);
      continue;
    }
    const pause = pauses.find((p) => p.key === accountPauseKey(provider, a.alias));
    if (pause) {
      parts.push(`${name}: en pausa hasta las ${new Date(pause.until).toLocaleTimeString()} por un fallo anterior (${pause.reason}); si ya está resuelto: forja proveedores reanudar ${pause.key}`);
      continue;
    }
    parts.push(`${name}: al límite de agentes a la vez`);
  }
  return parts.join(' · ');
}
