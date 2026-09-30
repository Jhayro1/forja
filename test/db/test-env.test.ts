import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { launchDir } from '../../src/runtime/launcher.js';
import { runCommand } from '../../src/verify/commands.js';
import { ensureBuilt, RUNNER } from '../helpers/engine.js';

beforeAll(() => ensureBuilt());

describe('variables de la base de pruebas', () => {
  it('llegan al comando de pruebas, no quedan en disco y se tachan de la salida', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'forja-vars-'));
    const r = await runCommand(
      { dataDir, sandbox: false, timeoutMs: 20_000, runnerScript: RUNNER, secretEnv: { APP_DBPASSWORD: 'clave-super-secreta', APP_URL: 'jdbc:mysql://10.0.0.5:3306/devventas' } },
      dataDir,
      { executable: process.execPath, args: ['-e', 'console.log("clave=" + process.env.APP_DBPASSWORD + " url=" + process.env.APP_URL)'] },
    );
    expect(r.ok, r.output).toBe(true);
    expect(r.output).toContain('clave=');
    expect(r.output).not.toContain('clave-super-secreta');
    const dir = launchDir(dataDir, r.launchId);
    expect(existsSync(join(dir, 'variables.json'))).toBe(false);
    expect(readFileSync(join(dir, 'orden.json'), 'utf8')).not.toContain('clave-super-secreta');
    expect(readFileSync(join(dir, 'spool.jsonl'), 'utf8')).not.toContain('clave-super-secreta');
  });
});
