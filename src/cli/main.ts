#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { overall, runChecks, type Level } from '../doctor/checks.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

// Exit codes from v2/10: 0 ok, 2 invalid input, 3 missing approval, 4 provider/environment.
const EXIT_ENV = 4;

const ICON: Record<Level, string> = { ok: '✔', aviso: '!', error: '✘' };

const program = new Command()
  .name('forja')
  .description('Planea con modelos caros, programa en paralelo con modelos baratos (Claude + Codex).')
  .version(pkg.version, '-v, --version', 'muestra la versión')
  .helpOption('-h, --help', 'muestra la ayuda')
  .addHelpCommand('ayuda [comando]', 'muestra la ayuda de un comando');

program
  .command('doctor')
  .description('revisa que todo lo necesario esté instalado y con sesión iniciada')
  .option('--json', 'salida para scripts')
  .action(async (opts: { json?: boolean }) => {
    const checks = await runChecks();
    const result = overall(checks);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ version: 1, estado: result, checks }, null, 2)}\n`);
    } else {
      for (const c of checks) {
        process.stdout.write(`${ICON[c.level]} ${c.title.padEnd(22)} ${c.detail}\n`);
        if (c.fix && c.level !== 'ok') process.stdout.write(`  → ${c.fix}\n`);
      }
      const summary = { ok: 'Todo listo.', aviso: 'Se puede trabajar, con avisos.', error: 'Falta algo para poder trabajar.' }[result];
      process.stdout.write(`\n${summary}\n`);
    }
    if (result === 'error') process.exitCode = EXIT_ENV;
  });

await program.parseAsync();
