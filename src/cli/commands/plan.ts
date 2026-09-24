import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { NoProviderError } from '../../core/engine.js';
import { closureBlockers, openQuestions, type DiscoveryState } from '../../planner/discovery.js';
import {
  PlannerError,
  activeChange,
  approveDiscovery,
  createChange,
  getDiscovery,
  listChanges,
  plannerScratch,
  runPlannerTurn,
  transcript,
  type TurnResult,
} from '../../planner/session.js';
import { CliError, EXIT, print, printJson, type GlobalOptions } from '../context.js';
import { hasProductCode, openEngine, repoEvidence, type EngineContext } from '../engine-context.js';

function spinner(label: string): () => void {
  if (!process.stderr.isTTY) return () => {};
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    process.stderr.write(`\r${frames[i++ % frames.length]} ${label} ${Math.round((Date.now() - started) / 1000)}s `);
  }, 120);
  return () => {
    clearInterval(timer);
    process.stderr.write('\r\x1b[K');
  };
}

function showTurn(r: TurnResult): void {
  print();
  print(r.message.trim());
  print();
  const qs = r.questions;
  if (qs.length > 0) {
    print('Preguntas abiertas:');
    for (const q of qs) print(`  ${q.id}${q.bloquea ? ' (bloquea)' : ''}: ${q.texto}${q.recomendacion ? `  → recomiendo: ${q.recomendacion}` : ''}`);
    print();
  }
  for (const n of r.notes) print(`  ⚠ ${n}`);
  print(`  [${r.provider}:${r.model} · revisión ${r.revision}${r.blockers.length === 0 ? ' · se puede aprobar con /aprobar' : ''}]`);
}

function showState(state: DiscoveryState): void {
  print(`Resumen: ${state.resumen || '(todavía no hay)'}`);
  if (state.alcance.incluye.length) print(`Incluye: ${state.alcance.incluye.join('; ')}`);
  if (state.alcance.excluye.length) print(`Fuera:   ${state.alcance.excluye.join('; ')}`);
  const decisions = Object.values(state.decisiones);
  if (decisions.length) {
    print('Decisiones:');
    for (const d of decisions) print(`  ${d.estado === 'aceptada' ? '✔' : '?'} ${d.id}: ${d.contenido}`);
  }
  const pending = Object.values(state.propuestas).filter((p) => p.estado === 'pendiente');
  if (pending.length) {
    print('Sugerencias por decidir:');
    for (const p of pending) print(`  ${p.id} (${p.prioridad}): ${p.recomendacion}`);
  }
  const blockers = closureBlockers(state);
  print(blockers.length ? `Falta para aprobar:\n${blockers.map((b) => `  - ${b}`).join('\n')}` : 'Se puede aprobar el descubrimiento con /aprobar.');
}

async function planningInputs(ctx: EngineContext, mode: 'idea' | 'mejora') {
  return mode === 'mejora'
    ? { workspace: ctx.checkout.path, evidence: await repoEvidence(ctx.checkout.path) }
    : { workspace: plannerScratch(ctx.engine) };
}

async function turn(ctx: EngineContext, changeId: string, mode: 'idea' | 'mejora', userText: string | null, closing = false): Promise<TurnResult> {
  const stop = spinner(`pensando con ${ctx.config.roles.planeador[0]}…`);
  try {
    return await runPlannerTurn(ctx.engine, { changeId, userText, ...(await planningInputs(ctx, mode)), closing });
  } catch (error) {
    if (error instanceof NoProviderError || error instanceof PlannerError) throw new CliError(error.message, EXIT.environment);
    throw error;
  } finally {
    stop();
  }
}

export function registerPlanCommands(program: Command): void {
  program
    .command('planear [idea...]')
    .description('conversa con el planeador para definir una idea o una mejora')
    .option('--nuevo', 'empieza un cambio nuevo aunque haya uno en curso')
    .option('--mejora', 'es una mejora de este repositorio (por defecto se detecta)')
    .option('--idea', 'es una idea nueva')
    .option('-m, --mensaje <texto>', 'envía un mensaje y termina (sin conversación interactiva)')
    .action(async (ideaWords: string[], opts: { nuevo?: boolean; mejora?: boolean; idea?: boolean; mensaje?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
      try {
        let change = opts.nuevo ? undefined : activeChange(ctx.engine);
        if (change && change.phase !== 'descubrir') {
          throw new CliError(`el cambio «${change.title}» ya pasó el descubrimiento (fase ${change.phase}); usa --nuevo para empezar otro`, EXIT.precondition);
        }
        if (!change) {
          let idea = ideaWords.join(' ').trim();
          if (!idea) {
            if (!process.stdin.isTTY) throw new CliError('escribe la idea: forja planear "lo que quiero construir"');
            idea = (await rl.question('¿Qué quieres construir o mejorar? ')).trim();
          }
          if (!idea) throw new CliError('no se recibió ninguna idea');
          const mode = opts.mejora ? 'mejora' : opts.idea ? 'idea' : (await hasProductCode(ctx.checkout.path)) ? 'mejora' : 'idea';
          const changeId = createChange(ctx.engine, `cambio:${Date.now()}`, idea.slice(0, 120), mode);
          change = listChanges(ctx.engine).find((c) => c.change_id === changeId)!;
          print(`Nuevo cambio (${mode === 'mejora' ? 'mejora de este repositorio' : 'idea nueva'}): ${change.title}`);
          showTurn(await turn(ctx, change.change_id, change.mode, null));
        } else if (!opts.mensaje) {
          const history = transcript(ctx.engine, change.change_id);
          print(`Retomando «${change.title}» (${history.length} turnos).`);
          const last = history.at(-1);
          if (last) {
            print();
            print(last.planner_text.trim());
            const qs = openQuestions(getDiscovery(ctx.engine, change.change_id).state);
            if (qs.length) {
              print();
              print('Preguntas abiertas:');
              for (const q of qs) print(`  ${q.id}${q.bloquea ? ' (bloquea)' : ''}: ${q.texto}`);
            }
          } else {
            showTurn(await turn(ctx, change.change_id, change.mode, null));
          }
        }

        if (opts.mensaje) {
          const r = await turn(ctx, change.change_id, change.mode, opts.mensaje);
          if (g.json) printJson({ turno: r });
          else showTurn(r);
          return;
        }
        if (!process.stdin.isTTY) return;

        print();
        print('Escribe tu respuesta. Comandos: /estado  /cerrar  /aprobar  /salir');
        for (;;) {
          const text = (await rl.question('\ntú › ')).trim();
          if (!text) continue;
          if (text === '/salir' || text === '/q') break;
          if (text === '/estado') {
            showState(getDiscovery(ctx.engine, change.change_id).state);
            continue;
          }
          if (text === '/cerrar') {
            showTurn(await turn(ctx, change.change_id, change.mode, 'Quiero cerrar el descubrimiento: revisa huecos y prepara el resumen para aprobar.', true));
            continue;
          }
          if (text === '/aprobar') {
            try {
              approveDiscovery(ctx.engine, change.change_id, `aprobar:${change.change_id}:${getDiscovery(ctx.engine, change.change_id).revision}`);
              print('✔ Descubrimiento aprobado. Siguiente paso: forja especificar');
              break;
            } catch (error) {
              print(`✘ ${(error as Error).message}`);
            }
            continue;
          }
          showTurn(await turn(ctx, change.change_id, change.mode, text));
        }
      } finally {
        rl.close();
        ctx.close();
      }
    });

  program
    .command('cambios')
    .description('lista los cambios (incrementos) del proyecto y su fase')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const rows = listChanges(ctx.engine);
        if (g.json) return printJson({ cambios: rows });
        if (rows.length === 0) return print('Todavía no hay cambios. Empieza con: forja planear');
        for (const r of rows) print(`${r.change_id}  ${r.phase.padEnd(11)} ${r.title}`);
      } finally {
        ctx.close();
      }
    });

  const aprobar = program.command('aprobar').description('aprobaciones explícitas (nunca se infieren del silencio)');
  aprobar
    .command('descubrimiento')
    .description('aprueba el resumen del descubrimiento del cambio en curso')
    .action(async (_o: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const ctx = openEngine(g);
      try {
        const change = activeChange(ctx.engine);
        if (!change) throw new CliError('no hay un cambio en curso', EXIT.precondition);
        const { revision } = getDiscovery(ctx.engine, change.change_id);
        try {
          approveDiscovery(ctx.engine, change.change_id, `aprobar:${change.change_id}:${revision}`);
        } catch (error) {
          throw new CliError((error as Error).message, EXIT.precondition);
        }
        print(`✔ Descubrimiento de «${change.title}» aprobado (revisión ${revision}). Siguiente paso: forja especificar`);
      } finally {
        ctx.close();
      }
    });
}
