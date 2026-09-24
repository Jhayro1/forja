import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DirWatchSet, Waker } from '../../src/util/waker.js';

describe('esperas que reaccionan a eventos (MEJORAS 2.6)', () => {
  it('notify despierta la espera en curso o la siguiente; sin avisos vence el respaldo', async () => {
    const w = new Waker();
    let t = Date.now();
    setTimeout(() => w.notify(), 20);
    await w.wait(5000);
    expect(Date.now() - t).toBeLessThan(1000);
    w.notify();
    t = Date.now();
    await w.wait(5000);
    expect(Date.now() - t).toBeLessThan(50);
    t = Date.now();
    await w.wait(60);
    expect(Date.now() - t).toBeGreaterThanOrEqual(55);
  });

  it('un archivo que aparece en un directorio vigilado despierta; los que no pasan el filtro no', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-watch-'));
    try {
      const w = new Waker();
      const set = new DirWatchSet(
        () => w.notify(),
        (f) => f === 'resultado.json',
      );
      set.sync([dir, join(dir, 'no-existe')]);
      writeFileSync(join(dir, 'otro.txt'), 'x');
      const t0 = Date.now();
      await w.wait(300);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
      setTimeout(() => writeFileSync(join(dir, 'resultado.json'), '{}'), 20);
      const t1 = Date.now();
      await w.wait(5000);
      expect(Date.now() - t1).toBeLessThan(2000);
      set.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
