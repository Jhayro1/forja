import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * The operating system's keyring for the vault passphrase (MEJORAS 4.3), so
 * FORJA_BOVEDA_CLAVE (visible to other processes of the same user) is not
 * needed. The secret always travels on stdin, never as an argument (`ps`).
 */
export interface Keyring {
  readonly id: string;
  get(account: string): string | null;
  set(account: string, secret: string): void;
  delete(account: string): boolean;
}

type Run = (cmd: string, args: string[], input?: string) => { status: number | null; stdout: string };
const run: Run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input: input ?? '', encoding: 'utf8', timeout: 15_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

const SERVICE = 'forja';

/** Linux: libsecret's secret-tool (GNOME Keyring, KWallet via the Secret Service). */
export class SecretToolKeyring implements Keyring {
  readonly id = 'secret-tool (Secret Service)';
  constructor(
    private readonly bin = 'secret-tool',
    private readonly exec: Run = run,
  ) {}

  get(account: string): string | null {
    const r = this.exec(this.bin, ['lookup', 'servicio', SERVICE, 'cuenta', account]);
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : null;
  }

  set(account: string, secret: string): void {
    const r = this.exec(this.bin, ['store', '--label=Forja: clave de la bóveda', 'servicio', SERVICE, 'cuenta', account], secret);
    if (r.status !== 0) throw new Error('el llavero del sistema rechazó guardar la clave');
  }

  delete(account: string): boolean {
    return this.exec(this.bin, ['clear', 'servicio', SERVICE, 'cuenta', account]).status === 0;
  }
}

/** macOS: Keychain through `security`; writes go through `security -i` so the value is not in argv. */
export class MacKeychain implements Keyring {
  readonly id = 'Llavero de macOS';
  constructor(private readonly exec: Run = run) {}

  get(account: string): string | null {
    const r = this.exec('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : null;
  }

  set(account: string, secret: string): void {
    const quote = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
    const r = this.exec('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${quote(account)} -w ${quote(secret)}\n`);
    if (r.status !== 0) throw new Error('el llavero de macOS rechazó guardar la clave');
  }

  delete(account: string): boolean {
    return this.exec('security', ['delete-generic-password', '-s', SERVICE, '-a', account]).status === 0;
  }
}

/** The keyring of this machine, or null when there is none usable. */
export function systemKeyring(exec: Run = run): Keyring | null {
  if (process.platform === 'darwin') return exec('security', ['help']).status !== null ? new MacKeychain(exec) : null;
  const probe = exec('secret-tool', ['--version']);
  return probe.status !== null ? new SecretToolKeyring('secret-tool', exec) : null;
}

/** One entry per vault file: several FORJA_HOME on one machine do not share a key. */
export const vaultAccount = (vaultFile: string) => `boveda-${createHash('sha256').update(vaultFile).digest('hex').slice(0, 16)}`;
