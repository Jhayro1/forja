import type { Estimate } from '../plan/estimate.js';
import { type Plan, waves } from '../plan/plan.js';
import { print } from './context.js';

/** Plan by waves plus its (uncalibrated) estimate, as shown by dividir, plan and run --estimar. */
export function showPlan(plan: Plan, e: Estimate): void {
  print(
    `  Stack: ${plan.perfil.stack.join(', ')} (${plan.perfil.gestor}) · test: ${plan.perfil.comandos.test ? [plan.perfil.comandos.test.executable, ...plan.perfil.comandos.test.args].join(' ') : '—'}`,
  );
  const byId = new Map(plan.tareas.map((t) => [t.id, t]));
  waves(plan.tareas).forEach((w, i) => {
    print(`  Ola ${i + 1}:`);
    for (const id of w) {
      const t = byId.get(id)!;
      print(`    ${t.id} [${t.tipo}, ${t.complejidad}] ${t.titulo}${t.depende_de.length ? `  ← ${t.depende_de.join(', ')}` : ''}`);
    }
  });
  print('  Estimación (sin calibrar):');
  for (const [role, r] of Object.entries(e.por_rol))
    print(`    ${role.padEnd(11)} ${r.modelo.padEnd(20)} ~${r.llamadas} llamadas · ${Math.round(r.entrada / 1000)}k entrada · ${Math.round(r.salida / 1000)}k salida`);
  print(`    Tiempo: ~${e.minutos_en_paralelo} min con ${e.paralelo} en paralelo (≈${e.minutos_en_serie} min en serie)`);
  print(`    Costo: ${e.costo_equivalente_usd === null ? 'desconocido' : `~US$ ${e.costo_equivalente_usd}`} — ${e.costo_nota}`);
}
