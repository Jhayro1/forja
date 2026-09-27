import type { Command } from 'commander';
import { EFFORT_LABELS, MODEL_CATALOG } from '../../providers/catalog.js';
import { type GlobalOptions, print, printJson } from '../context.js';
import { catalogView } from '../settings-backend.js';

/** `forja modelos`: every model the panel offers, with the effort levels each one accepts. */
export function registerModelCommands(program: Command): void {
  program
    .command('modelos')
    .description('lista los modelos de Claude y Codex que puedes poner en cada rol, con su esfuerzo de razonamiento')
    .action((_o: unknown, cmd: Command) => {
      if (cmd.optsWithGlobals<GlobalOptions>().json) return printJson(catalogView());
      for (const provider of ['claude', 'codex'] as const) {
        print(provider === 'claude' ? 'Claude Code' : 'Codex');
        for (const m of MODEL_CATALOG.filter((x) => x.provider === provider)) {
          const efforts = m.efforts.length ? m.efforts.map((e) => EFFORT_LABELS[e].toLowerCase()).join(', ') : 'sin esfuerzo configurable';
          const note = m.status === 'retirandose' ? ` · se retira el ${m.retires}` : m.status === 'anterior' ? ' · anterior' : '';
          print(`  ${m.ref.padEnd(30)} ${m.label}${note}`);
          print(`  ${''.padEnd(30)} esfuerzo: ${efforts}`);
        }
        print();
      }
      print('En forja.yaml: roles.<rol> es la lista de modelos y esfuerzo.<rol> el nivel (low, medium, high, xhigh, max, ultra).');
      print('Cada modelo recibe el nivel más alto que acepta sin pasarse del pedido.');
    });
}
