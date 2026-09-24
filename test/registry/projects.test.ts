import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, readConfig } from '../../src/registry/config.js';
import { inspectRepo } from '../../src/registry/inspect.js';
import { LockFile, LockHeldError } from '../../src/registry/lock.js';
import { createProject, importProject, ProjectError, resolveCheckout } from '../../src/registry/projects.js';
import { Registry } from '../../src/registry/registry.js';

let dir: string;
let registry: Registry;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'forja-reg-')));
  registry = Registry.open(join(dir, 'home'));
});
afterEach(() => {
  registry.close();
  rmSync(dir, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

describe('proyectos', () => {
  it('nuevo: crea repo con commit inicial y forja.yaml válido', async () => {
    const { checkout, config } = await createProject(registry, 'demo', join(dir, 'demo'));
    expect(readConfig(checkout.path).project_id).toBe(config.project_id);
    expect(config.ejecucion.paralelo).toBe(3);
    expect(config.roles.planeador).toContain('codex:gpt-6-astra');
    expect(sh(checkout.path, 'log', '--oneline')).toContain('forja: proyecto nuevo');
    expect(registry.active()?.checkout_id).toBe(checkout.checkout_id);
  });

  it('nuevo: no pisa una carpeta con contenido', async () => {
    mkdirSync(join(dir, 'x'));
    writeFileSync(join(dir, 'x', 'a.txt'), 'hola');
    await expect(createProject(registry, 'x', join(dir, 'x'))).rejects.toThrow(ProjectError);
  });

  it('dos clones del mismo proyecto son dos checkouts distintos', async () => {
    const { checkout } = await createProject(registry, 'demo', join(dir, 'demo'));
    sh(dir, 'clone', '-q', checkout.path, join(dir, 'clon'));
    const imported = await importProject(registry, join(dir, 'clon'));
    expect(imported.checkout.project_id).toBe(checkout.project_id);
    expect(imported.checkout.checkout_id).not.toBe(checkout.checkout_id);
    expect(() => resolveCheckout(registry, { project: 'demo' })).toThrow(/hay 2 proyectos/);
    expect(resolveCheckout(registry, { project: join(dir, 'clon') }).checkout_id).toBe(imported.checkout.checkout_id);
  });

  it('resuelve por la carpeta actual', async () => {
    const { checkout } = await createProject(registry, 'demo', join(dir, 'demo'));
    mkdirSync(join(checkout.path, 'src', 'a'), { recursive: true });
    expect(resolveCheckout(registry, { cwd: join(checkout.path, 'src', 'a') }).checkout_id).toBe(checkout.checkout_id);
  });

  it('importar: sólo inspecciona y señala bloqueos', async () => {
    const repo = join(dir, 'vacio');
    mkdirSync(repo);
    sh(repo, 'init', '-q');
    const inspection = await inspectRepo(repo);
    expect(inspection.hasCommits).toBe(false);
    expect(inspection.blockers[0]).toMatch(/no tiene commits/);
  });

  it('importar: detecta cambios sin commit y lenguajes', async () => {
    const repo = join(dir, 'ts');
    mkdirSync(repo);
    sh(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.ts'), 'export {}');
    writeFileSync(join(repo, 'package.json'), '{}');
    sh(repo, 'add', '-A');
    sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i');
    writeFileSync(join(repo, 'b.ts'), 'x');
    const { inspection, createdConfig } = await importProject(registry, repo);
    expect(inspection.languages).toEqual(['typescript']);
    expect(inspection.manifests).toContain('package.json');
    expect(inspection.warnings[0]).toMatch(/sin commit/);
    expect(createdConfig).toBe(true);
  });

  it('forja.yaml con claves desconocidas es un error', async () => {
    const { checkout } = await createProject(registry, 'demo', join(dir, 'demo'));
    writeFileSync(join(checkout.path, 'forja.yaml'), 'schema_version: 1\nproject_id: prj_01M3A9EACH225PY14R95F392B4\nnombre: d\nsandbox: desactivado\n');
    expect(() => readConfig(checkout.path)).toThrow(ConfigError);
  });
});

describe('bloqueo por proyecto', () => {
  it('un segundo dueño vivo es rechazado; un bloqueo huérfano se recupera', () => {
    const path = join(dir, 'lock');
    const lock = LockFile.acquire(path, 'ejecutar');
    expect(() => LockFile.acquire(path, 'ejecutar')).toThrow(LockHeldError);
    lock.release();
    writeFileSync(path, JSON.stringify({ pid: 999_999_999, start: '1' }));
    LockFile.acquire(path, 'ejecutar').release();
  });
});
