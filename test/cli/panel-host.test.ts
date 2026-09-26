import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectScope } from '../../src/api/server.js';
import { PanelProjects } from '../../src/cli/panel-host.js';
import { createProject } from '../../src/registry/projects.js';
import { Registry } from '../../src/registry/registry.js';

let dir = '';
let home = '';
const prevHome = process.env.FORJA_HOME;
const prevCwd = process.cwd();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'forja-panel-')));
  home = join(dir, 'home');
  process.env.FORJA_HOME = home;
  // Outside any repo: the CLI would fall back to the active project.
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.FORJA_HOME;
  else process.env.FORJA_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

async function project(name: string): Promise<string> {
  const reg = Registry.open(home);
  try {
    return (await createProject(reg, name, join(dir, name))).checkout.checkout_id;
  } finally {
    reg.close();
  }
}

describe('panel: proyecto elegido en caliente', () => {
  it('sin proyectos arranca vacío (lo global sigue funcionando)', () => {
    const host = new PanelProjects(() => []);
    host.openDefault();
    expect(host.current()).toBeNull();
    expect(host.context()).toBeNull();
    host.close();
  });

  it('cambiar de proyecto avisa antes de cerrar el anterior y lo deja activo para la CLI', async () => {
    const a = await project('uno');
    const b = await project('dos');
    const host = new PanelProjects(() => []);
    const left: ProjectScope[] = [];
    host.onLeave((s) => {
      // Still readable here: the previous store closes only after listeners run.
      expect(s.feed.lastSeq()).toBeGreaterThanOrEqual(0);
      left.push(s);
    });

    host.select(a);
    expect(host.current()?.feed.checkoutId).toBe(a);
    expect(host.context()?.config.nombre).toBe('uno');

    host.select(b);
    expect(left.map((s) => s.feed.checkoutId)).toEqual([a]);
    expect(host.context()?.config.nombre).toBe('dos');
    expect(() => left[0]!.feed.lastSeq()).toThrow();

    const reg = Registry.open(home);
    expect(reg.active()?.checkout_id).toBe(b);
    reg.close();

    // A new panel opens the one used last.
    const again = new PanelProjects(() => []);
    again.openDefault();
    expect(again.context()?.config.nombre).toBe('dos');
    again.close();
    host.close();
  });

  it('un proyecto inexistente no rompe el que estaba abierto', async () => {
    const a = await project('uno');
    const host = new PanelProjects(() => []);
    host.select(a);
    expect(() => host.select('chk_NOEXISTE')).toThrow();
    expect(host.context()?.config.nombre).toBe('uno');
    host.close();
  });
});
