import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNNING_FORJA_ROOT, supervisesItself } from '../../src/run/self-host.js';
import { ROOT } from '../helpers/engine.js';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Forja sobre Forja', () => {
  it('detecta cuando el Forja que supervisa vive dentro del repo que va a cambiar', () => {
    dir = mkdtempSync(join(tmpdir(), 'forja-self-'));
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'dist'), { recursive: true });
    mkdirSync(join(dir, 'estable'));
    expect(supervisesItself(repo, repo)).toBe(true);
    expect(supervisesItself(repo, join(repo, 'dist'))).toBe(true);
    expect(supervisesItself(repo, join(dir, 'estable'))).toBe(false);
    expect(supervisesItself(join(repo, 'dist'), repo)).toBe(false);
    // Through a symlink it is still the same place.
    symlinkSync(repo, join(dir, 'enlace'));
    expect(supervisesItself(join(dir, 'enlace'), repo)).toBe(true);
  });

  it('la raíz del Forja en ejecución es la del paquete', () => {
    expect(RUNNING_FORJA_ROOT).toBe(ROOT);
  });
});
