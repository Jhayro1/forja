import { copyFileSync, existsSync } from 'node:fs';
import type { Command } from 'commander';
import { forjaHome } from '../../registry/home.js';
import { Vault, VaultError, restoreVault, vaultPaths } from '../../vault/vault.js';
import { CliError, EXIT, print, printJson, type GlobalOptions } from '../context.js';
import { readSecret, vaultPassphrase } from '../secret-input.js';

async function openVault(): Promise<Vault> {
  try {
    return Vault.open(vaultPaths(forjaHome()), await vaultPassphrase());
  } catch (error) {
    if (error instanceof VaultError) throw new CliError(error.message, EXIT.precondition);
    throw error;
  }
}

async function withVault<T>(fn: (v: Vault) => T | Promise<T>): Promise<T> {
  const v = await openVault();
  try {
    return await fn(v);
  } catch (error) {
    if (error instanceof VaultError) throw new CliError(error.message, EXIT.input);
    throw error;
  } finally {
    v.close();
  }
}

export function registerVaultCommands(program: Command): void {
  const boveda = program.command('boveda').description('secretos cifrados en esta máquina (nunca en el repo ni en los agentes)');

  boveda
    .command('iniciar')
    .description('crea la bóveda con una clave de al menos 12 caracteres')
    .action(async () => {
      const paths = vaultPaths(forjaHome());
      if (Vault.exists(paths)) throw new CliError('ya existe una bóveda', EXIT.precondition);
      const pass = await vaultPassphrase('Clave nueva de la bóveda: ');
      if (!process.env.FORJA_BOVEDA_CLAVE && process.stdin.isTTY && (await readSecret('Repite la clave: ')) !== pass) throw new CliError('las claves no coinciden');
      try {
        Vault.create(paths, pass).close();
      } catch (error) {
        throw new CliError((error as Error).message);
      }
      print(`✔ Bóveda creada en ${paths.file}`);
      print('  Si pierdes la clave, los secretos no se pueden recuperar.');
    });

  boveda
    .command('guardar <nombre>')
    .description('guarda o rota un secreto; el valor se pide sin eco o se lee de stdin')
    .action(async (name: string) => {
      const value = await readSecret(`Valor de ${name}: `);
      const info = await withVault((v) => v.set(name, value));
      print(`✔ ${info.name} guardado (versión ${info.version}${info.previous_versions ? `; se conservan ${info.previous_versions} anteriores` : ''})`);
    });

  boveda
    .command('listar')
    .description('nombres y versiones (nunca los valores)')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const list = await withVault((v) => v.list());
      if (g.json) return printJson({ secretos: list });
      if (!list.length) return print('La bóveda está vacía.');
      for (const s of list) print(`  ${s.name.padEnd(28)} v${s.version}  ${s.created_at.slice(0, 16).replace('T', ' ')}${s.previous_versions ? `  (+${s.previous_versions} anteriores)` : ''}`);
    });

  boveda
    .command('borrar <nombre>')
    .description('borra los valores de un secreto (las copias anteriores cifradas aún los contienen)')
    .requiredOption('--confirmar', 'confirma el borrado')
    .action(async (name: string) => {
      await withVault((v) => v.remove(name));
      print(`✔ ${name} borrado`);
    });

  boveda
    .command('cambiar-clave')
    .description('vuelve a cifrar todo con una clave nueva (la copia anterior queda en boveda/copias)')
    .action(async () => {
      await withVault(async (v) => {
        const next = await readSecret('Clave nueva: ');
        if (process.stdin.isTTY && (await readSecret('Repite la clave nueva: ')) !== next) throw new CliError('las claves no coinciden');
        v.changePassphrase(next);
      });
      print('✔ Clave cambiada. La copia anterior sigue cifrada con la clave vieja en boveda/copias.');
    });

  boveda
    .command('verificar')
    .description('comprueba que la bóveda abre, no está manipulada ni es una copia vieja')
    .action(async () => {
      const gen = await withVault((v) => ({ generation: v.generation, secrets: v.list().length }));
      print(`✔ Bóveda íntegra: generación ${gen.generation}, ${gen.secrets} secreto(s)`);
    });

  boveda
    .command('copia <destino>')
    .description('copia el archivo cifrado (sigue protegido por la clave)')
    .action(async (dest: string) => {
      const paths = vaultPaths(forjaHome());
      if (!Vault.exists(paths)) throw new CliError('no hay bóveda', EXIT.precondition);
      if (existsSync(dest)) throw new CliError(`${dest} ya existe`);
      copyFileSync(paths.file, dest);
      print(`✔ Copia cifrada en ${dest}`);
    });

  boveda
    .command('restaurar <archivo>')
    .description('reemplaza la bóveda por una copia verificada (la actual se aparta, no se borra)')
    .requiredOption('--confirmar', 'confirma la restauración')
    .action(async (file: string) => {
      try {
        const r = restoreVault(vaultPaths(forjaHome()), file, await vaultPassphrase('Clave de la copia: '));
        print(`✔ Restaurada (generación ${r.generation}).${r.previous ? ` La anterior quedó en ${r.previous}` : ''}`);
      } catch (error) {
        throw new CliError((error as Error).message, EXIT.precondition);
      }
    });
}
