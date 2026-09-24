import { copyFileSync, existsSync } from 'node:fs';
import type { Command } from 'commander';
import { forjaHome } from '../../registry/home.js';
import { systemKeyring, vaultAccount } from '../../vault/keyring.js';
import { purgeBackups, restoreVault, Vault, VaultError, vaultPaths } from '../../vault/vault.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
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
      const pass = await vaultPassphrase('Clave nueva de la bóveda: ', process.env, null);
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
        // Keep the keyring in step: a stale saved key would lock the user out.
        const keyring = systemKeyring();
        const account = vaultAccount(vaultPaths(forjaHome()).file);
        if (keyring?.get(account)) keyring.set(account, next);
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
        const r = restoreVault(vaultPaths(forjaHome()), file, await vaultPassphrase('Clave de la copia: ', process.env, null));
        print(`✔ Restaurada (generación ${r.generation}).${r.previous ? ` La anterior quedó en ${r.previous}` : ''}`);
      } catch (error) {
        throw new CliError((error as Error).message, EXIT.precondition);
      }
    });

  boveda
    .command('purgar-copias')
    .description('borra copias cifradas viejas (conservan valores rotados o borrados)')
    .option('--conservar <n>', 'generaciones más recientes que se conservan', (v) => Number.parseInt(v, 10), 2)
    .requiredOption('--confirmar', 'confirma el borrado')
    .action(async (o: { conservar: number }) => {
      // Proves the user holds the key before deleting anything.
      await withVault(() => undefined);
      let r: ReturnType<typeof purgeBackups>;
      try {
        r = purgeBackups(vaultPaths(forjaHome()), o.conservar);
      } catch (error) {
        throw new CliError((error as Error).message, EXIT.input);
      }
      print(`✔ ${r.removed.length} copia(s) borrada(s); se conservan ${r.kept.length}${r.kept.length ? ` (${r.kept.join(', ')})` : ''}.`);
    });

  const llavero = boveda.command('llavero').description('guarda la clave de la bóveda en el llavero del sistema (evita FORJA_BOVEDA_CLAVE)');
  const keyringOrFail = () => {
    const k = systemKeyring();
    if (!k) throw new CliError('no hay llavero del sistema disponible (en Linux instala libsecret-tools: secret-tool)', EXIT.environment);
    return k;
  };
  const account = () => vaultAccount(vaultPaths(forjaHome()).file);

  llavero
    .command('guardar')
    .description('comprueba la clave abriendo la bóveda y la guarda en el llavero')
    .action(async () => {
      const k = keyringOrFail();
      const pass = await vaultPassphrase('Clave de la bóveda: ', process.env, null);
      try {
        Vault.open(vaultPaths(forjaHome()), pass).close();
      } catch (error) {
        throw new CliError((error as Error).message, EXIT.precondition);
      }
      k.set(account(), pass);
      print(`✔ Clave guardada en ${k.id}. Forja la usará sin preguntar; bórrala con forja boveda llavero olvidar.`);
    });

  llavero
    .command('olvidar')
    .description('borra la clave del llavero (la bóveda no cambia)')
    .action(() => {
      const k = keyringOrFail();
      print(k.delete(account()) ? '✔ Clave borrada del llavero.' : 'El llavero no tenía la clave.');
    });

  llavero
    .command('estado')
    .description('dice si la clave está en el llavero (nunca la muestra)')
    .action(() => {
      const k = systemKeyring();
      print(!k ? 'No hay llavero del sistema disponible.' : k.get(account()) ? `La clave está guardada en ${k.id}.` : `${k.id} disponible; la clave no está guardada.`);
    });
}
