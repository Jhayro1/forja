import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Simulation } from '../../src/core/engine.js';
import { getExec, Orchestrator, startOrResumeRun } from '../../src/run/orchestrator.js';
import { activeSandboxMode } from '../../src/runtime/sandbox-mode.js';
import { buildAgentEnv } from '../../src/security/env.js';
import { listTasks } from '../../src/store/projections.js';
import { commandArgv, localSocketPath, resolveCommand, shimTarget } from '../../src/util/proc.js';
import { testEngine } from '../helpers/engine.js';
import { FILES, seedApprovedPlan, sh } from '../run/fixture.js';

let cleanup: (() => void) | undefined;
const saved = { FORJA_SANDBOX: process.env.FORJA_SANDBOX, FORJA_EDICION: process.env.FORJA_EDICION };
afterEach(() => {
  cleanup?.();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('edición ligera: modo directo', () => {
  it('la edición ligera elige «directo»; la completa sigue con su sandbox', () => {
    expect(activeSandboxMode('win32', { FORJA_EDICION: 'ligera' })).toBe('directo');
    expect(activeSandboxMode('linux', { FORJA_EDICION: 'ligera' })).toBe('directo');
    expect(activeSandboxMode('linux', {})).toBe('bwrap');
    expect(activeSandboxMode('win32', {})).toBe('docker');
    // An explicit choice still wins.
    expect(activeSandboxMode('linux', { FORJA_EDICION: 'ligera', FORJA_SANDBOX: 'bwrap' })).toBe('bwrap');
  });

  it('en Windows el agente recibe las variables del sistema, pero nunca credenciales', () => {
    const source = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\u\\AppData\\Roaming', USERPROFILE: 'C:\\u', GITHUB_TOKEN: 'x', FORJA_SMTP_CLAVE: 'y', RANDOM: 'z' };
    const env = buildAgentEnv(source, { home: 'C:\\u', tmpdir: 'C:\\t', windows: true });
    expect(env).toMatchObject({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\u\\AppData\\Roaming', USERPROFILE: 'C:\\u' });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.FORJA_SMTP_CLAVE).toBeUndefined();
    expect(env.RANDOM).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    // Linux/macOS: as before.
    expect(buildAgentEnv(source, { home: '/h', tmpdir: '/tmp' }).SystemRoot).toBeUndefined();
  });

  it('en Windows los .cmd de npm se ejecutan con node, sin pasar por cmd.exe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-shim-'));
    const pkg = join(dir, 'node_modules', '@openai', 'codex', 'bin');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'codex.js'), '');
    writeFileSync(join(dir, 'codex.cmd'), '@ECHO off\r\nGOTO start\r\n:start\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    writeFileSync(join(dir, 'codex'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'claude.exe'), '');
    expect(shimTarget(join(dir, 'codex.cmd'))).toBe(join(pkg, 'codex.js'));
    // On Windows the extension-less sh script is never picked.
    expect(resolveCommand('codex', dir, 'win32', {})).toBe(join(pkg, 'codex.js'));
    expect(resolveCommand('claude', dir, 'win32', {})).toBe(join(dir, 'claude.exe'));
    expect(commandArgv(join(pkg, 'codex.js'))).toEqual([process.execPath, join(pkg, 'codex.js')]);
    expect(commandArgv('C:\\x\\otro.cmd', 'win32', { ComSpec: 'C:\\Windows\\cmd.exe' })).toEqual(['C:\\Windows\\cmd.exe', '/d', '/c', 'C:\\x\\otro.cmd']);
    const npmDir = join(dir, 'npm');
    mkdirSync(join(npmDir, 'node_modules', 'npm', 'bin'), { recursive: true });
    writeFileSync(join(npmDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    writeFileSync(join(npmDir, 'npm.cmd'), ':: npm propio\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\n');
    expect(resolveCommand('npm', npmDir, 'win32', {})).toBe(join(npmDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  });

  it('en Windows el gateway usa una tubería con nombre', () => {
    const pipe = localSocketPath('C:\\Users\\x\\AppData\\Local\\Temp\\fmcp-1\\abc', 'p.sock', 'win32');
    expect(pipe.startsWith('\\\\.\\pipe\\forja-')).toBe(true);
    expect(localSocketPath('/tmp/fmcp-1/abc', 'p.sock', 'linux')).toBe(join('/tmp/fmcp-1/abc', 'p.sock'));
  });

  it('un bloque corre de punta a punta sin sandbox propio, con verificación e integración', async () => {
    process.env.FORJA_SANDBOX = 'directo';
    const agents: Simulation = ({ role, taskId }) =>
      role === 'revisor'
        ? { pasos: [], estructurado: { criterios: [], hallazgos: [], veredicto: 'aprobado', resumen: 'ok' } }
        : { pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' };
    const t = testEngine(agents);
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir, undefined, { comandos: { test: { executable: 'node', args: ['--test'] } } });
    const mainBefore = sh(repo, 'rev-parse', 'main');
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const log: string[] = [];
    // sandbox: true on purpose: in «directo» mode that means «Forja's normal path», not bwrap.
    const summary = await new Orchestrator(t.engine, repo, runId, { block: { tasks: ['T-001', 'T-002', 'T-003', 'T-004', 'T-005'] }, sandbox: true, pollMs: 100, onLog: (l) => log.push(l) }).loop();
    expect(summary.state, log.join('\n')).toBe('completado');
    expect(listTasks(t.engine.store.db, runId).every((x) => x.state === 'integrada')).toBe(true);
    expect(getExec(t.engine, runId, 'T-005').session_id).toBe(getExec(t.engine, runId, 'T-001').session_id);
    expect(sh(repo, 'rev-parse', 'main')).toBe(mainBefore);
    expect(sh(repo, 'show', `${summary.deliveryBranch!}:src/uc-002.mjs`)).toContain('reduce');
  }, 300_000);
});
