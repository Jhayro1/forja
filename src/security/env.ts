/**
 * Agents get an environment built from an allowlist, never the daemon's (M0
 * finding 9: a TOKEN variable of the parent reached a Codex agent).
 */
const BASE_ALLOWED = ['PATH', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'COLORTERM', 'NO_COLOR'] as const;
const PREFIX_ALLOWED = ['LC_'] as const;

/** Names that must never reach an agent even if a policy asks for them. */
const DENY = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|SESSION|COOKIE|AUTH|SSH_AUTH_SOCK|DOCKER_HOST|FORJA_)/i;

export type EnvOptions = {
  /** Paths inside the sandbox. */
  home: string;
  tmpdir: string;
  /** Extra non-secret variables required by the provider or task (validated). */
  extra?: Record<string, string>;
};

export function buildAgentEnv(source: NodeJS.ProcessEnv, options: EnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const allowed = (BASE_ALLOWED as readonly string[]).includes(key) || PREFIX_ALLOWED.some((p) => key.startsWith(p));
    if (allowed && !DENY.test(key)) env[key] = value;
  }
  env.HOME = options.home;
  env.TMPDIR = options.tmpdir;
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`nombre de variable inválido: ${key}`);
    if (DENY.test(key)) throw new Error(`la variable ${key} parece una credencial y no se entrega a agentes`);
    env[key] = value;
  }
  return env;
}
