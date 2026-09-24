#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { Command, CommanderError } from 'commander';
import { overall, runChecks, type Level } from '../doctor/checks.js';
import { ConfigError } from '../registry/config.js';
import { ProjectError } from '../registry/projects.js';
import { registerConformanceCommands } from './commands/conformance.js';
import { registerOpsCommands } from './commands/ops.js';
import { registerPilotCommands } from './commands/pilot.js';
import { registerPlanCommands } from './commands/plan.js';
import { registerProjectCommands } from './commands/projects.js';
import { registerRunCommands } from './commands/run.js';
import { registerUiCommands } from './commands/ui.js';
import { FORJA_VERSION } from '../version.js';
import { CliError, EXIT, print, printJson, type GlobalOptions } from './context.js';


// `forja estado | head` closes the pipe early: that is a normal end, not a crash.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const ICON: Record<Level, string> = { ok: '✔', aviso: '!', error: '✘' };

const program = new Command()
  .name('forja')
  .description('Planea con modelos caros, programa en paralelo con modelos baratos (Claude + Codex).')
  .version(FORJA_VERSION, '-v, --version', 'muestra la versión')
  .helpOption('-h, --help', 'muestra la ayuda')
  .helpCommand('ayuda [comando]', 'muestra la ayuda de un comando')
  .option('-p, --proyecto <nombre|id>', 'proyecto sobre el que actuar')
  .option('--json', 'salida para scripts')
  .showSuggestionAfterError(true)
  .exitOverride();

program
  .command('doctor')
  .description('revisa que todo lo necesario esté instalado y con sesión iniciada')
  .action(async (_opts: unknown, cmd: Command) => {
    const g = cmd.optsWithGlobals<GlobalOptions>();
    const checks = await runChecks();
    const result = overall(checks);
    if (g.json) {
      printJson({ estado: result, checks });
    } else {
      for (const c of checks) {
        print(`${ICON[c.level]} ${c.title.padEnd(22)} ${c.detail}`);
        if (c.fix && c.level !== 'ok') print(`  → ${c.fix}`);
      }
      print();
      print({ ok: 'Todo listo.', aviso: 'Se puede trabajar, con avisos.', error: 'Falta algo para poder trabajar.' }[result]);
    }
    if (result === 'error') process.exitCode = EXIT.environment;
  });

registerProjectCommands(program);
registerOpsCommands(program);
registerPlanCommands(program);
registerRunCommands(program);
registerUiCommands(program);
registerConformanceCommands(program);
registerPilotCommands(program);

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : EXIT.input;
  } else if (error instanceof CliError || error instanceof ProjectError || error instanceof ConfigError) {
    process.stderr.write(`✘ ${error.message}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : EXIT.input;
  } else {
    process.stderr.write(`✘ error inesperado: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = EXIT.unknown;
  }
}
