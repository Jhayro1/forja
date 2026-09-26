import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Provider, SystemBackend } from '../api/modules/system.js';
import { detectPlatform, type Exec, overall, realExec, runChecks } from '../doctor/checks.js';
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
export class MachineSystemBackend implements SystemBackend {
  private cache: { at: number; value: object } | null = null;
  private readonly jobs: JobRunner;

  constructor(
    home: string,
    private readonly logins: ProviderLogins = new ProviderLogins(),
    private readonly exec: Exec = realExec,
    jobs?: JobRunner,
    private readonly npm: string = npmBin(),
  ) {
    this.jobs = jobs ?? new JobRunner(join(home, 'trabajos'));
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
    return this.logins.start(provider);
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

  close(): void {
    this.logins.close();
  }
}
