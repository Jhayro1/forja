import { join } from 'node:path';
import type { Command } from 'commander';
import { createBackup, listBackups, restoreBackup, verifyBackup } from '../../ops/backup.js';
import { type LockFile, LockHeldError } from '../../registry/lock.js';
import { acquireOrchestratorLock } from '../../run/process.js';
import { CliError, EXIT, type GlobalOptions, openProject, print, printJson } from '../context.js';

export function registerOpsCommands(program: Command): void {
  const backup = program.command('backup').description('copias de seguridad del estado del proyecto');

  backup
    .command('crear')
    .description('crea una copia verificada (estado, lanzamientos y ramas de Forja)')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openProject(g);
      try {
        const { id, dir, manifest } = await createBackup({
          dataDir: ctx.dataDir,
          repoPath: ctx.checkout.path,
          checkoutId: ctx.checkout.checkout_id,
          branchPrefix: ctx.config.git.prefijo,
        });
        const bytes = manifest.files.reduce((a, f) => a + f.bytes, 0);
        if (g.json) return printJson({ copia: { id, dir, manifest } });
        print(`✔ Copia ${id} creada y verificada`);
        print(`  ${dir}`);
        print(`  ${manifest.files.length} archivos · ${(bytes / 1024).toFixed(1)} KiB · ${manifest.git_refs.length} ramas de Forja`);
      } finally {
        ctx.close();
      }
    });

  backup
    .command('listar')
    .description('lista las copias y si pasan la verificación')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openProject(g);
      try {
        const rows = listBackups(ctx.dataDir);
        if (g.json) return printJson({ copias: rows });
        if (rows.length === 0) return print('No hay copias. Crea una con: forja backup crear');
        for (const r of rows) print(`${r.ok ? '✔' : '✘'} ${r.id}${r.ok ? '' : '  (no pasa la verificación)'}`);
      } finally {
        ctx.close();
      }
    });

  backup
    .command('verificar <id>')
    .description('comprueba archivos, tamaños, hashes e integridad de la base')
    .action((id: string, _o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openProject(g);
      try {
        const result = verifyBackup(join(ctx.dataDir, 'copias', id));
        if (g.json) return printJson({ verificacion: result });
        if (result.ok) print(`✔ La copia ${id} está completa`);
        else {
          print(`✘ La copia ${id} no pasa la verificación:`);
          for (const p of result.problems) print(`  - ${p}`);
          process.exitCode = EXIT.verification;
        }
      } finally {
        ctx.close();
      }
    });

  backup
    .command('restaurar <id>')
    .description('vuelve al estado de una copia; el estado actual se aparta, no se borra')
    .requiredOption('--confirmar', 'confirma que quieres restaurar')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openProject(g);
      let lock: LockFile | null = null;
      try {
        lock = acquireOrchestratorLock(ctx.dataDir, 'restaurar una copia');
        ctx.store.close();
        const { previousStateDir, refs } = await restoreBackup({ dataDir: ctx.dataDir, repoPath: ctx.checkout.path, backupId: id });
        print(`✔ Restaurada la copia ${id} (${refs} ramas de Forja)`);
        print(`  El estado anterior quedó en ${previousStateDir}`);
      } catch (error) {
        if (error instanceof LockHeldError) throw new CliError(`${error.message}; detén la ejecución antes de restaurar`, EXIT.precondition);
        throw new CliError((error as Error).message, EXIT.precondition);
      } finally {
        lock?.release();
        ctx.registry.close();
      }
    });
}
