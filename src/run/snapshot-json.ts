import type { RunSnapshot } from './snapshot.js';

/**
 * Stable JSON shape of a snapshot, shared by `--json` output and the local API
 * (field names in Spanish are part of the public contract, v2/10).
 */
export function snapshotJson(s: RunSnapshot, runner: { pid: number } | null) {
  return {
    cambio: { id: s.change.change_id, titulo: s.change.title, fase: s.change.phase },
    run: s.run ? { id: s.run.run_id, estado: s.run.state, detalle: s.run.detail, rama: s.run.branch, base: s.run.base_sha, activo: runner !== null } : null,
    entrega: s.deliveryBranch,
    progreso: { integradas: s.integrated, total: s.total, por_estado: s.counts },
    tareas: s.tasks.map((t) => ({
      id: t.id,
      titulo: t.title,
      estado: t.state,
      modelo: t.exec.provider ? `${t.exec.provider}:${t.exec.model}` : null,
      intento: t.exec.attempt,
      fallos_calidad: t.exec.quality_failures,
      actividad: t.activity,
      error: t.exec.last_error,
      pregunta: t.state === 'esperando_respuesta' ? t.exec.question : null,
    })),
    pendientes: s.pending,
    consumo: s.usage,
    siguiente: s.nextStep,
  };
}

