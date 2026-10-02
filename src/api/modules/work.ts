import { ApiError, SECURITY_HEADERS, stringField } from '../http.js';
import type { ApiModule } from '../server.js';

/**
 * Epics, sprints, the history checklist/calendar and the observations of review, audit
 * and QA with their action plans (v3/PLAN.md §3, §5.1.1, §6.3).
 */
export interface WorkBackend {
  agents(): object;
  delivery(): object;
  publish(): Promise<object>;
  history(): object;
  historyMarkdown(): string;
  /** The requirements workbook (export/requirements.ts): file name and .xlsx bytes. */
  requirementsWorkbook(opts: { iniciativa?: string; contingencia?: number }): { file: string; data: Buffer };
  epics(): object;
  createEpic(input: Record<string, unknown>): object;
  editEpic(id: string, input: Record<string, unknown>): object;
  assignSprint(changeId: string, input: Record<string, unknown>): object;
  observations(states: string[] | null): object;
  moveObservation(id: string, to: string, reason: string | null): object;
  actionPlan(ids: string[], note: string): object;
}

const guard = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, 'trabajo', (error as Error).message);
  }
};

export function workModule(backend: WorkBackend): ApiModule {
  return {
    name: 'trabajo',
    routes: [
      { method: 'GET', path: /^\/v1\/agentes$/, handler: () => ({ agentes: backend.agents() }) },
      { method: 'GET', path: /^\/v1\/entrega$/, handler: () => ({ entrega: backend.delivery() }) },
      {
        method: 'POST',
        path: /^\/v1\/entrega\/publicar$/,
        handler: async () => {
          try {
            const r = (await backend.publish()) as { pr?: { url: string } | null; rama: string };
            return { ok: true, publicacion: r, mensaje: r.pr ? `rama subida y PR listo: ${r.pr.url}` : `rama ${r.rama} subida` };
          } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(422, 'publicar', (error as Error).message);
          }
        },
      },
      { method: 'GET', path: /^\/v1\/historial$/, handler: () => ({ historial: backend.history() }) },
      { method: 'GET', path: /^\/v1\/historial\/markdown$/, handler: () => ({ markdown: backend.historyMarkdown() }) },
      {
        method: 'GET',
        path: /^\/v1\/historial\/excel$/,
        handler: ({ query, res }) => {
          const ini = query.get('iniciativa')?.trim() || undefined;
          if (ini && !/^[A-Za-z0-9_-]{1,20}$/.test(ini)) throw new ApiError(422, 'campo_invalido', 'la iniciativa es un código corto, p. ej. INI001');
          const pct = query.get('contingencia');
          const contingencia = pct === null ? undefined : Number(pct) / 100;
          if (contingencia !== undefined && !(contingencia >= 0 && contingencia <= 1)) throw new ApiError(422, 'campo_invalido', 'la contingencia va de 0 a 100');
          const book = guard(() => backend.requirementsWorkbook({ ...(ini ? { iniciativa: ini } : {}), ...(contingencia !== undefined ? { contingencia } : {}) }));
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${book.file.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(book.file)}`,
            'Content-Length': String(book.data.length),
          });
          res.end(book.data);
          return undefined;
        },
      },
      { method: 'GET', path: /^\/v1\/epicas$/, handler: () => backend.epics() },
      {
        method: 'POST',
        path: /^\/v1\/epicas$/,
        handler: async ({ body }) => {
          const b = await body();
          return { ok: true, epica: guard(() => backend.createEpic(b)), mensaje: 'épica creada' };
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/epicas\/(epi_[0-9A-HJKMNP-TV-Z]{26})$/,
        handler: async ({ params, body }) => {
          const b = await body();
          return { ok: true, epica: guard(() => backend.editEpic(params[0]!, b)), mensaje: 'épica guardada' };
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/sprints\/(cam_[0-9A-HJKMNP-TV-Z]{26})\/epica$/,
        handler: async ({ params, body }) => {
          const b = await body();
          return { ok: true, sprint: guard(() => backend.assignSprint(params[0]!, b)), mensaje: 'sprint actualizado' };
        },
      },
      {
        method: 'GET',
        path: /^\/v1\/observaciones$/,
        handler: ({ query }) => ({ observaciones: backend.observations(query.get('estado')?.split(',').filter(Boolean) ?? null) }),
      },
      {
        method: 'POST',
        path: /^\/v1\/observaciones\/(obs_[0-9a-f]{20})\/estado$/,
        handler: async ({ params, body }) => {
          const b = await body();
          const to = stringField(b, 'estado', { max: 20 })!;
          const reason = stringField(b, 'motivo', { optional: true, max: 1000 });
          return { ok: true, observacion: guard(() => backend.moveObservation(params[0]!, to, reason)), mensaje: 'observación actualizada' };
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/observaciones\/plan$/,
        handler: async ({ body }) => {
          const b = await body();
          const ids = b.ids;
          if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || !ids.every((x) => typeof x === 'string')) throw new ApiError(422, 'campo_invalido', 'elige entre 1 y 50 observaciones');
          const note = stringField(b, 'nota', { optional: true, max: 4000 }) ?? '';
          return { ok: true, ...guard(() => backend.actionPlan(ids as string[], note)) };
        },
      },
    ],
  };
}
