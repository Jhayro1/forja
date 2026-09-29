import { type GitHubSettings, PublishError } from '../../git/publish.js';
import { ApiError } from '../http.js';
import type { ApiModule } from '../server.js';

/** Settings → GitHub: the token Forja uses to push its branches and open PRs (never merges). */
export function githubModule(settings: GitHubSettings): ApiModule {
  return {
    name: 'github',
    routes: [
      { method: 'GET', path: /^\/v1\/github$/, handler: () => ({ github: settings.view() }) },
      {
        method: 'POST',
        path: /^\/v1\/github$/,
        handler: async ({ body }) => {
          const b = await body();
          const bool = (k: string) => (typeof b[k] === 'boolean' ? (b[k] as boolean) : undefined);
          if (b.token !== undefined && b.token !== null && typeof b.token !== 'string') throw new ApiError(422, 'campo_invalido', '«token» debe ser texto');
          try {
            const view = await settings.save({
              token: (b.token as string | null | undefined) ?? null,
              borrar: b.borrar === true,
              ...(bool('publicar_al_entregar') !== undefined ? { publicar_al_entregar: bool('publicar_al_entregar')! } : {}),
              ...(bool('abrir_pr') !== undefined ? { abrir_pr: bool('abrir_pr')! } : {}),
            });
            return { ok: true, github: view, mensaje: view.configurado ? `GitHub listo${view.usuario ? ` (${view.usuario})` : ''}` : 'guardado' };
          } catch (error) {
            if (error instanceof PublishError) throw new ApiError(422, 'github', error.message);
            throw error;
          }
        },
      },
    ],
  };
}
