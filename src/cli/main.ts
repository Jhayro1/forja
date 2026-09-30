import { Command, CommanderError } from 'commander';
import { type Level, overall, runChecks } from '../doctor/checks.js';
import { ConfigError } from '../registry/config.js';
import { ProjectError } from '../registry/projects.js';
import { FORJA_VERSION } from '../version.js';
import { registerActionCommands } from './commands/actions.js';
import { registerConformanceCommands } from './commands/conformance.js';
import { registerDatabaseCommands } from './commands/databases.js';
import { registerMcpCommands } from './commands/mcp.js';
import { registerMemoryCommands } from './commands/memory.js';
import { registerModelCommands } from './commands/models.js';
import { registerNotificationCommands } from './commands/notify.js';
import { registerOpsCommands } from './commands/ops.js';
import { registerPilotCommands } from './commands/pilot.js';
import { registerPlanCommands } from './commands/plan.js';
import { registerProfileCommands } from './commands/profile.js';
import { registerProjectCommands } from './commands/projects.js';
import { registerQualityCommands } from './commands/quality.js';
import { registerRunCommands } from './commands/run.js';
import { registerTaskControlCommands } from './commands/task-control.js';
import { registerUiCommands } from './commands/ui.js';
import { registerVaultCommands } from './commands/vault.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from './context.js';

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
registerProfileCommands(program);
registerNotificationCommands(program);
registerPlanCommands(program);
registerRunCommands(program);
registerTaskControlCommands(program);
registerUiCommands(program);
registerConformanceCommands(program);
registerPilotCommands(program);
registerVaultCommands(program);
registerActionCommands(program);
registerDatabaseCommands(program);
registerMcpCommands(program);
registerMemoryCommands(program);
registerModelCommands(program);
registerQualityCommands(program);

// `forja` alone opens the panel in the browser (the simple way in); in a pipe or a
// script it keeps showing the help, as before.
const argv = process.argv.length <= 2 && process.stdin.isTTY && process.stdout.isTTY ? [...process.argv, 'ui'] : process.argv;

try {
  await program.parseAsync(argv);
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
