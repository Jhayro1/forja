import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { detectProfile } from '../../profile/detect.js';
import { CloneError, cloneEnv, cloneRepo, parseRepo } from '../../registry/clone.js';
import { trustRepo, UntrustedRepoError } from '../../registry/inspect.js';
import { fromUserPath } from '../../registry/paths.js';
import { createProject, importProject, ProjectError, resolveCheckout } from '../../registry/projects.js';
import { CliError, EXIT, type GlobalOptions, print, printJson, withRegistry } from '../context.js';
import { showDetected } from './profile.js';

export function registerProjectCommands(program: Command): void {
  program
    .command('nuevo <nombre>')
    .description('crea un proyecto nuevo (carpeta, git y forja.yaml)')
    .option('--ruta <dir>', 'carpeta donde crearlo (por defecto ./<nombre>)')
    .action(async (name: string, opts: { ruta?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      await withRegistry(async (registry) => {
        try {
          const { checkout } = await createProject(registry, name, opts.ruta ?? resolve(name));
          if (g.json) return printJson({ proyecto: checkout });
          print(`✔ Proyecto «${checkout.name}» creado en ${checkout.path}`);
          print(`  Siguiente paso: cd ${checkout.path} && forja planear`);
        } catch (error) {
          if (error instanceof ProjectError) throw new CliError(error.message, EXIT.input);
          throw error;
        }
      });
    });

  program
    .command('clonar <repositorio>')
    .description('clona un repositorio (https o usuario/repo) en ~/proyectos y lo registra; para uno privado, el token va en FORJA_GIT_TOKEN')
    .option('--ruta <dir>', 'carpeta destino (por defecto ~/proyectos/<repo>)')
    .action(async (input: string, opts: { ruta?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      let ref: ReturnType<typeof parseRepo>;
      let env: Record<string, string>;
      try {
        ref = parseRepo(input);
        env = cloneEnv(ref, process.env.FORJA_GIT_TOKEN);
      } catch (error) {
        throw new CliError((error as Error).message, EXIT.input);
      }
      const dest = resolve(opts.ruta ? fromUserPath(opts.ruta) : join(homedir(), 'proyectos', ref.name));
      mkdirSync(dirname(dest), { recursive: true });
      print(`Clonando ${ref.url} en ${dest}…`);
      try {
        await cloneRepo(ref, dest, env, g.json ? () => {} : print);
      } catch (error) {
        throw new CliError((error as Error).message, error instanceof CloneError ? EXIT.precondition : EXIT.environment);
      }
      await withRegistry(async (registry) => {
        const { checkout, inspection } = await importProject(registry, dest).catch((error: Error) => {
          throw new CliError(`se clonó en ${dest}, pero no se pudo registrar: ${error.message}`, EXIT.precondition);
        });
        registry.setActive(checkout.checkout_id);
        if (g.json) return printJson({ proyecto: checkout, inspeccion: inspection });
        print(`✔ «${checkout.name}» clonado y registrado (${checkout.path})`);
        for (const w of inspection.warnings) print(`  ! ${w}`);
        for (const b of inspection.blockers) print(`  ✘ ${b}`);
      });
    });

  program
    .command('importar <ruta>')
    .description('registra un repositorio existente (sólo lo lee: no ejecuta nada del repo)')
    .option('--confiar', 'si git no confía en la carpeta (otro dueño, típico de C:\\ en WSL), la marca como confiable (safe.directory)')
    .action(async (input: string, opts: { confiar?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const dir = fromUserPath(input);
      await withRegistry(async (registry) => {
        const attempt = () => importProject(registry, dir);
        const { checkout, inspection, createdConfig } = await attempt()
          .catch(async (error: Error) => {
            if (!(error instanceof UntrustedRepoError) || !opts.confiar) throw error;
            await trustRepo(error.root);
            print(`✔ ${error.root} marcada como confiable para git`);
            return attempt();
          })
          .catch((error: Error) => {
            throw new CliError(error instanceof UntrustedRepoError ? `${error.message}\n  O vuelve a correrlo con: forja importar "${input}" --confiar` : error.message, EXIT.input);
          });
        const detected = detectProfile(checkout.path);
        if (g.json) return printJson({ proyecto: checkout, inspeccion: inspection, forja_yaml_creado: createdConfig, perfil_detectado: detected });
        print(`✔ Proyecto «${checkout.name}» registrado (${checkout.path})`);
        print(`  Rama: ${inspection.branch ?? '(sin rama)'} · ${inspection.trackedFiles} archivos · ${inspection.languages.join(', ') || 'lenguaje no detectado'}`);
        if (createdConfig) print('  Se creó forja.yaml (revísalo y haz commit cuando quieras).');
        for (const w of inspection.warnings) print(`  ! ${w}`);
        for (const b of inspection.blockers) print(`  ✘ ${b}`);
        print('  Perfil detectado (propuesta; no se ejecutó nada del repositorio):');
        showDetected(detected);
        if (inspection.blockers.length === 0) {
          print(detected ? `  Siguiente paso: cd ${checkout.path} && forja perfil aprobar && forja perfil linea-base` : `  Siguiente paso: cd ${checkout.path} && forja planear`);
        }
      });
    });

  program
    .command('proyectos')
    .description('lista los proyectos registrados en esta máquina')
    .option('--todos', 'incluye los archivados')
    .action(async (opts: { todos?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      await withRegistry((registry) => {
        const rows = registry.list(opts.todos ?? false);
        const active = registry.active()?.checkout_id;
        if (g.json) return printJson({ proyectos: rows.map((r) => ({ ...r, activo: r.checkout_id === active, existe: existsSync(r.path) })) });
        if (rows.length === 0) return print('No hay proyectos. Crea uno con: forja nuevo <nombre>');
        for (const r of rows) {
          const mark = r.checkout_id === active ? '●' : ' ';
          const missing = existsSync(r.path) ? '' : '  (la carpeta ya no existe: forja proyecto vincular)';
          print(`${mark} ${r.name.padEnd(24)} ${r.path}${r.archived ? '  [archivado]' : ''}${missing}`);
        }
      });
    });

  program
    .command('usar <proyecto>')
    .description('elige el proyecto activo (nombre o id)')
    .action(async (project: string) => {
      await withRegistry((registry) => {
        try {
          const row = resolveCheckout(registry, { project });
          registry.setActive(row.checkout_id);
          print(`✔ Proyecto activo: ${row.name} (${row.path})`);
        } catch (error) {
          throw new CliError((error as Error).message, EXIT.input);
        }
      });
    });

  const proyecto = program.command('proyecto').description('administra un proyecto');

  proyecto
    .command('archivar <proyecto>')
    .description('lo oculta de la lista; no borra nada')
    .action(async (project: string) => {
      await withRegistry((registry) => {
        const row = resolveCheckout(registry, { project });
        registry.setArchived(row.checkout_id, true);
        print(`✔ «${row.name}» archivado. Sus datos siguen intactos; para volver: forja proyecto desarchivar ${row.checkout_id}`);
      });
    });

  proyecto
    .command('desarchivar <proyecto>')
    .description('vuelve a mostrar un proyecto archivado')
    .action(async (project: string) => {
      await withRegistry((registry) => {
        const row = registry.byId(project) ?? registry.list(true).find((r) => r.name === project);
        if (!row) throw new CliError(`no existe el proyecto «${project}»`);
        registry.setArchived(row.checkout_id, false);
        print(`✔ «${row.name}» visible otra vez`);
      });
    });

  proyecto
    .command('vincular <proyecto> <nueva-ruta>')
    .description('actualiza la ruta si moviste la carpeta del proyecto')
    .action(async (project: string, dir: string) => {
      await withRegistry((registry) => {
        const row = resolveCheckout(registry, { project });
        if (existsSync(row.path)) {
          throw new CliError(`${row.path} todavía existe: si es otro clon, regístralo con forja importar`, EXIT.precondition);
        }
        const target = realpathSync(resolve(dir));
        registry.relink(row.checkout_id, target);
        print(`✔ «${row.name}» ahora apunta a ${target}`);
      });
    });
}
