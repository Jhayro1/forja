import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerArgs } from '../runtime/docker-sandbox.js';
import { binaryBinds, bwrapArgs, SANDBOX_HELPER_DIR, SANDBOX_PROXY_SOCKET } from '../runtime/sandbox.js';
import { DestinationError, hostOf, pinDestination, portOf } from './destination.js';
import type { ExecutorOrder, ExecutorResult } from './executor-main.js';
import { PinnedTunnelProxy } from './tunnel.js';

export const DEFAULT_EXECUTOR = fileURLToPath(new URL('./executor-main.js', import.meta.url));

/** How the isolated executor process is started (strategy: plain process or bubblewrap). */
export interface ExecutorRunner {
  run(order: ExecutorOrder): Promise<ExecutorResult>;
}

/** Collects the single JSON line of an executor child; kills it at the deadline. */
function collect(child: ReturnType<typeof spawn>, order: ExecutorOrder, cleanup: () => void | Promise<void>): Promise<ExecutorResult> {
  return new Promise<ExecutorResult>((resolve) => {
    let out = '';
    let settled = false;
    const done = (r: ExecutorResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void Promise.resolve(cleanup()).finally(() => resolve(r));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ phase: 'incierto', detail: `el ejecutor no terminó a tiempo${err ? ` (${err.trim().split('\n').slice(-2).join(' ')})` : ''}` });
    }, order.timeoutMs + 5_000);
    let err = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => (out += c));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      if (err.length < 4000) err += c;
    });
    child.on('error', (e) => done({ phase: 'no_enviado', detail: `no arrancó el ejecutor: ${e.message}` }));
    child.on('close', () => {
      try {
        done(JSON.parse(out.trim().split('\n').at(-1) ?? '') as ExecutorResult);
      } catch {
        done({ phase: 'incierto', detail: `el ejecutor terminó sin informar el resultado${err ? `: ${err.trim().split('\n').slice(-2).join(' ')}` : ''}` });
      }
    });
    child.stdin!.end(JSON.stringify(order));
  });
}

/** Separate process, empty environment and empty working directory. */
export class ProcessExecutorRunner implements ExecutorRunner {
  constructor(private readonly script = DEFAULT_EXECUTOR) {}

  run(order: ExecutorOrder): Promise<ExecutorResult> {
    const cwd = mkdtempSync(join(tmpdir(), 'forja-ejecutor-'));
    const child = spawn(process.execPath, [this.script], { cwd, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    return collect(child, order, () => rmSync(cwd, { recursive: true, force: true }));
  }
}

/**
 * The executor inside bubblewrap (MEJORAS 4.2): the user's HOME (vault, keys,
 * other projects) and /tmp are hidden, nothing is writable but an empty folder,
 * and there is no network — only a tunnel to the action's own destinations,
 * resolved and checked here before the process starts.
 */
export class SandboxedExecutorRunner implements ExecutorRunner {
  constructor(private readonly script = DEFAULT_EXECUTOR) {}

  async run(order: ExecutorOrder): Promise<ExecutorResult> {
    const urls = [new URL(order.request.url), ...(order.request.precondition ? [new URL(order.request.precondition.url)] : [])];
    const pins = new Map<string, string>();
    try {
      for (const u of urls) pins.set(`${hostOf(u).toLowerCase()}:${portOf(u)}`, await pinDestination(u, order.allowLocal));
    } catch (e) {
      if (e instanceof DestinationError) return { phase: e.kind, detail: e.message };
      throw e;
    }
    const dir = mkdtempSync(join(tmpdir(), 'forja-ejecutor-'));
    const work = join(dir, 'trabajo');
    const socket = join(dir, 't.sock');
    const tunnel = new PinnedTunnelProxy(socket, pins);
    await tunnel.start();
    mkdirSync(work);
    const args = bwrapArgs({
      workspace: work,
      home: work,
      mounts: [],
      readOnly: binaryBinds([process.execPath]),
      proxySocket: socket,
      helperDir: dirname(this.script),
    });
    const child = spawn('bwrap', [...args, process.execPath, `${SANDBOX_HELPER_DIR}/${this.script.split('/').pop()}`], { cwd: work, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    return collect(child, { ...order, tunnel: SANDBOX_PROXY_SOCKET }, async () => {
      await tunnel.stop();
      rmSync(dir, { recursive: true, force: true });
    });
  }
}

/** Same isolation as `SandboxedExecutorRunner`, inside a container instead of bwrap (ADR-012). */
export class DockerExecutorRunner implements ExecutorRunner {
  constructor(
    private readonly script = DEFAULT_EXECUTOR,
    private readonly image?: string,
  ) {}

  async run(order: ExecutorOrder): Promise<ExecutorResult> {
    const urls = [new URL(order.request.url), ...(order.request.precondition ? [new URL(order.request.precondition.url)] : [])];
    const pins = new Map<string, string>();
    try {
      for (const u of urls) pins.set(`${hostOf(u).toLowerCase()}:${portOf(u)}`, await pinDestination(u, order.allowLocal));
    } catch (e) {
      if (e instanceof DestinationError) return { phase: e.kind, detail: e.message };
      throw e;
    }
    const dir = mkdtempSync(join(tmpdir(), 'forja-ejecutor-'));
    const work = join(dir, 'trabajo');
    const socket = join(dir, 't.sock');
    const tunnel = new PinnedTunnelProxy(socket, pins);
    await tunnel.start();
    mkdirSync(work);
    const args = dockerArgs({ workspace: work, home: work, mounts: [], readOnly: binaryBinds([process.execPath]), proxySocket: socket, helperDir: dirname(this.script) }, {}, this.image);
    const child = spawn('docker', [...args, process.execPath, `${SANDBOX_HELPER_DIR}/${this.script.split('/').pop()}`], { cwd: work, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    return collect(child, { ...order, tunnel: SANDBOX_PROXY_SOCKET }, async () => {
      await tunnel.stop();
      rmSync(dir, { recursive: true, force: true });
    });
  }
}

let bwrapWorks: boolean | null = null;
let dockerWorks: boolean | null = null;

/** bwrap when it works on this machine; else Docker when its sandbox image exists; else the plain isolated process (doctor already warns). */
export function defaultExecutorRunner(): ExecutorRunner {
  bwrapWorks ??= spawnSync('bwrap', ['--ro-bind', '/', '/', 'true'], { stdio: 'ignore' }).status === 0;
  if (bwrapWorks) return new SandboxedExecutorRunner();
  dockerWorks ??= spawnSync('docker', ['image', 'inspect', 'forja-sandbox:latest'], { stdio: 'ignore' }).status === 0;
  return dockerWorks ? new DockerExecutorRunner() : new ProcessExecutorRunner();
}
