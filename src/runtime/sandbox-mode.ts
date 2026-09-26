/**
 * Which sandbox backend an adapter should ask for (ADR-012-aislamiento-docker.md).
 * bwrap only exists on Linux; everywhere else (and on Linux if you override it, e.g.
 * because AppArmor blocks bwrap's user namespaces) Docker is the fallback. A static,
 * synchronous choice by design: adapters build a `LaunchOrder` without doing I/O, and
 * `forja doctor` is what actually confirms the chosen backend really works.
 */
export type SandboxMode = 'bwrap' | 'docker';

export function activeSandboxMode(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SandboxMode {
  if (env.FORJA_SANDBOX === 'bwrap' || env.FORJA_SANDBOX === 'docker') return env.FORJA_SANDBOX;
  return platform === 'linux' ? 'bwrap' : 'docker';
}
