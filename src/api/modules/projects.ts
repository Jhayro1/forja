import { stringField } from '../http.js';
import type { ApiModule } from '../server.js';

/** Choosing what to work on: registered projects, importing a folder, creating one. */
export interface ProjectsBackend {
  list(): object;
  select(checkoutId: string): object;
  /**
   * `path` as the user typed it (Windows paths are accepted on WSL). If git does not
   * trust the folder (another owner), answers `requiere_confianza` unless `trust` is set.
   */
  importFolder(path: string, trust: boolean): Promise<object>;
  create(name: string, parent: string | null): Promise<object>;
  archive(checkoutId: string): object;
  /** Subfolders to pick from, limited to the allowed roots. */
  browse(path: string | null): object;
}

const CHECKOUT = /^\/v1\/proyectos\/(chk_[0-9A-HJKMNP-TV-Z]{26})\/(seleccionar|archivar)$/;

export function projectsModule(backend: ProjectsBackend): ApiModule {
  return {
    name: 'proyectos',
    routes: [
      { method: 'GET', path: /^\/v1\/proyectos$/, handler: () => backend.list() },
      { method: 'GET', path: /^\/v1\/carpetas$/, handler: ({ query }) => backend.browse(query.get('ruta')) },
      {
        method: 'POST',
        path: CHECKOUT,
        handler: ({ params }) =>
          params[1] === 'seleccionar' ? { ok: true, ...backend.select(params[0]!) } : { ok: true, ...backend.archive(params[0]!), mensaje: 'proyecto archivado (no se borró nada)' },
      },
      {
        method: 'POST',
        path: /^\/v1\/proyectos\/importar$/,
        handler: async ({ body }) => {
          const b = await body();
          return { ok: true, ...(await backend.importFolder(stringField(b, 'ruta', { max: 1000 })!, b.confiar === true)) };
        },
      },
      {
        method: 'POST',
        path: /^\/v1\/proyectos\/nuevo$/,
        handler: async ({ body }) => {
          const b = await body();
          return { ok: true, ...(await backend.create(stringField(b, 'nombre', { max: 80 })!, stringField(b, 'carpeta', { optional: true, max: 1000 }))) };
        },
      },
    ],
  };
}
