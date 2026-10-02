import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { buildRequirementsWorkbook } from '../../export/requirements.js';
import { fromUserPath } from '../../registry/paths.js';
import { CliError, EXIT, type GlobalOptions, print, printJson } from '../context.js';
import { openEngine } from '../engine-context.js';

export function registerExportCommands(program: Command): void {
  const exportar = program.command('exportar').description('descarga la información del proyecto en otros formatos');
  exportar
    .command('excel')
    .description('libro de requerimientos (mapa de procesos, DER, épicas y HU finales, tareas) en .xlsx')
    .option('--salida <ruta>', 'archivo o carpeta donde guardarlo (por defecto, la carpeta actual)')
    .option('--iniciativa <código>', 'código de la iniciativa para los códigos de épicas e HU', 'INI001')
    .option('--contingencia <porcentaje>', 'contingencia para la estimación, en %', '15')
    .action(async (o: { salida?: string; iniciativa: string; contingencia: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      if (!/^[A-Za-z0-9_-]{1,20}$/.test(o.iniciativa)) throw new CliError('la iniciativa es un código corto, p. ej. INI001', EXIT.input);
      const pct = Number(o.contingencia);
      if (!(pct >= 0 && pct <= 100)) throw new CliError('la contingencia va de 0 a 100', EXIT.input);
      const ctx = openEngine(g);
      try {
        const book = buildRequirementsWorkbook(ctx.engine, { iniciativa: o.iniciativa, contingencia: pct / 100 });
        const target = o.salida ? fromUserPath(o.salida) : process.cwd();
        const file = target.toLowerCase().endsWith('.xlsx') ? resolve(target) : join(resolve(target), book.file);
        writeFileSync(file, book.data);
        if (g.json) return printJson({ archivo: file, sprints: book.sprints, historias: book.stories });
        print(`✔ ${file}`);
        print(`  ${book.sprints} sprint(s) · ${book.stories} historia(s) de usuario`);
      } finally {
        ctx.close();
      }
    });
}
