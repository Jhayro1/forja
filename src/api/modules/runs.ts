import { ApiError, stringField } from '../http.js';
import type { ApiModule } from '../server.js';

/** What the panel can read and do about the current change and its run. */
export interface RunsBackend {
  state(): object;
  task(id: string): { detalle: string[]; registro: string[]; instrucciones: string[] } | null;
  diff(id: string): Promise<string[]>;
  answer(taskId: string, text: string): void;
  retry(taskId: string, note: string | null): void;
  pause(taskId: string): string;
  resume(taskId: string): string;
  reassign(taskId: string, model: string | null): string;
  resumeProvider(key: string): string;
  stop(): string;
  approvePlan(): string;
}

const TASK = /^\/v1\/tareas\/(T-\d{1,5})$/i;

export function runsModule(backend: RunsBackend): ApiModule {
  const task = (id: string) => {
    const t = backend.task(id.toUpperCase());
    if (!t) throw new ApiError(404, 'tarea_no_encontrada', `no existe la tarea ${id} en el run actual`);
    return t;
  };
  return {
    name: 'runs',
    routes: [
      { method: 'GET', path: /^\/v1\/estado$/, handler: () => ({ estado: backend.state() }) },
      { method: 'GET', path: TASK, handler: ({ params }) => ({ tarea: task(params[0]!) }) },
      {
        method: 'GET',
        path: /^\/v1\/tareas\/(T-\d{1,5})\/diff$/i,
        handler: async ({ params }) => {
          task(params[0]!);
          return { diff: await backend.diff(params[0]!.toUpperCase()) };
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/tareas\/(T-\d{1,5})\/respuesta$/i,
        handler: async ({ params, body }) => {
          backend.answer(params[0]!.toUpperCase(), stringField(await body(), 'respuesta')!.trim());
          return { ok: true, mensaje: 'respuesta registrada; la tarea vuelve a la cola' };
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/tareas\/(T-\d{1,5})\/reintentar$/i,
        handler: async ({ params, body }) => {
          backend.retry(params[0]!.toUpperCase(), stringField(await body(), 'nota', { optional: true })?.trim() || null);
          return { ok: true, mensaje: 'la tarea vuelve a la cola' };
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/tareas\/(T-\d{1,5})\/pausar$/i,
        handler: ({ params }) => ({ ok: true, mensaje: backend.pause(params[0]!.toUpperCase()) }),
      },
      {
        method: 'POST',
        path: /^\/v1\/tareas\/(T-\d{1,5})\/reanudar$/i,
        handler: ({ params }) => ({ ok: true, mensaje: backend.resume(params[0]!.toUpperCase()) }),
      },
      {
        method: 'POST',
        path: /^\/v1\/tareas\/(T-\d{1,5})\/reasignar$/i,
        handler: async ({ params, body }) => ({ ok: true, mensaje: backend.reassign(params[0]!.toUpperCase(), stringField(await body(), 'modelo', { optional: true })?.trim() || null) }),
      },
      {
        method: 'POST',
        path: /^\/v1\/proveedores\/([a-z]+(?::[\w.-]+)?)\/reanudar$/i,
        handler: ({ params }) => ({ ok: true, mensaje: backend.resumeProvider(params[0]!) }),
      },
      { method: 'POST', path: /^\/v1\/run\/detener$/, handler: () => ({ ok: true, mensaje: backend.stop() }) },
      { method: 'POST', path: /^\/v1\/plan\/aprobar$/, handler: () => ({ ok: true, mensaje: backend.approvePlan() }) },
    ],
  };
}
