import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LockFile, currentIdentity } from '../registry/lock.js';
import { Redactor } from '../security/redact.js';
import { AllowlistProxy, hostMatcher } from './netproxy.js';
import { FILES, LaunchOrder, type LaunchResult, type SpoolRecord } from './order.js';
import { SANDBOX_HELPER_DIR, SANDBOX_PROXY_SOCKET, bwrapArgs } from './sandbox.js';

const HEARTBEAT_MS = 5000;
const BRIDGE_PORT = 18080;

/** Directory holding bridge.js (compiled next to this file). */
const HELPER_DIR = dirname(fileURLToPath(import.meta.url));

/** Values of long strings inside credential files, so they can be redacted if they leak. */
export function secretsFromFile(path: string): string[] {
  try {
    const text = readFileSync(path, 'utf8');
    const values: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string' && v.length >= 20) values.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(JSON.parse(text));
    return values;
  } catch {
    return [];
  }
}

class Spool {
  private seq = 0;
  private readonly path: string;
  private pending = 0;
  private fd: number;

  constructor(dir: string) {
    this.path = join(dir, FILES.spool);
    if (existsSync(this.path)) {
      // A runner restarted on the same launch continues the numbering.
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      const last = lines.at(-1);
      if (last) this.seq = (JSON.parse(last) as SpoolRecord).seq;
    }
    this.fd = openSync(this.path, 'a', 0o600);
  }

  write(stream: SpoolRecord['stream'], line: string): void {
    const record: SpoolRecord = { seq: ++this.seq, ts: new Date().toISOString(), stream, line };
    appendFileSync(this.fd, `${JSON.stringify(record)}\n`);
    if (++this.pending >= 20) this.flush();
  }

  flush(): void {
    fsyncSync(this.fd);
    this.pending = 0;
  }

  get lastSeq(): number {
    return this.seq;
  }

  close(): void {
    this.flush();
    closeSync(this.fd);
  }
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  writeFileSync(fd, data);
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

/**
 * Supervises ONE launch: sandbox, proxy, redacted spool, heartbeat, timeout and a
 * durable result. Survives the daemon's death; if the runner dies, bwrap
 * (--die-with-parent) takes the whole agent tree with it.
 */
export async function runLaunch(dir: string): Promise<LaunchResult> {
  const order = LaunchOrder.parse(JSON.parse(readFileSync(join(dir, FILES.order), 'utf8')));
  const resultPath = join(dir, FILES.result);
  if (existsSync(resultPath)) return JSON.parse(readFileSync(resultPath, 'utf8')) as LaunchResult;

  // Signals are handled before the runner is announced: a cancel that arrives
  // while starting must still produce a durable "cancelado" result.
  let cancelRequested = false;
  let onCancel: () => void = () => {
    cancelRequested = true;
  };
  process.on('SIGTERM', () => onCancel());
  process.on('SIGINT', () => onCancel());

  // A duplicated order never starts a second writer on the same launch (I06).
  const lock = LockFile.acquire(join(dir, FILES.lock), `lanzamiento ${order.launch_id}`);
  writeAtomic(join(dir, FILES.runner), JSON.stringify({ ...currentIdentity(), launch_id: order.launch_id, fencing_token: order.fencing_token }));

  const redactor = new Redactor();
  for (const file of order.redact_files) for (const value of secretsFromFile(file)) redactor.add({ name: 'credencial_proveedor', value });
  const spool = new Spool(dir);
  const startedAt = new Date().toISOString();
  const heartbeatPath = join(dir, FILES.heartbeat);
  writeFileSync(heartbeatPath, '');
  const beat = setInterval(() => {
    const now = new Date();
    utimesSync(heartbeatPath, now, now);
  }, HEARTBEAT_MS);

  let proxy: AllowlistProxy | null = null;
  let socketDir: string | null = null;
  let child: ChildProcess;
  try {
    let file: string;
    let args: string[];
    if (order.sandbox.mode === 'bwrap') {
      const net = order.sandbox.network_hosts;
      let proxySocket: string | undefined;
      if (net !== null) {
        // Unix socket paths are limited to ~107 bytes: keep it short and private (0700 dir).
        socketDir = mkdtempSync(join(tmpdir(), 'forja-px-'));
        proxySocket = join(socketDir, 'p.sock');
        proxy = new AllowlistProxy(proxySocket, hostMatcher(net), (d) => {
          spool.write('forja', JSON.stringify({ tipo: 'red', host: d.host, puerto: d.port, permitido: d.allowed }));
        });
        await proxy.start();
      }
      const inner = proxySocket
        ? [process.execPath, `${SANDBOX_HELPER_DIR}/bridge.js`, SANDBOX_PROXY_SOCKET, String(BRIDGE_PORT), '--', ...order.argv]
        : order.argv;
      const env = proxySocket
        ? { ...order.env, HTTPS_PROXY: `http://127.0.0.1:${BRIDGE_PORT}`, HTTP_PROXY: `http://127.0.0.1:${BRIDGE_PORT}`, https_proxy: `http://127.0.0.1:${BRIDGE_PORT}`, http_proxy: `http://127.0.0.1:${BRIDGE_PORT}`, NO_PROXY: '', no_proxy: '' }
        : order.env;
      const spec = {
        workspace: order.cwd,
        workspaceReadOnly: order.sandbox.workspace_read_only,
        home: order.sandbox.home,
        mounts: order.sandbox.mounts,
        readOnly: order.sandbox.read_only,
        helperDir: HELPER_DIR,
        ...(proxySocket ? { proxySocket } : {}),
      };
      file = 'bwrap';
      args = [...bwrapArgs(spec), '--clearenv', ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v]), '--', ...inner];
    } else {
      [file, ...args] = order.argv as [string, ...string[]];
    }
    child = spawn(file, args, {
      cwd: order.cwd,
      env: order.sandbox.mode === 'bwrap' ? { PATH: process.env.PATH ?? '/usr/bin:/bin' } : order.env,
      stdio: [order.stdin_text !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return finish('error_inicio', null, null, (error as Error).message);
  }

  spool.write('forja', JSON.stringify({ tipo: 'iniciado', pid: child.pid ?? null }));
  if (order.stdin_text !== undefined) child.stdin?.end(order.stdin_text);

  const out = redactor.stream();
  const err = redactor.stream();
  const emit = (stream: 'stdout' | 'stderr', text: string) => {
    for (const line of text.split('\n')) if (line.length > 0) spool.write(stream, line.length > 1_000_000 ? `${line.slice(0, 1_000_000)}…[recortado]` : line);
  };
  child.stdout!.setEncoding('utf8').on('data', (c: string) => emit('stdout', out.push(c)));
  child.stderr!.setEncoding('utf8').on('data', (c: string) => emit('stderr', err.push(c)));

  let reason: LaunchResult['status'] = 'terminado';
  const stop = (why: LaunchResult['status']) => {
    if (reason !== 'terminado') return;
    reason = why;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), order.kill_grace_ms).unref();
  };
  const timer = setTimeout(() => stop('tiempo_agotado'), order.timeout_ms);
  onCancel = () => stop('cancelado');
  if (cancelRequested) stop('cancelado');

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on('error', (error) => {
      spool.write('forja', JSON.stringify({ tipo: 'error', mensaje: error.message }));
      resolve([127, null]);
    });
    child.on('close', (c, s) => resolve([c, s]));
  });
  clearTimeout(timer);
  emit('stdout', out.end());
  emit('stderr', err.end());
  return finish(reason, code, signal);

  async function finish(status: LaunchResult['status'], exitCode: number | null, sig: NodeJS.Signals | null, detail?: string): Promise<LaunchResult> {
    clearInterval(beat);
    await proxy?.stop();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
    const result: LaunchResult = {
      launch_id: order.launch_id,
      status,
      exit_code: exitCode,
      signal: sig,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      last_seq: spool.lastSeq,
      ...(detail ? { detail } : {}),
    };
    spool.close();
    // Result is durable before anyone is told the launch finished.
    writeAtomic(resultPath, JSON.stringify(result));
    lock.release();
    return result;
  }
}
