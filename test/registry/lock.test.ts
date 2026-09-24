import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const LOCK_JS = resolve('dist/registry/lock.js');

/** A separate process that tries to take the lock and holds it for a moment. */
function contender(path: string, at: number): Promise<string> {
  // All contenders spin until the same instant, so their attempts really overlap.
  const script = `import { LockFile } from ${JSON.stringify(LOCK_JS)};
while (Date.now() < ${at});
try { const l = LockFile.acquire(${JSON.stringify(path)}, 'prueba'); process.stdout.write('gana'); setTimeout(() => l.release(), 400); }
catch (e) { process.stdout.write(e.constructor.name); }`;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('error', fail);
    child.on('close', () => done(out));
  });
}

describe('bloqueo exclusivo entre procesos', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('con muchos procesos a la vez sólo uno lo toma y no quedan temporales', async () => {
    dir = mkdtempSync(join(tmpdir(), 'forja-lock-'));
    const path = join(dir, 'x.lock');
    const at = Date.now() + 1500;
    const results = await Promise.all(Array.from({ length: 12 }, () => contender(path, at)));
    expect(results.filter((r) => r === 'gana')).toHaveLength(1);
    expect(results.filter((r) => r !== 'gana').every((r) => r === 'LockHeldError')).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});
