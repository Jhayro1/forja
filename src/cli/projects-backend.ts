import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type { ProjectsBackend } from '../api/modules/projects.js';
import { checkDestination, cloneEnv, parseRepo } from '../registry/clone.js';
import { trustRepo, UntrustedRepoError } from '../registry/inspect.js';
import { browseRoots, fromUserPath, isWsl, toWindowsPath } from '../registry/paths.js';
import { createProject, importProject } from '../registry/projects.js';
import { Registry } from '../registry/registry.js';
import { FORJA_BIN, JobRunner } from './jobs.js';
import type { PanelProjects } from './panel-host.js';

const HIDDEN = new Set(['node_modules', 'AppData', 'Application Data', 'Local Settings']);

/** The same registry and commands as `forja proyectos/usar/importar/nuevo`, for the panel. */
export class RegistryProjectsBackend implements ProjectsBackend {
  constructor(
    private readonly home: string,
    private readonly projects: PanelProjects,
    private readonly userHome: string = homedir(),
    private readonly wsl: boolean = isWsl(),
  ) {}

  private withRegistry<T>(fn: (r: Registry) => T): T {
    const registry = Registry.open(this.home);
    try {
      return fn(registry);
    } finally {
      registry.close();
    }
  }

  private resolve(input: string): string {
    const p = fromUserPath(input);
    return p === '~' || p.startsWith('~/') ? join(this.userHome, p.slice(2)) : p;
  }

  private view(path: string) {
    return { ruta: path, ruta_windows: this.wsl ? toWindowsPath(path) : null };
  }

  list(): object {
    const current = this.projects.context()?.checkout.checkout_id ?? null;
    const rows = this.withRegistry((r) => r.list());
    return {
      actual: current,
      wsl: this.wsl,
      proyectos: rows.map((c) => ({ id: c.checkout_id, nombre: c.name, ...this.view(c.path), existe: existsSync(c.path), usado: c.last_used_at, actual: c.checkout_id === current })),
    };
  }

  select(checkoutId: string): object {
    const ctx = this.projects.select(checkoutId);
    return { proyecto: { id: ctx.checkout.checkout_id, nombre: ctx.config.nombre, ...this.view(ctx.checkout.path) }, mensaje: `trabajando en «${ctx.config.nombre}»` };
  }

  async importFolder(input: string, trust = false): Promise<object> {
    const path = this.resolve(input);
    if (!existsSync(path)) throw new Error(`no existe la carpeta ${path}`);
    let result: Awaited<ReturnType<typeof importProject>>;
    try {
      result = await this.withRegistryAsync((r) => importProject(r, path));
    } catch (error) {
      if (!(error instanceof UntrustedRepoError)) throw error;
      // Git's ownership check: only the user can decide to trust this folder.
      if (!trust) return { requiere_confianza: true, ...this.view(error.root), mensaje: error.message };
      await trustRepo(error.root);
      result = await this.withRegistryAsync((r) => importProject(r, path));
    }
    const { checkout, inspection, createdConfig } = result;
    this.projects.select(checkout.checkout_id);
    return {
      proyecto: { id: checkout.checkout_id, nombre: checkout.name, ...this.view(checkout.path) },
      avisos: inspection.warnings,
      bloqueos: inspection.blockers,
      forja_yaml_creado: createdConfig,
      mensaje: inspection.blockers.length ? 'importado, pero hay algo que resolver antes de trabajar' : `listo: «${checkout.name}» importado`,
    };
  }

  async create(name: string, parent: string | null): Promise<object> {
    const base = parent ? this.resolve(parent) : this.userHome;
    const { checkout } = await this.withRegistryAsync((r) => createProject(r, name, join(base, name)));
    this.projects.select(checkout.checkout_id);
    return { proyecto: { id: checkout.checkout_id, nombre: checkout.name, ...this.view(checkout.path) }, mensaje: `proyecto «${checkout.name}» creado` };
  }

  /**
   * `forja clonar` as a background job in the machine's job folder (the same one installs
   * use, so the panel shows its output like any other). Errors in the address, the token or
   * the destination are reported right away, before anything runs.
   */
  clone(repo: string, folder: string | null, token: string | null): object {
    const ref = parseRepo(repo);
    const env = cloneEnv(ref, token);
    const dest = folder ? this.resolve(folder) : join(this.userHome, 'proyectos', ref.name);
    checkDestination(dest);
    const jobs = new JobRunner(join(this.home, 'trabajos'));
    // Only the token reaches the job, through its environment; git's other settings are rebuilt by `forja clonar`.
    return jobs.start(
      'clonar',
      { title: `Clonar ${ref.name}`, file: process.execPath, args: [FORJA_BIN, 'clonar', ref.url, '--ruta', dest], cwd: this.userHome },
      env.GIT_CONFIG_COUNT && token ? { FORJA_GIT_TOKEN: token } : {},
    );
  }

  archive(checkoutId: string): object {
    const isCurrent = this.projects.context()?.checkout.checkout_id === checkoutId;
    if (isCurrent && this.projects.busy) throw new Error(`espera un momento: ${this.projects.busy}`);
    this.withRegistry((r) => {
      if (!r.byId(checkoutId)) throw new Error('ese proyecto no existe');
      r.setArchived(checkoutId, true);
    });
    if (isCurrent) this.projects.close();
    return {};
  }

  browse(input: string | null): object {
    const roots = browseRoots(this.userHome).filter((r) => existsSync(r));
    const requested = input ? this.resolve(input) : roots[0]!;
    const path = existsSync(requested) ? realpathSync(requested) : roots[0]!;
    const root = roots.find((r) => path === r || path.startsWith(r + sep));
    if (!root) throw new Error('sólo se pueden explorar tu carpeta personal y tu carpeta de usuario de Windows');
    let names: string[] = [];
    try {
      names = readdirSync(path);
    } catch {
      names = [];
    }
    const carpetas = names
      .filter((n) => !n.startsWith('.') && !HIDDEN.has(n))
      .map((n) => join(path, n))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      })
      .slice(0, 300)
      .map((p) => ({ nombre: p.split(sep).pop()!, ...this.view(p), repo: existsSync(join(p, '.git')) }));
    return {
      ...this.view(path),
      padre: path === root ? null : dirname(path),
      repo: existsSync(join(path, '.git')),
      raices: roots.map((r) => ({ ...this.view(r), nombre: r === this.userHome ? 'Linux (inicio)' : 'Windows (usuarios)' })),
      carpetas,
    };
  }

  private async withRegistryAsync<T>(fn: (r: Registry) => Promise<T>): Promise<T> {
    const registry = Registry.open(this.home);
    try {
      return await fn(registry);
    } finally {
      registry.close();
    }
  }
}
