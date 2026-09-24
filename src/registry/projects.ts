import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FORJA_AUTHOR, git } from '../git/git.js';
import { newId } from '../domain/ids.js';
import { CONFIG_FILE, ForjaConfig, findRepoRoot, readConfig, writeConfig } from './config.js';
import { inspectRepo, type RepoInspection } from './inspect.js';
import type { CheckoutRow, Registry } from './registry.js';

export class ProjectError extends Error {}

function defaultConfig(name: string): ForjaConfig {
  return ForjaConfig.parse({ schema_version: 1, project_id: newId('prj'), nombre: name });
}

export async function createProject(registry: Registry, name: string, dir: string): Promise<{ checkout: CheckoutRow; config: ForjaConfig }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) throw new ProjectError('nombre inválido: usa letras, números, punto, guion o guion bajo');
  const path = resolve(dir);
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new ProjectError(`${path} ya existe y no está vacía; si es un repo, usa: forja importar ${path}`);
  }
  mkdirSync(path, { recursive: true });
  await git(path, ['init', '-q', '-b', 'main']);
  const config = defaultConfig(name);
  writeConfig(path, config);
  mkdirSync(join(path, '.forja'), { recursive: true });
  writeFileSync(join(path, '.forja', 'README.md'), '# .forja\n\nEspecificación, plan, tareas y decisiones de este proyecto. Se versiona con el código.\n');
  writeFileSync(join(path, '.gitignore'), 'node_modules/\n');
  await git(path, ['add', '-A']);
  await git(path, ['commit', '-q', '-m', 'forja: proyecto nuevo'], { env: FORJA_AUTHOR });
  const real = realpathSync(path);
  const checkout = registry.register(config.project_id, config.nombre, real);
  registry.setActive(checkout.checkout_id);
  return { checkout, config };
}

export async function importProject(
  registry: Registry,
  dir: string,
): Promise<{ checkout: CheckoutRow; config: ForjaConfig; inspection: RepoInspection; createdConfig: boolean }> {
  const inspection = await inspectRepo(resolve(dir));
  const root = realpathSync(inspection.root);
  let createdConfig = false;
  let config: ForjaConfig;
  if (existsSync(join(root, CONFIG_FILE))) {
    config = readConfig(root);
  } else {
    config = defaultConfig(root.split('/').pop() || 'proyecto');
    writeConfig(root, config);
    createdConfig = true;
  }
  const checkout = registry.register(config.project_id, config.nombre, root);
  registry.setActive(checkout.checkout_id);
  return { checkout, config, inspection, createdConfig };
}

/**
 * Which project a command acts on: --proyecto, else the repo of the cwd, else the
 * active one. A duplicated name is never resolved arbitrarily (v2/10).
 */
export function resolveCheckout(registry: Registry, options: { project?: string; cwd?: string }): CheckoutRow {
  if (options.project) {
    const byId = registry.byId(options.project);
    if (byId) return byId;
    if (/[/.]/.test(options.project) && existsSync(options.project)) {
      const byPath = registry.byPath(realpathSync(options.project));
      if (byPath) return byPath;
    }
    const matches = registry.byName(options.project);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new ProjectError(`hay ${matches.length} proyectos llamados «${options.project}»; usa el id:\n${matches.map((m) => `  ${m.checkout_id}  ${m.path}`).join('\n')}`);
    }
    throw new ProjectError(`no existe el proyecto «${options.project}»`);
  }
  const root = findRepoRoot(options.cwd ?? process.cwd());
  if (root) {
    const row = registry.byPath(realpathSync(root));
    if (row) return row;
    throw new ProjectError(`${root} tiene forja.yaml pero no está registrado en esta máquina; ejecuta: forja importar ${root}`);
  }
  const active = registry.active();
  if (active && !active.archived) return active;
  const all = registry.list();
  if (all.length === 0) throw new ProjectError('no hay proyectos; crea uno con: forja nuevo <nombre>');
  throw new ProjectError(`¿qué proyecto? Usa --proyecto o entra a su carpeta:\n${all.map((c) => `  ${c.name.padEnd(20)} ${c.path}`).join('\n')}`);
}
