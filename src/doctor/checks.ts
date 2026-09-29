import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ensureSandboxImage } from '../runtime/docker-sandbox.js';

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

/** node:sqlite without a flag (22.13); CI runs Node 22 and 24 (MEJORAS 3.11). */
const MIN_NODE = [22, 13] as const;

export async function runChecks(exec: Exec = realExec, platform: Platform = detectPlatform(), nodeVersion = process.versions.node): Promise<Check[]> {
  const checks: Check[] = [];

  // Platform (D2-19, ADR-012): Linux (bwrap), o cualquier SO con Docker (macOS, Windows
  // nativo, o Linux si bwrap no sirve). Windows también sigue funcionando vía WSL2.
  if (platform.os === 'linux') {
    checks.push({ id: 'plataforma', title: 'Plataforma', level: 'ok', detail: platform.wsl ? 'Linux en WSL2 (Windows)' : 'Linux' });
  } else if (platform.os === 'win32') {
    checks.push({ id: 'plataforma', title: 'Plataforma', level: 'ok', detail: 'Windows nativo (aislamiento vía Docker; alternativa: WSL2)' });
  } else if (platform.os === 'darwin') {
    checks.push({ id: 'plataforma', title: 'Plataforma', level: 'ok', detail: 'macOS (aislamiento vía Docker)' });
  } else {
    checks.push({ id: 'plataforma', title: 'Plataforma', level: 'error', detail: `${platform.os} todavía no está soportado`, fix: 'Por ahora: Linux, macOS o Windows, con Docker instalado' });
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

  let sandboxOk = false;
  if (platform.os === 'linux') {
    const bwrap = await exec('bwrap', ['--version']);
    // Installed is not enough: inside a container without user namespaces bwrap exists but cannot isolate.
    const works = bwrap.code === 0 ? await exec('bwrap', ['--ro-bind', '/', '/', '--unshare-net', 'true']) : null;
    sandboxOk = works?.code === 0;
    if (sandboxOk) checks.push({ id: 'sandbox', title: 'Sandbox (bubblewrap)', level: 'ok', detail: bwrap.stdout.trim() });
    else if (bwrap.code === 0 && process.env.FORJA_SANDBOX !== 'docker')
      checks.push({
        id: 'sandbox_bwrap',
        title: 'Sandbox (bubblewrap)',
        level: 'aviso',
        detail: `${bwrap.stdout.trim()} instalado pero no puede crear namespaces (¿contenedor sin permisos?): ${(works?.stderr ?? '').trim().split('\n')[0]?.slice(0, 160) ?? ''}`,
        fix: 'En un contenedor, dale los permisos que necesita bubblewrap o usa FORJA_SANDBOX=docker (docs/guias/SERVIDOR.md)',
      });
  }
  if (!sandboxOk) checks.push(await checkDockerSandbox(exec, platform.os === 'linux'));
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

/** Docker sandbox (ADR-012): fallback for macOS, Windows nativo, o Linux sin bwrap usable. */
async function checkDockerSandbox(exec: Exec, bwrapFailedOnLinux: boolean): Promise<Check> {
  const info = await exec('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (info.code !== 0) {
    return {
      id: 'sandbox',
      title: 'Sandbox (Docker)',
      level: 'error',
      detail: bwrapFailedOnLinux ? 'bubblewrap no funciona y Docker tampoco está disponible: los agentes no pueden ejecutarse aislados' : 'Docker no está instalado o el daemon no responde',
      fix: 'Instala Docker Desktop (macOS/Windows) o el paquete docker de tu distro (Linux), y asegúrate de que esté corriendo',
    };
  }
  const image = await ensureSandboxImage(exec);
  if (!image.ok) {
    return {
      id: 'sandbox',
      title: 'Sandbox (Docker)',
      level: 'error',
      detail: `no se pudo preparar la imagen del sandbox: ${image.detail}`,
      fix: 'Revisa que docker pueda construir imágenes (docker build) y que tengas salida de red',
    };
  }
  return { id: 'sandbox', title: 'Sandbox (Docker)', level: 'ok', detail: `Docker ${info.stdout.trim()} · imagen ${image.detail}` };
}

/** At least one provider with a session is required to work; both is the goal (D2-18). */
export function overall(checks: Check[]): Level {
  if (checks.some((c) => c.level === 'error')) return 'error';
  const providers = checks.filter((c) => c.id === 'claude' || c.id === 'codex');
  if (providers.every((c) => c.level !== 'ok')) return 'error';
  return checks.some((c) => c.level === 'aviso') ? 'aviso' : 'ok';
}
