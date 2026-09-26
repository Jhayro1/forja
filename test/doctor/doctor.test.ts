import { describe, expect, it } from 'vitest';
import { detectPlatform, type Exec, overall, runChecks } from '../../src/doctor/checks.js';

function fakeExec(answers: Record<string, { code: number; stdout?: string; stderr?: string }>): Exec {
  return async (file, args) => {
    const a = answers[[file, ...args].join(' ')] ?? { code: 127 };
    return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
  };
}

const ALL_OK = {
  'git --version': { code: 0, stdout: 'git version 2.43.0' },
  'claude --version': { code: 0, stdout: '2.1.281 (Claude Code)' },
  'claude auth status': { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"x@y.z"}' },
  'codex --version': { code: 0, stdout: 'codex-cli 0.156.1' },
  'codex login status': { code: 0, stdout: 'Logged in using ChatGPT' },
  'bwrap --version': { code: 0, stdout: 'bubblewrap 0.9.0' },
};
const LINUX = { os: 'linux' as const, wsl: false };
const DOCKER_OK = {
  ...ALL_OK,
  'bwrap --version': { code: 127 },
  'docker info --format {{.ServerVersion}}': { code: 0, stdout: '27.3.1' },
  'docker image inspect forja-sandbox:latest': { code: 0 },
};

describe('doctor', () => {
  it('todo listo con los dos proveedores', async () => {
    const checks = await runChecks(fakeExec(ALL_OK), LINUX, '24.18.0');
    expect(overall(checks)).toBe('ok');
    expect(checks.find((c) => c.id === 'claude')?.detail).toContain('claude.ai (pro)');
  });

  it('nunca muestra el correo de la cuenta', async () => {
    const checks = await runChecks(fakeExec(ALL_OK), LINUX, '24.18.0');
    expect(JSON.stringify(checks)).not.toContain('x@y.z');
  });

  it('con un solo proveedor se puede trabajar, con aviso', async () => {
    const checks = await runChecks(fakeExec({ ...ALL_OK, 'codex login status': { code: 1, stdout: 'Not logged in' } }), LINUX, '24.18.0');
    expect(checks.find((c) => c.id === 'codex')).toMatchObject({ level: 'aviso', fix: 'Ejecuta: codex login' });
    expect(overall(checks)).toBe('aviso');
  });

  it('sin ningún proveedor con sesión no se puede trabajar', async () => {
    const exec = fakeExec({ ...ALL_OK, 'claude auth status': { code: 0, stdout: '{"loggedIn":false}' }, 'codex --version': { code: 127 } });
    expect(overall(await runChecks(exec, LINUX, '24.18.0'))).toBe('error');
  });

  it('Windows nativo se soporta vía Docker (o WSL2)', async () => {
    const checks = await runChecks(fakeExec(DOCKER_OK), { os: 'win32', wsl: false }, '24.18.0');
    expect(checks[0]).toMatchObject({ level: 'ok', detail: expect.stringContaining('Docker') });
  });

  it('macOS se soporta vía Docker', async () => {
    const checks = await runChecks(fakeExec(DOCKER_OK), { os: 'darwin', wsl: false }, '24.18.0');
    expect(checks[0]).toMatchObject({ level: 'ok', detail: expect.stringContaining('Docker') });
    expect(checks.find((c) => c.id === 'sandbox')).toMatchObject({ level: 'ok', title: 'Sandbox (Docker)' });
  });

  it('sin bubblewrap cae a Docker; si Docker también falla, error', async () => {
    const conDocker = await runChecks(fakeExec(DOCKER_OK), LINUX, '24.18.0');
    expect(conDocker.find((c) => c.id === 'sandbox')).toMatchObject({ level: 'ok', title: 'Sandbox (Docker)' });

    const sinNada = await runChecks(fakeExec({ ...ALL_OK, 'bwrap --version': { code: 127 } }), LINUX, '24.18.0');
    expect(sinNada.find((c) => c.id === 'sandbox')?.level).toBe('error');
  });

  it('Docker instalado pero sin poder construir la imagen es un error', async () => {
    // La imagen no existe y el build (comando no cubierto por el fake -> code 127) falla.
    const checks = await runChecks(fakeExec({ ...DOCKER_OK, 'docker image inspect forja-sandbox:latest': { code: 1 } }), LINUX, '24.18.0');
    expect(checks.find((c) => c.id === 'sandbox')).toMatchObject({ level: 'error', detail: expect.stringContaining('no se pudo preparar la imagen') });
  });

  it('Node viejo es un error', async () => {
    expect(overall(await runChecks(fakeExec(ALL_OK), LINUX, '22.3.0'))).toBe('error');
    expect(overall(await runChecks(fakeExec(ALL_OK), LINUX, '22.13.0'))).toBe('ok');
    expect(overall(await runChecks(fakeExec(ALL_OK), LINUX, '20.19.0'))).toBe('error');
  });

  it('detecta WSL por /proc/version', () => {
    if (process.platform !== 'linux') return;
    expect(detectPlatform(() => 'Linux version 5.15.167.4-microsoft-standard-WSL2').wsl).toBe(true);
    expect(detectPlatform(() => 'Linux version 6.8.0-136-generic').wsl).toBe(false);
  });
});
