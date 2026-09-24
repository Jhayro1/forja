import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Simulation } from '../core/engine.js';

/**
 * Scripted agents from a JSON file, for demos and end-to-end tests of the CLI
 * without spending quota (`FORJA_SIMULACION=guion.json`). It only affects models
 * configured as `simulado:*` in forja.yaml: real providers never read it.
 *
 * {
 *   "tareas":  { "T-001": [ <guion intento 1>, <guion intento 2>, … ] },
 *   "roles":   { "revisor": <guion>, "planeador": <guion> },
 *   "defecto": <guion>
 * }
 * A task with fewer scripts than attempts repeats its last one. A script with
 * "cuando_contiene": "texto" is used (first) whenever the prompt contains that
 * text — e.g. the answer to the agent's own question.
 */
const Script = z.record(z.string(), z.unknown());
export const SimulationFile = z
  .object({
    tareas: z.record(z.string(), z.array(Script).min(1)).default({}),
    roles: z.record(z.string(), Script).default({}),
    defecto: Script.optional(),
  })
  .strict();
export type SimulationFile = z.infer<typeof SimulationFile>;

const APPROVE = { pasos: [], estructurado: { criterios: [], hallazgos: [], veredicto: 'aprobado', resumen: 'simulado' } };

export function simulationFrom(file: SimulationFile): Simulation {
  return ({ role, taskId, attempt, prompt }) => {
    const scripts = role === 'revisor' ? undefined : file.tareas[taskId];
    if (scripts) {
      const conditional = scripts.find((s) => typeof s.cuando_contiene === 'string' && prompt.includes(s.cuando_contiene));
      if (conditional) {
        const { cuando_contiene: _, ...script } = conditional;
        return script;
      }
      const plain = scripts.filter((s) => s.cuando_contiene === undefined);
      if (plain.length) return plain[Math.min(attempt, plain.length) - 1]!;
    }
    return file.roles[role] ?? (role === 'revisor' ? APPROVE : (file.defecto ?? { pasos: [], resultado: 'OK' }));
  };
}

export function loadSimulationFile(path: string): Simulation {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`FORJA_SIMULACION: no se pudo leer ${path}: ${(error as Error).message}`);
  }
  const parsed = SimulationFile.safeParse(raw);
  if (!parsed.success) throw new Error(`FORJA_SIMULACION: ${path} no es un guion válido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return simulationFrom(parsed.data);
}
