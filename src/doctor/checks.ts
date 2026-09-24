import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type Level = 'ok' | 'aviso' | 'error';
export type Check = { id: string; title: string; level: Level; detail: string; fix?: string };

export type Exec = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realExec: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export type Platform = { os: NodeJS.Platform; wsl: boolean };

export function detectPlatform(readProcVersion: () => string = () => readFileSync('/proc/version', 'utf8')): Platform {
  if (process.platform !== 'linux') return { os: process.platform, wsl: false };
  try {
    return { os: 'linux', wsl: /microsoft|wsl/i.test(readProcVersion()) };
  } catch {
    return { os: 'linux', wsl: false };
  }
}

const MIN_NODE = [24, 11] as const;

export async function runChecks(exec: Exec = realExec, platform: Platform = detectPlatform(), nodeVersion = process.versions.node): Promise<Check[]> {
  const checks: Check[] = [];

  // Platform (D2-19): Linux and Windows through WSL2 in the MVP.
  if (platform.os === 'linux') {
    checks.push({ id: 'plataforma', title: 'Plataforma', level: 'ok', detail: platform.wsl ? 'Linux en WSL2 (Windows)' : 'Linux' });
  } else if (platform.os === 'win32') {
    checks.push({
      id: 'plataforma',
      title: 'Plataforma',
      level: 'error',
      detail: 'Windows nativo todavía no está soportado',
      fix: 'Instala WSL2 (wsl --install) y usa Forja dentro de la terminal de Ubuntu',
    });
  } else {
    checks.push({ id: 'plataforma', title: 'Plataforma', level: 'error', detail: `${platform.os} todavía no está soportado`, fix: 'Por ahora: Linux o Windows con WSL2' });
  }

  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  checks.push({
    id: 'node',
    title: 'Node.js',
    level: nodeOk ? 'ok' : 'error',
    detail: `v${nodeVersion}`,
    ...(nodeOk ? {} : { fix: `Se necesita Node ${MIN_NODE.join('.')} o superior` }),
  });

  const git = await exec('git', ['--version']);
  checks.push(git.code === 0 ? { id: 'git', title: 'Git', level: 'ok', detail: git.stdout.trim() } : { id: 'git', title: 'Git', level: 'error', detail: 'no instalado', fix: 'Instala git' });

  checks.push(await checkClaude(exec));
  checks.push(await checkCodex(exec));

  if (platform.os === 'linux') {
    const bwrap = await exec('bwrap', ['--version']);
    checks.push(
      bwrap.code === 0
        ? { id: 'sandbox', title: 'Sandbox (bubblewrap)', level: 'ok', detail: bwrap.stdout.trim() }
        : {
            id: 'sandbox',
            title: 'Sandbox (bubblewrap)',
            level: 'error',
            detail: 'no instalado: los agentes no pueden ejecutarse aislados',
            fix: 'sudo apt install bubblewrap',
          },
    );
  }
  return checks;
}

// Never reads credential files: only asks each official CLI whether it has a session.
async function checkClaude(exec: Exec): Promise<Check> {
  const version = await exec('claude', ['--version']);
  if (version.code !== 0) {
    return { id: 'claude', title: 'Claude Code', level: 'aviso', detail: 'no instalado', fix: 'npm install -g @anthropic-ai/claude-code y luego ejecuta: claude' };
  }
  const status = await exec('claude', ['auth', 'status']);
  let loggedIn = false;
  let method = '';
  let plan = '';
  try {
    const parsed = JSON.parse(status.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    loggedIn = parsed.loggedIn === true;
    method = parsed.authMethod ?? '';
    plan = parsed.subscriptionType ?? '';
  } catch {
    loggedIn = false;
  }
  const v = version.stdout.trim();
  if (!loggedIn) return { id: 'claude', title: 'Claude Code', level: 'aviso', detail: `${v} · sin sesión`, fix: 'Ejecuta: claude  (e inicia sesión con tu cuenta)' };
  return { id: 'claude', title: 'Claude Code', level: 'ok', detail: `${v} · sesión con ${method}${plan ? ` (${plan})` : ''}` };
}

async function checkCodex(exec: Exec): Promise<Check> {
  const version = await exec('codex', ['--version']);
  if (version.code !== 0) {
    return { id: 'codex', title: 'Codex', level: 'aviso', detail: 'no instalado', fix: 'npm install -g @openai/codex y luego ejecuta: codex login' };
  }
  const status = await exec('codex', ['login', 'status']);
  const text = `${status.stdout}${status.stderr}`.trim();
  const v = version.stdout.trim();
  if (status.code !== 0 || !/logged in/i.test(text)) {
    return { id: 'codex', title: 'Codex', level: 'aviso', detail: `${v} · sin sesión`, fix: 'Ejecuta: codex login' };
  }
  return { id: 'codex', title: 'Codex', level: 'ok', detail: `${v} · ${text.split('\n')[0]}` };
}

/** At least one provider with a session is required to work; both is the goal (D2-18). */
export function overall(checks: Check[]): Level {
  if (checks.some((c) => c.level === 'error')) return 'error';
  const providers = checks.filter((c) => c.id === 'claude' || c.id === 'codex');
  if (providers.every((c) => c.level !== 'ok')) return 'error';
  return checks.some((c) => c.level === 'aviso') ? 'aviso' : 'ok';
}
