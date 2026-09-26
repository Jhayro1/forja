import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PanelProjects } from '../../src/cli/panel-host.js';
import { RegistryProjectsBackend } from '../../src/cli/projects-backend.js';

let dir = '';
let home = '';
let user = '';
let host: PanelProjects;
let backend: RegistryProjectsBackend;
const prevHome = process.env.FORJA_HOME;
const prevCwd = process.cwd();

function repo(path: string): string {
  mkdirSync(path, { recursive: true });
  const g = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(path, 'index.js'), 'console.log(1)\n');
  g('add', '.');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  return path;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'forja-proy-')));
  home = join(dir, 'forja-home');
  user = join(dir, 'usuario');
  mkdirSync(user);
  process.env.FORJA_HOME = home;
  process.chdir(dir);
  host = new PanelProjects(() => []);
  backend = new RegistryProjectsBackend(home, host, user, false);
});
afterEach(() => {
  host.close();
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.FORJA_HOME;
  else process.env.FORJA_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('panel · proyectos', () => {
  it('importar una carpeta la registra y la deja como proyecto actual', async () => {
    const path = repo(join(user, 'mi-erp'));
    expect(backend.list()).toMatchObject({ proyectos: [], actual: null });
    const r = (await backend.importFolder(`  "${path}"  `)) as { proyecto: { nombre: string; id: string }; bloqueos: string[] };
    expect(r.proyecto.nombre).toBe('mi-erp');
    expect(r.bloqueos).toEqual([]);
    expect(host.context()?.checkout.path).toBe(path);
    const list = backend.list() as { actual: string; proyectos: { id: string; actual: boolean; existe: boolean }[] };
    expect(list.actual).toBe(r.proyecto.id);
    expect(list.proyectos).toMatchObject([{ id: r.proyecto.id, actual: true, existe: true }]);
  });

  it('una carpeta que no es repositorio git se rechaza con un mensaje claro', async () => {
    mkdirSync(join(user, 'suelta'));
    await expect(backend.importFolder(join(user, 'suelta'))).rejects.toThrow(/no es un repositorio git/);
    await expect(backend.importFolder(join(user, 'no-existe'))).rejects.toThrow(/no existe la carpeta/);
  });

  it('crear, cambiar y archivar', async () => {
    const a = (await backend.create('uno', null)) as { proyecto: { id: string; ruta: string } };
    expect(a.proyecto.ruta).toBe(join(user, 'uno'));
    const b = (await backend.create('dos', '~/trabajo')) as { proyecto: { id: string; ruta: string } };
    expect(b.proyecto.ruta).toBe(join(user, 'trabajo', 'dos'));
    expect(host.context()?.config.nombre).toBe('dos');
    backend.select(a.proyecto.id);
    expect(host.context()?.config.nombre).toBe('uno');
    backend.archive(a.proyecto.id);
    expect(host.context()).toBeNull();
    expect((backend.list() as { proyectos: unknown[] }).proyectos).toHaveLength(1);
  });

  it('explorar carpetas: marca los repos, sube hasta la raíz y no sale de ella', () => {
    repo(join(user, 'app'));
    mkdirSync(join(user, 'docs', 'sub'), { recursive: true });
    mkdirSync(join(user, 'node_modules'));
    mkdirSync(join(user, '.oculta'));
    const top = backend.browse(null) as { ruta: string; padre: string | null; carpetas: { nombre: string; repo: boolean }[] };
    expect(top.ruta).toBe(user);
    expect(top.padre).toBeNull();
    expect(top.carpetas.map((c) => [c.nombre, c.repo]).sort()).toEqual([
      ['app', true],
      ['docs', false],
    ]);
    const docs = backend.browse(join(user, 'docs')) as { padre: string; carpetas: { nombre: string }[] };
    expect(docs.padre).toBe(user);
    expect(docs.carpetas.map((c) => c.nombre)).toEqual(['sub']);
    expect(() => backend.browse('/etc')).toThrow(/sólo se pueden explorar/);
    expect(() => backend.browse(join(user, '..'))).toThrow(/sólo se pueden explorar/);
  });
});
