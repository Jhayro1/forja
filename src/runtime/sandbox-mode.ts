import { isLigera } from './edition.js';

/**
 * Which sandbox backend an adapter should ask for (ADR-012-aislamiento-docker.md,
 * ADR-016-edicion-ligera.md). bwrap only exists on Linux; everywhere else (and on
 * Linux if you override it, e.g. because AppArmor blocks bwrap's user namespaces)
 * Docker is the fallback. The ligera edition runs agents «directo»: no sandbox of
 * Forja's own, only a separate worktree and the CLI's own limits. A static,
 * synchronous choice by design: adapters build a `LaunchOrder` without doing I/O,
 * and `forja doctor` is what actually confirms the chosen backend really works.
 */
export type SandboxMode = 'bwrap' | 'docker' | 'directo';

export function activeSandboxMode(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SandboxMode {
  if (env.FORJA_SANDBOX === 'bwrap' || env.FORJA_SANDBOX === 'docker' || env.FORJA_SANDBOX === 'directo') return env.FORJA_SANDBOX;
  if (isLigera(env)) return 'directo';
  return platform === 'linux' ? 'bwrap' : 'docker';
}
