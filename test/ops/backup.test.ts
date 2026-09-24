import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTask } from '../../src/core/task-commands.js';
import { createBackup, listBackups, restoreBackup, verifyBackup } from '../../src/ops/backup.js';
import { EventStore } from '../../src/store/event-store.js';

let dir: string;
let dataDir: string;
let repo: string;
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'forja-bk-')));
  dataDir = join(dir, 'data');
  repo = join(dir, 'repo');
  mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), '1');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'base');
  sh(repo, 'branch', 'forja/run/x/integracion');
  mkdirSync(join(dataDir, 'lanzamientos', 'lan_1'), { recursive: true });
  writeFileSync(join(dataDir, 'lanzamientos', 'lan_1', 'spool.jsonl'), '{"seq":1}\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(n: number) {
  const store = EventStore.open(join(dataDir, 'estado.db'), 'chk_1');
  for (let i = 0; i < n; i++) createTask(store, `r${i}`, { run_id: 'run_1', task_id: `T-${i}`, title: `t${i}` });
  store.close();
}

describe('copias de seguridad', () => {
  it('crea una copia verificada con base, lanzamientos y ramas de Forja', async () => {
    seed(3);
    const { dir: bk, manifest } = await createBackup({ dataDir, repoPath: repo, checkoutId: 'chk_1', branchPrefix: 'forja/' });
    expect(verifyBackup(bk).ok).toBe(true);
    expect(manifest.files.map((f) => f.path).sort()).toEqual(['estado.db', 'lanzamientos/lan_1/spool.jsonl', 'ramas.bundle']);
    expect(manifest.git_refs.map((r) => r.ref)).toEqual(['refs/heads/forja/run/x/integracion']);
  });

  it('detecta una copia alterada o incompleta', async () => {
    seed(1);
    const { dir: bk } = await createBackup({ dataDir, repoPath: repo, checkoutId: 'chk_1', branchPrefix: 'forja/' });
    appendFileSync(join(bk, 'lanzamientos/lan_1/spool.jsonl'), 'x');
    expect(verifyBackup(bk).problems[0]).toMatch(/tamaño distinto/);
    rmSync(join(bk, 'ramas.bundle'));
    expect(verifyBackup(bk).problems).toContain('falta ramas.bundle');
    expect(listBackups(dataDir)[0]?.ok).toBe(false);
  });

  it('restaura: vuelve el estado de la copia y el actual queda aparte', async () => {
    seed(2);
    const { id } = await createBackup({ dataDir, repoPath: repo, checkoutId: 'chk_1', branchPrefix: 'forja/' });
    const store = EventStore.open(join(dataDir, 'estado.db'), 'chk_1');
    createTask(store, 'tarde', { run_id: 'run_1', task_id: 'T-9', title: 'después de la copia' });
    store.close();
    const integ = sh(repo, 'rev-parse', 'forja/run/x/integracion');
    sh(repo, 'branch', '-D', 'forja/run/x/integracion');

    const { previousStateDir } = await restoreBackup({ dataDir, repoPath: repo, backupId: id });
    const restored = EventStore.open(join(dataDir, 'estado.db'), 'chk_1');
    expect(restored.events()).toHaveLength(2);
    restored.close();
    expect(existsSync(join(previousStateDir, 'estado.db'))).toBe(true);
    expect(sh(repo, 'rev-parse', 'forja/run/x/integracion')).toBe(integ);
  });

  it('no restaura una copia que no pasa la verificación', async () => {
    seed(1);
    const { id, dir: bk } = await createBackup({ dataDir, repoPath: repo, checkoutId: 'chk_1', branchPrefix: 'forja/' });
    writeFileSync(join(bk, 'estado.db'), 'basura');
    await expect(restoreBackup({ dataDir, repoPath: repo, backupId: id })).rejects.toThrow(/no pasa la verificación/);
    expect(existsSync(join(dataDir, 'estado.db'))).toBe(true);
  });
});
