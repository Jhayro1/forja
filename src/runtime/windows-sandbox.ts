import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { SANDBOX_HELPER_DIR, SANDBOX_PROXY_SOCKET, type SandboxSpec } from './sandbox.js';

/**
 * Windows PROTOTYPE (ADR-011-aislamiento-windows.md): the same isolation contract as
 * `bwrapArgs`, expressed as a plan for an AppContainer + Job Object. Not wired into the
 * launcher: it has not been run on Windows, and the native helper that would actually
 * apply this plan (CreateAppContainerProfile, icacls, Job Objects, WFP) does not exist yet.
 *
 * Differences that change the contract, always returned as `limitations`, never assumed:
 *  - no mount namespace: paths cannot be remapped (helper dir, proxy socket, provider
 *    files keep their real paths; the agent gets them by env);
 *  - no pid namespace: killing the Job Object stands in for it, but a process started
 *    with CREATE_BREAKAWAY_FROM_JOB escapes unless the job forbids it;
 *  - AppContainer denies write outside its grants by default, but NOT read: hiding the
 *    real HOME from reads needs an explicit ACL deny added before launch and removed
 *    after — a helper that dies without cleaning up leaves that deny rule stuck;
 *  - no WFP rules implemented: without them the sandbox has full network access, same as
 *    Seatbelt with no proxy configured.
 */
export type WindowsGrant = { path: string; rw: boolean };

export type WindowsSandboxPlan = {
  /** AppContainer profile name for this launch; must be unique and short-lived. */
  profileId: string;
  /** Paths to grant inside the AppContainer (workspace, fake HOME, provider mounts, helpers). */
  grants: WindowsGrant[];
  /** Paths that need an explicit read-deny ACL rule to be hidden (the real HOME). */
  denyReadPaths: string[];
  /** Real paths the agent must receive by env, since nothing is remapped. */
  env: Record<string, string>;
  limitations: string[];
};

export function windowsSandboxPlan(spec: SandboxSpec, realHome = homedir()): WindowsSandboxPlan {
  const limitations: string[] = [
    'sin espacio de nombres de procesos: se mata el Job Object completo; un proceso con CREATE_BREAKAWAY_FROM_JOB escapa si el job no lo prohíbe',
    'AppContainer deniega escritura fuera de lo permitido por defecto, pero no lectura: ocultar el HOME real en lectura exige una regla ACL de denegación explícita, añadida antes del lanzamiento y quitada después',
    'sin reglas WFP implementadas: sin ellas la red queda abierta, no sólo el socket del proxy',
  ];

  const grants: WindowsGrant[] = [
    ...(spec.workspaceReadOnly ? [] : [{ path: spec.workspace, rw: true }]),
    ...(spec.workspaceReadOnly ? [{ path: spec.workspace, rw: false }] : []),
    { path: spec.home, rw: true },
    { path: spec.helperDir, rw: false },
    ...spec.readOnly.map((path) => ({ path, rw: false })),
    ...spec.mounts.map((m) => ({ path: m.src, rw: m.rw })),
  ];

  for (const m of spec.mounts) {
    if (m.src !== m.dest) limitations.push(`no se puede montar ${m.src} en ${m.dest}: el agente usa la ruta real`);
  }

  const env: Record<string, string> = { FORJA_HELPER_DIR: spec.helperDir };
  if (spec.proxySocket) {
    env.FORJA_PROXY_SOCKET = spec.proxySocket;
    limitations.push(`el socket del proxy queda en ${spec.proxySocket}, no en ${SANDBOX_PROXY_SOCKET}`);
    limitations.push('el bloqueo de red al socket del proxy no está implementado (falta el helper con reglas WFP); por ahora la red queda abierta igual que sin proxy');
  }
  limitations.push(`las ayudas de Forja quedan en ${spec.helperDir}, no en ${SANDBOX_HELPER_DIR}`);

  return { profileId: `forja-${randomUUID()}`, grants, denyReadPaths: [realHome], env, limitations };
}
