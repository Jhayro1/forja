import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AccountProviderName, AccountsBackend } from '../api/modules/accounts.js';
import type { Provider, SystemBackend } from '../api/modules/system.js';
import { detectPlatform, type Exec, overall, realExec, runChecks } from '../doctor/checks.js';
import { AccountStore, PRINCIPAL } from '../providers/accounts.js';
import { JobRunner } from './jobs.js';
import { ProviderLogins } from './provider-login.js';

export const PROVIDER_PACKAGES: Record<Provider, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

/** The npm that belongs to the Node running Forja (so a global install lands where Forja looks). */
export function npmBin(nodePath = process.execPath): string {
  const sibling = join(dirname(nodePath), 'npm');
  return existsSync(sibling) ? sibling : 'npm';
}

const CACHE_MS = 30_000;

/** `forja doctor` plus installing and signing in to the providers, for the panel. */
export class MachineSystemBackend implements SystemBackend, AccountsBackend {
  private cache: { at: number; value: object } | null = null;
  private readonly jobs: JobRunner;
  readonly accountStore: AccountStore;

  constructor(
    home: string,
    private readonly logins: ProviderLogins = new ProviderLogins(),
    private readonly exec: Exec = realExec,
    jobs?: JobRunner,
    private readonly npm: string = npmBin(),
  ) {
    this.jobs = jobs ?? new JobRunner(join(home, 'trabajos'));
    this.accountStore = new AccountStore(home);
  }

  async overview(refresh: boolean): Promise<object> {
    const latest = this.jobs.list(1)[0] ?? null;
    // A finished install or sign-in changes what doctor says: don't serve a stale answer.
    const stale = latest?.estado === 'corriendo' || (['claude', 'codex'] as const).some((p) => this.logins.get(p)?.estado === 'listo');
    if (refresh || stale || !this.cache || Date.now() - this.cache.at > CACHE_MS) {
      const platform = detectPlatform();
      const checks = await runChecks(this.exec, platform);
      this.cache = { at: Date.now(), value: { estado: overall(checks), checks, plataforma: platform } };
    }
    return { ...this.cache.value, trabajo: latest, sesiones: { claude: this.logins.get('claude'), codex: this.logins.get('codex') } };
  }

  install(provider: Provider): object {
    this.cache = null;
    return this.jobs.start(`instalar-${provider}`, {
      title: `Instalar ${provider === 'claude' ? 'Claude Code' : 'Codex'}`,
      file: this.npm,
      args: ['install', '-g', '--no-audit', '--no-fund', PROVIDER_PACKAGES[provider]],
      cwd: dirname(this.npm) === '.' ? process.cwd() : dirname(this.npm),
    });
  }

  job(id: string): object | null {
    const trabajo = this.jobs.view(id);
    return trabajo ? { trabajo, salida: this.jobs.output(id) } : null;
  }

  login(provider: Provider): object {
    this.cache = null;
    return this.logins.start(provider, PRINCIPAL, this.accountStore.envFor(provider, PRINCIPAL));
  }

  loginState(provider: Provider): object | null {
    return this.logins.get(provider);
  }

  submitCode(provider: Provider, code: string): object {
    return this.logins.submitCode(provider, code);
  }

  cancelLogin(provider: Provider): object | null {
    return this.logins.cancel(provider);
  }

  accounts(): object {
    return this.accountStore.list().map((a) => ({
      ...a,
      sesion_iniciada: this.accountStore.signedIn(a.proveedor, a.alias),
      carpeta: this.accountStore.configDir(a.proveedor, a.alias),
      inicio_sesion: this.logins.get(a.proveedor, a.alias),
    }));
  }

  addAccount(provider: AccountProviderName, alias: string): object {
    return this.accountStore.add(provider, alias);
  }

  updateAccount(provider: AccountProviderName, alias: string, patch: { activa?: boolean; max_agentes?: number | null }): object {
    return this.accountStore.update(provider, alias, patch);
  }

  removeAccount(provider: AccountProviderName, alias: string): void {
    this.logins.cancel(provider, true, alias);
    this.accountStore.remove(provider, alias);
  }

  accountLogin(provider: AccountProviderName, alias: string): object {
    if (!this.accountStore.get(provider, alias)) throw new Error(`no existe la cuenta ${provider}@${alias}`);
    this.cache = null;
    return this.logins.start(provider, alias, this.accountStore.envFor(provider, alias));
  }

  accountCode(provider: AccountProviderName, alias: string, code: string): object {
    return this.logins.submitCode(provider, code, alias);
  }

  accountCancel(provider: AccountProviderName, alias: string): object | null {
    return this.logins.cancel(provider, false, alias);
  }

  close(): void {
    this.logins.close();
  }
}
