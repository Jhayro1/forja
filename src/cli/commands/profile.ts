import type { Command } from 'commander';
import { latestBaseline, profileHash, recordProfileApproval, runBaseline } from '../../profile/baseline.js';
import { type DetectedProfile, detectProfile, profileCommands, toConfigProfile } from '../../profile/detect.js';
import { type ForjaConfig, writeConfig } from '../../registry/config.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { openEngine } from '../engine-context.js';

const recipe = (r: { executable: string; args: string[] } | undefined) => (r ? [r.executable, ...r.args].join(' ') : '—');

export function showProfile(p: { stack: string[]; gestor?: string | null | undefined; comandos: Partial<Record<string, { executable: string; args: string[] }>>; red_instalar: string[] }): void {
  print(`  Stack: ${p.stack.join(', ') || '—'} · gestor: ${p.gestor || '—'}`);
  for (const k of ['instalar', 'typecheck', 'build', 'lint', 'test']) print(`  ${k.padEnd(10)} ${recipe(p.comandos[k])}`);
  print(`  Red para instalar: ${p.red_instalar.join(', ') || 'ninguna'}`);
}

export function showDetected(d: DetectedProfile | null): void {
  if (!d) {
    print('  No se reconoció el ecosistema (Node, Python, Go, Rust): el planeador propondrá el perfil al dividir.');
    return;
  }
  showProfile(d);
  for (const e of d.evidencia) print(`  · ${e}`);
}

/** Project profile (V2-030): static detection, explicit approval and a sandboxed baseline. */
export function registerProfileCommands(program: Command): void {
  const perfil = program.command('perfil').description('comandos del proyecto (instalar, build, test…): detección, aprobación y línea base');

  perfil
    .command('ver', { isDefault: true })
    .description('muestra el perfil aprobado, lo detectado en el repositorio y la última línea base')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const approved = Object.keys(ctx.config.perfil.comandos).length ? ctx.config.perfil : null;
        const detected = detectProfile(ctx.checkout.path);
        const baseline = approved ? latestBaseline(ctx.engine, profileHash(approved)) : null;
        if (g.json) return printJson({ aprobado: approved, detectado: detected, linea_base: baseline });
        print(approved ? 'Perfil aprobado (forja.yaml):' : 'Todavía no hay un perfil aprobado.');
        if (approved) showProfile(approved);
        if (!approved || profileHash(toConfigProfile(detected ?? { stack: [], gestor: null, comandos: {}, red_instalar: [], evidencia: [] })) !== profileHash(approved)) {
          print('\nDetectado en el repositorio (sólo leyendo archivos):');
          showDetected(detected);
          if (detected) print('\nApruébalo con: forja perfil aprobar');
        }
        if (approved) {
          print(baseline ? `\nLínea base (${baseline.sha.slice(0, 12)}, ${baseline.recorded_at.slice(0, 16).replace('T', ' ')}):` : '\nSin línea base: córrela con forja perfil linea-base');
          for (const s of baseline?.pasos ?? []) print(`  ${s.ok ? '✔' : '✘'} ${s.paso}${s.ok ? '' : ' (ya fallaba antes de cualquier cambio: no se le atribuirá a las tareas)'}`);
        }
      } finally {
        ctx.close();
      }
    });

  perfil
    .command('aprobar')
    .description('guarda en forja.yaml el perfil detectado (revísalo antes); el planeador ya no lo puede cambiar')
    .action((_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const detected = detectProfile(ctx.checkout.path);
        if (!detected) throw new CliError('no se reconoció el ecosistema: escribe el perfil a mano en forja.yaml (perfil.comandos)', EXIT.precondition);
        const next: ForjaConfig = { ...ctx.config, perfil: toConfigProfile(detected) };
        writeConfig(ctx.checkout.path, next);
        const hash = recordProfileApproval(ctx.engine, next.perfil, 'cli');
        if (g.json) return printJson({ perfil: next.perfil, hash });
        print('✔ Perfil aprobado y guardado en forja.yaml:');
        showProfile(next.perfil);
        print('Siguiente paso: forja perfil linea-base (corre esos comandos en el sandbox sobre el repositorio sin tocar)');
      } finally {
        ctx.close();
      }
    });

  perfil
    .command('linea-base')
    .description('corre el perfil aprobado en el sandbox sobre el último commit, antes de que un agente toque nada')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const p = ctx.config.perfil;
        if (Object.keys(p.comandos).length === 0) throw new CliError('no hay perfil aprobado: forja perfil aprobar', EXIT.precondition);
        if (!g.json) print('Corriendo la línea base en el sandbox (puede tardar lo que tarde instalar y probar el proyecto)…');
        const b = await runBaseline(ctx.engine, {
          repoPath: ctx.checkout.path,
          comandos: profileCommands(p),
          red_instalar: p.red_instalar,
          cmd: { dataDir: ctx.dataDir, sandbox: true, timeoutMs: ctx.config.ejecucion.timeout_min * 60_000 },
          ...(g.json ? {} : { onStep: (s) => print(`  ${s.ok ? '✔' : '✘'} ${s.paso}${s.ok ? ` (${s.detalle})` : ''}`) }),
        });
        if (g.json) return printJson({ linea_base: b });
        const failing = b.pasos.filter((s) => !s.ok);
        if (failing.length === 0) print('✔ Todo pasa en la línea base.');
        else {
          print(`! ${failing.length} paso(s) ya fallan sin cambios: ${failing.map((s) => s.paso).join(', ')}.`);
          print('  La verificación no se los cobrará a las tareas, y el planeador lo sabrá al dividir.');
          for (const s of failing)
            print(
              `\n  ── ${s.paso} ──\n${s.detalle
                .split('\n')
                .map((l) => `  ${l}`)
                .join('\n')}`,
            );
        }
        process.exitCode = failing.some((s) => s.paso === 'instalar') ? EXIT.environment : EXIT.ok;
      } finally {
        ctx.close();
      }
    });
}
