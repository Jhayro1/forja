import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashBytes } from '../domain/hash.js';
import { git } from '../git/git.js';

export type BackupFile = { path: string; bytes: number; sha256: string };
export type BackupManifest = {
  version: 1;
  created_at: string;
  checkout_id: string;
  files: BackupFile[];
  git_refs: { ref: string; sha: string }[];
};

const MANIFEST = 'manifiesto.json';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function describe(root: string, file: string): BackupFile {
  const data = readFileSync(file);
  return { path: relative(root, file), bytes: data.length, sha256: hashBytes(data) };
}

/**
 * Consistent snapshot at a safe point: DB via VACUUM INTO (not a copy of the live
 * file), launch artifacts, and Forja's git refs as a bundle. Copying only the .db
 * is not a backup procedure (v2/05).
 */
export async function createBackup(opts: { dataDir: string; repoPath: string; checkoutId: string; branchPrefix: string; now?: Date }): Promise<{ id: string; dir: string; manifest: BackupManifest }> {
  const now = opts.now ?? new Date();
  const id = now.toISOString().replace(/[:.]/g, '-');
  const dir = join(opts.dataDir, 'copias', id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(join(opts.dataDir, 'estado.db'));
  try {
    db.prepare('VACUUM INTO ?').run(join(dir, 'estado.db'));
  } finally {
    db.close();
  }
  const launches = join(opts.dataDir, 'lanzamientos');
  if (existsSync(launches)) cpSync(launches, join(dir, 'lanzamientos'), { recursive: true, filter: (src) => !src.endsWith('.sock') && !src.endsWith('.lock') });

  const refsOut = await git(opts.repoPath, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${opts.branchPrefix}`]);
  const git_refs = refsOut.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, sha] = line.split(' ') as [string, string];
      return { ref, sha };
    });
  if (git_refs.length > 0) await git(opts.repoPath, ['bundle', 'create', '-q', join(dir, 'ramas.bundle'), ...git_refs.map((r) => r.ref)]);

  const manifest: BackupManifest = {
    version: 1,
    created_at: now.toISOString(),
    checkout_id: opts.checkoutId,
    files: walk(dir).map((f) => describe(dir, f)),
    git_refs,
  };
  writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const check = verifyBackup(dir);
  if (!check.ok) throw new Error(`la copia recién creada no pasó la verificación: ${check.problems.join('; ')}`);
  return { id, dir, manifest };
}

export type VerifyResult = { ok: boolean; problems: string[]; manifest: BackupManifest | null };

/** Every file present with its exact size and hash, and the DB passes integrity_check. */
export function verifyBackup(dir: string): VerifyResult {
  const problems: string[] = [];
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as BackupManifest;
  } catch {
    return { ok: false, problems: ['falta o está dañado el manifiesto'], manifest: null };
  }
  for (const f of manifest.files) {
    const full = join(dir, f.path);
    if (!existsSync(full)) {
      problems.push(`falta ${f.path}`);
      continue;
    }
    if (statSync(full).size !== f.bytes) problems.push(`${f.path}: tamaño distinto (${statSync(full).size} ≠ ${f.bytes})`);
    else if (hashBytes(readFileSync(full)) !== f.sha256) problems.push(`${f.path}: el contenido no coincide con el hash`);
  }
  if (!manifest.files.some((f) => f.path === 'estado.db')) problems.push('la copia no incluye estado.db');
  else if (problems.length === 0) {
    const db = new DatabaseSync(join(dir, 'estado.db'), { readOnly: true });
    try {
      const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (row.integrity_check !== 'ok') problems.push(`estado.db: ${row.integrity_check}`);
    } finally {
      db.close();
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}

export function listBackups(dataDir: string): { id: string; dir: string; ok: boolean; created_at: string | null }[] {
  const root = join(dataDir, 'copias');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .reverse()
    .map((id) => {
      const dir = join(root, id);
      const v = verifyBackup(dir);
      return { id, dir, ok: v.ok, created_at: v.manifest?.created_at ?? null };
    });
}

/**
 * Restores a verified copy. The current state is moved aside, never deleted (R08),
 * and only Forja's own branches are touched in the repo.
 */
export async function restoreBackup(opts: { dataDir: string; repoPath: string; backupId: string; now?: Date }): Promise<{ previousStateDir: string; refs: number }> {
  const dir = join(opts.dataDir, 'copias', opts.backupId);
  const check = verifyBackup(dir);
  if (!check.ok || !check.manifest) throw new Error(`no se restaura una copia que no pasa la verificación: ${check.problems.join('; ')}`);
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const previousStateDir = join(opts.dataDir, `estado-previo-${stamp}`);
  mkdirSync(previousStateDir, { recursive: true, mode: 0o700 });
  for (const name of ['estado.db', 'estado.db-wal', 'estado.db-shm', 'lanzamientos']) {
    const src = join(opts.dataDir, name);
    if (existsSync(src)) renameSync(src, join(previousStateDir, name));
  }
  cpSync(join(dir, 'estado.db'), join(opts.dataDir, 'estado.db'));
  if (existsSync(join(dir, 'lanzamientos'))) cpSync(join(dir, 'lanzamientos'), join(opts.dataDir, 'lanzamientos'), { recursive: true });
  if (check.manifest.git_refs.length > 0) {
    const specs = check.manifest.git_refs.map((r) => `+${r.ref}:${r.ref}`);
    await git(opts.repoPath, ['fetch', '-q', join(dir, 'ramas.bundle'), ...specs]);
  }
  return { previousStateDir, refs: check.manifest.git_refs.length };
}
