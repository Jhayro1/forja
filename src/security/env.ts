/**
 * Agents get an environment built from an allowlist, never the daemon's (M0
 * finding 9: a TOKEN variable of the parent reached a Codex agent).
 */
const BASE_ALLOWED = ['PATH', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'COLORTERM', 'NO_COLOR'] as const;
/**
 * Native Windows (ligera edition): programs do not even start without these (SystemRoot,
 * ComSpec, PATHEXT), and the CLIs find their sessions through USERPROFILE/APPDATA.
 * Compared case-insensitively, as Windows does (process.env has «Path», not «PATH»).
 */
const WINDOWS_ALLOWED = new Set(
  [
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SystemDrive',
    'windir',
    'ComSpec',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'ProgramData',
    'CommonProgramFiles',
    'CommonProgramFiles(x86)',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    'USERNAME',
    'USERDOMAIN',
    'COMPUTERNAME',
    'PSModulePath',
  ].map((k) => k.toLowerCase()),
);
const PREFIX_ALLOWED = ['LC_'] as const;

/** Names that must never reach an agent even if a policy asks for them. */
const DENY = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|SESSION|COOKIE|AUTH|SSH_AUTH_SOCK|DOCKER_HOST|FORJA_)/i;

export type EnvOptions = {
  /** Paths inside the sandbox. */
  home: string;
  tmpdir: string;
  /** Keep the Windows system variables (native Windows, «directo» mode). */
  windows?: boolean;
  /** Extra non-secret variables required by the provider or task (validated). */
  extra?: Record<string, string>;
};

export function buildAgentEnv(source: NodeJS.ProcessEnv, options: EnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const allowed = (BASE_ALLOWED as readonly string[]).includes(key) || PREFIX_ALLOWED.some((p) => key.startsWith(p)) || (options.windows === true && WINDOWS_ALLOWED.has(key.toLowerCase()));
    if (allowed && !DENY.test(key)) env[key] = value;
  }
  if (options.windows) {
    // HOME is not a Windows variable: setting it would change where some tools look.
    if (source.HOME) env.HOME = options.home;
  } else env.HOME = options.home;
  env.TMPDIR = options.tmpdir;
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`nombre de variable inválido: ${key}`);
    if (DENY.test(key)) throw new Error(`la variable ${key} parece una credencial y no se entrega a agentes`);
    env[key] = value;
  }
  return env;
}
