import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Engine } from '../core/engine.js';
import { newId } from '../domain/ids.js';
import type { ChangeRow } from '../planner/session.js';
import { runsOf } from '../run/records.js';
import { type Fetcher, GitHubSettings, PublishError, type PublishResult, publishBranch } from './publish.js';
import { deliveryBranch } from './workspace.js';

/** The delivery of a sprint published to GitHub (branch + PR), as an event of the project. */
export const DELIVERY_PUBLISHED = 'entrega.publicada';

export type DeliveryState = {
  rama: string | null;
  lista: boolean;
  github: { configurado: boolean; usuario: string | null; publicar_al_entregar: boolean };
  publicada: (PublishResult & { fecha: string }) | null;
};

export function deliveryState(engine: Engine, change: ChangeRow, home: string): DeliveryState {
  const run = runsOf(engine, change.change_id)[0];
  const ready = run?.state === 'completado';
  const row = engine.store.db.prepare('SELECT payload, occurred_at FROM events WHERE type = ? AND aggregate_id = ? ORDER BY seq DESC LIMIT 1').get(DELIVERY_PUBLISHED, change.change_id) as
    | { payload: string; occurred_at: string }
    | undefined;
  const gh = new GitHubSettings(home).view();
  return {
    rama: ready ? deliveryBranch(engine.config.git.prefijo, change.change_id) : null,
    lista: ready,
    github: { configurado: gh.configurado, usuario: gh.usuario, publicar_al_entregar: gh.publicar_al_entregar },
    publicada: row ? { ...(JSON.parse(row.payload) as PublishResult), fecha: row.occurred_at } : null,
  };
}

/** Pushes the delivered sprint's branch and opens (or finds) its PR. Never touches the main branch. */
export async function publishDelivery(engine: Engine, change: ChangeRow, input: { home: string; repoPath: string; fetcher?: Fetcher; pushUrl?: string }): Promise<PublishResult> {
  const run = runsOf(engine, change.change_id)[0];
  if (run?.state !== 'completado') throw new PublishError('el sprint todavía no tiene una entrega completa');
  const settings = new GitHubSettings(input.home);
  const token = settings.token();
  if (!token) throw new PublishError('falta el token de GitHub: configúralo en Ajustes → GitHub');
  const branch = deliveryBranch(engine.config.git.prefijo, change.change_id);
  const report = join(input.repoPath, '.forja', 'cambios', change.change_id, 'informe.md');
  const body = [
    `Entrega de Forja del sprint **${change.title}**.`,
    '',
    'Forja nunca une este PR ni toca la rama principal: revísalo y únelo tú.',
    '',
    existsSync(report) ? readFileSync(report, 'utf8') : '',
  ].join('\n');
  const result = await publishBranch({
    repoPath: input.repoPath,
    branch,
    base: engine.config.git.rama_principal,
    prefix: engine.config.git.prefijo,
    token,
    openPr: settings.view().abrir_pr,
    title: `Forja: ${change.title}`,
    body,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    ...(input.pushUrl ? { pushUrl: input.pushUrl } : {}),
  });
  engine.store.execute({ request_id: newId('req'), type: 'publicar_entrega', input: { change: change.change_id, commit: result.commit } }, () => ({
    result: null,
    events: [{ type: DELIVERY_PUBLISHED, aggregate_type: 'cambio', aggregate_id: change.change_id, payload: result }],
  }));
  return result;
}
