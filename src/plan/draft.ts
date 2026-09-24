import type { ForjaConfig } from '../registry/config.js';
import type { Spec } from '../spec/spec.js';
import type { PlanTask } from './plan.js';

const pad = (n: number) => `T-${String(n).padStart(3, '0')}`;

/**
 * Draft by rules, with no model involved (v2/04 · Descomposición): contracts first,
 * then acceptance tests per use case, then implementation per use case. The planner
 * only adjusts this draft (merge, split, refine paths), in one call.
 */
export function draftTasks(spec: Spec, config: ForjaConfig, hasCode: boolean): PlanTask[] {
  const tasks: PlanTask[] = [];
  let n = 0;
  const needsSetup = !hasCode && Object.keys(config.perfil.comandos).length === 0;
  let setupId: string | null = null;
  if (needsSetup) {
    setupId = pad(++n);
    tasks.push({
      id: setupId,
      titulo: 'Preparar el proyecto',
      objetivo: 'Estructura inicial, dependencias, configuración de build y del runner de pruebas según el perfil propuesto, con un test trivial que pase.',
      tipo: 'infraestructura',
      criterios: [],
      requisitos: [],
      depende_de: [],
      escribe: ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'src/index.ts', 'test/smoke.test.ts', '.gitignore'],
      lee: [],
      recursos_exclusivos: ['lockfile'],
      complejidad: 'baja',
      red: true,
      notas: 'Única tarea con red para instalar dependencias.',
    });
  }
  const contractsId = pad(++n);
  tasks.push({
    id: contractsId,
    titulo: 'Contratos: tipos, esquemas e interfaces',
    objetivo: `Definir los tipos de ${spec.entidades.map((e) => e.nombre).join(', ') || 'dominio'} y las firmas de ${spec.contratos.map((c) => c.id).join(', ') || 'los servicios'} sin implementar la lógica.`,
    tipo: 'contrato',
    criterios: [],
    requisitos: [],
    depende_de: setupId ? [setupId] : [],
    escribe: ['src/contratos/**'],
    lee: [],
    recursos_exclusivos: [],
    complejidad: 'media',
    red: false,
    notas: `Entidades: ${spec.entidades.map((e) => e.id).join(', ')}. Contratos: ${spec.contratos.map((c) => c.id).join(', ')}.`,
  });
  for (const uc of spec.casos_uso) {
    const criteria = spec.criterios.filter((c) => c.caso_uso_id === uc.id && c.tipo_evidencia === 'automatica').map((c) => c.id);
    const slug = uc.id.toLowerCase();
    const testId = pad(++n);
    tasks.push({
      id: testId,
      titulo: `Pruebas de aceptación ${uc.id}`,
      objetivo: `Convertir los escenarios de ${uc.id} (${uc.nombre}) en pruebas automáticas que fallen mientras la funcionalidad no exista.`,
      tipo: 'pruebas',
      criterios: criteria,
      requisitos: uc.requisitos,
      depende_de: [contractsId],
      escribe: [`test/aceptacion/${slug}.test.ts`],
      lee: ['src/contratos/**'],
      recursos_exclusivos: [],
      complejidad: 'baja',
      red: false,
      notas: `Fuente: .forja/cambios/<cambio>/aceptacion/${uc.id}.feature`,
    });
    tasks.push({
      id: pad(++n),
      titulo: `Implementar ${uc.id} · ${uc.nombre}`,
      objetivo: `${uc.objetivo}. Pasar las pruebas de ${testId}.`,
      tipo: 'implementacion',
      criterios: criteria,
      requisitos: uc.requisitos,
      depende_de: [testId],
      escribe: [`src/${slug}/**`],
      lee: ['src/contratos/**', `test/aceptacion/${slug}.test.ts`],
      recursos_exclusivos: [],
      complejidad: uc.pasos.length > 8 || uc.excepciones.length > 4 ? 'alta' : 'media',
      red: false,
      notas: `Reglas: ${uc.reglas.join(', ') || '—'}.`,
    });
  }
  return tasks;
}
