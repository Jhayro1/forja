import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelLaunch, launchStatus, readSpool, spawnRunner, waitForLaunch, writeOrder } from '../../src/runtime/launcher.js';
import type { LaunchOrder } from '../../src/runtime/order.js';

const ROOT = resolve(import.meta.dirname, '../..');
const RUNNER = join(ROOT, 'dist/runtime/runner-main.js');
const HAS_BWRAP = spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status === 0;
const HAS_DOCKER = spawnSync('docker', ['image', 'inspect', 'forja-sandbox:latest']).status === 0;

let base: string;
beforeAll(() => {
  if (!existsSync(RUNNER)) execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
  base = realpathSync(mkdtempSync(join(tmpdir(), 'forja-run-')));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function order(partial: Partial<LaunchOrder> & Pick<LaunchOrder, 'argv' | 'sandbox'>): { dir: string; order: LaunchOrder } {
  const id = `lan_${++n}`;
  const dir = join(base, id);
  const ws = join(base, `ws_${n}`);
  mkdirSync(ws, { recursive: true });
  return {
    dir,
    order: {
      protocol_version: 1,
      launch_id: id,
      fencing_token: 1,
      run_id: 'run_1',
      task_id: 'T-001',
      attempt: 1,
      provider: 'simulado',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: ws },
      cwd: ws,
      timeout_ms: 20_000,
      kill_grace_ms: 500,
      redact_files: [],
      ...partial,
    },
  };
}

describe('runner sin sandbox (lógica de supervisión)', () => {
  it('guarda la salida en el spool y un resultado durable', async () => {
    const { dir, order: o } = order({ argv: ['sh', '-c', 'echo uno; echo dos 1>&2; echo tres'], sandbox: { mode: 'ninguno' } });
    writeOrder(dir, o);
    spawnRunner(dir, RUNNER);
    const status = await waitForLaunch(dir, 10_000);
    expect(status.state).toBe('terminado');
    if (status.state === 'terminado') expect(status.result).toMatchObject({ status: 'terminado', exit_code: 0 });
    const spool = readSpool(dir);
    expect(spool.filter((r) => r.stream === 'stdout').map((r) => r.line)).toEqual(['uno', 'tres']);
    expect(spool.filter((r) => r.stream === 'stderr').map((r) => r.line)).toEqual(['dos']);
    expect(spool.map((r) => r.seq)).toEqual([...spool.keys()].map((i) => i + 1));
    expect(readSpool(dir, 2).every((r) => r.seq > 2)).toBe(true);
  });

  it('redacta credenciales conocidas antes de escribir el spool', async () => {
    const cred = join(base, 'cred.json');
    writeFileSync(cred, JSON.stringify({ oauth: { accessToken: 'tok-canario-1234567890-abcdef' } }));
    const { dir, order: o } = order({ argv: ['sh', '-c', 'echo "fuga: tok-canario-1234567890-abcdef"'], sandbox: { mode: 'ninguno' }, redact_files: [cred] });
    writeOrder(dir, o);
    spawnRunner(dir, RUNNER);
    await waitForLaunch(dir, 10_000);
    const text = readFileSync(join(dir, 'spool.jsonl'), 'utf8');
    expect(text).not.toContain('tok-canario');
    expect(text).toContain('«secreto:credencial_proveedor»');
  });

  it('corta por tiempo agotado', async () => {
    const { dir, order: o } = order({ argv: ['sleep', '30'], sandbox: { mode: 'ninguno' }, timeout_ms: 500 });
    writeOrder(dir, o);
    spawnRunner(dir, RUNNER);
    const status = await waitForLaunch(dir, 10_000);
    expect(status.state === 'terminado' && status.result.status).toBe('tiempo_agotado');
  });

  it('una orden duplicada no lanza un segundo proceso', async () => {
    const { dir, order: o } = order({ argv: ['sh', '-c', 'echo x >> veces.txt; sleep 1'], sandbox: { mode: 'ninguno' } });
    writeOrder(dir, o);
    writeOrder(dir, o); // idéntica: aceptada sin cambios
    spawnRunner(dir, RUNNER);
    spawnRunner(dir, RUNNER);
    await waitForLaunch(dir, 10_000);
    spawnRunner(dir, RUNNER); // ya terminó: no vuelve a ejecutar
    await new Promise((r) => setTimeout(r, 500));
    expect(readFileSync(join(o.cwd, 'veces.txt'), 'utf8')).toBe('x\n');
  });

  it('rechaza una orden distinta para el mismo lanzamiento', () => {
    const { dir, order: o } = order({ argv: ['true'], sandbox: { mode: 'ninguno' } });
    writeOrder(dir, o);
    expect(() => writeOrder(dir, { ...o, argv: ['false'] })).toThrow(/otra orden/);
  });

  it('cancelar detiene el proceso y lo deja registrado', async () => {
    const { dir, order: o } = order({ argv: ['sleep', '30'], sandbox: { mode: 'ninguno' } });
    writeOrder(dir, o);
    spawnRunner(dir, RUNNER);
    for (let i = 0; i < 50 && launchStatus(dir).state !== 'corriendo'; i++) await new Promise((r) => setTimeout(r, 100));
    expect(cancelLaunch(dir)).toBe(true);
    const status = await waitForLaunch(dir, 10_000);
    expect(status.state === 'terminado' && status.result.status).toBe('cancelado');
  });
});

describe.skipIf(!HAS_BWRAP)('runner con bwrap', () => {
  it('matar el runner con -9 mata todo el árbol, incluidos procesos con setsid (hallazgo 5 de M0)', async () => {
    const script = 'setsid sh -c "while true; do date +%s%N >> latidos.txt; sleep 0.1; done" & sleep 60';
    const { dir, order: o } = order({
      argv: ['sh', '-c', script],
      sandbox: { mode: 'bwrap', home: '/root', mounts: [], read_only: [], network_hosts: null, workspace_read_only: false },
    });
    writeOrder(dir, o);
    spawnRunner(dir, RUNNER);
    for (let i = 0; i < 50 && !existsSync(join(o.cwd, 'latidos.txt')); i++) await new Promise((r) => setTimeout(r, 100));
    const status = launchStatus(dir);
    expect(status.state).toBe('corriendo');
    if (status.state !== 'corriendo') return;
    process.kill(status.runner.pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 700));
    const before = readFileSync(join(o.cwd, 'latidos.txt'), 'utf8').length;
    await new Promise((r) => setTimeout(r, 700));
    expect(readFileSync(join(o.cwd, 'latidos.txt'), 'utf8').length).toBe(before);
    expect(launchStatus(dir).state).toBe('interrumpido');
  });

  it('dentro del sandbox: no ve el HOME real, no escribe fuera, sin red', async () => {
    const outside = '/etc/forja-prueba-no-deberia-existir';
    const script = `ls -A "$HOME" | wc -l; (echo x > ${outside}) 2>/dev/null && echo escribio || echo no_escribio; (exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && echo con_red || echo sin_red`;
    const { dir, order: o } = order({
      argv: ['bash', '-c', script],
      sandbox: { mode: 'bwrap', home: '/root', mounts: [], read_only: [], network_hosts: [], workspace_read_only: false },
    });
    writeOrder(dir, o);
    spawnRunner(dir, RUNNER);
    await waitForLaunch(dir, 15_000);
    const lines = readSpool(dir)
      .filter((r) => r.stream === 'stdout')
      .map((r) => r.line.trim());
    expect(lines).toEqual(['0', 'no_escribio', 'sin_red']);
    expect(existsSync(outside)).toBe(false);
  });

  it('el proxy deja pasar sólo los hosts permitidos y lo registra', async () => {
    const node = process.execPath;
    const js = `const net=require('net');function t(h){return new Promise(r=>{const s=net.connect(18080,'127.0.0.1',()=>s.write('CONNECT '+h+':443 HTTP/1.1\\r\\nHost: '+h+'\\r\\n\\r\\n'));s.once('data',d=>{r(d.toString().split('\\r\\n')[0]);s.destroy()});s.on('error',e=>r('error '+e.message));s.on('close',()=>r('cerrado'))})}(async()=>{console.log(await t('permitido.invalid'));console.log(await t('example.com'))})()`;
    const { dir, order: o } = order({
      argv: [node, '-e', js],
      sandbox: { mode: 'bwrap', home: '/root', mounts: [], read_only: [], network_hosts: ['permitido.invalid'], workspace_read_only: false },
    });
    writeOrder(dir, o);
    spawnRunner(dir, RUNNER);
    await waitForLaunch(dir, 15_000);
    const spool = readSpool(dir);
    const out = spool.filter((r) => r.stream === 'stdout').map((r) => r.line);
    // permitido.invalid no resuelve: el proxy lo acepta y responde 502; example.com se rechaza con 403.
    expect(out).toEqual(['HTTP/1.1 502 Bad Gateway', 'HTTP/1.1 403 Forbidden']);
    const net = spool
      .filter((r) => r.stream === 'forja')
      .map((r) => JSON.parse(r.line) as { tipo: string; host?: string; permitido?: boolean })
      .filter((e) => e.tipo === 'red');
    expect(net).toEqual([
      { tipo: 'red', host: 'permitido.invalid', puerto: 443, permitido: true },
      { tipo: 'red', host: 'example.com', puerto: 443, permitido: false },
    ]);
  });
});

describe.skipIf(!HAS_DOCKER)('runner con docker (ADR-012-aislamiento-docker.md)', () => {
  const nodeRoot = join(process.execPath, '..', '..');

  it('dentro del contenedor: no ve el HOME real, no escribe fuera del workspace/tmpfs, sin red', async () => {
    const outside = '/etc/forja-prueba-docker-no-deberia-existir';
    const script = `ls -A "$HOME" | wc -l; (echo x > ${outside}) 2>/dev/null && echo escribio || echo no_escribio; (exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null && echo con_red || echo sin_red`;
    const { dir, order: o } = order({
      argv: ['bash', '-c', script],
      // network_hosts: [] (not null) still stands up the proxy+bridge, which re-execs node.
      sandbox: { mode: 'docker', home: '/tmp/casa-falsa', mounts: [], read_only: [nodeRoot], network_hosts: [], workspace_read_only: false },
    });
    writeOrder(dir, o);
    spawnRunner(dir, RUNNER);
    const status = await waitForLaunch(dir, 30_000);
    expect(status.state === 'terminado' && status.result.status, JSON.stringify(readSpool(dir))).toBe('terminado');
    const lines = readSpool(dir)
      .filter((r) => r.stream === 'stdout')
      .map((r) => r.line.trim());
    expect(lines).toEqual(['0', 'no_escribio', 'sin_red']);
    expect(existsSync(outside)).toBe(false);
  });

  it('el proxy deja pasar sólo los hosts permitidos, igual que con bwrap', async () => {
    const js = `const net=require('net');function t(h){return new Promise(r=>{const s=net.connect(18080,'127.0.0.1',()=>s.write('CONNECT '+h+':443 HTTP/1.1\\r\\nHost: '+h+'\\r\\n\\r\\n'));s.once('data',d=>{r(d.toString().split('\\r\\n')[0]);s.destroy()});s.on('error',e=>r('error '+e.message));s.on('close',()=>r('cerrado'))})}(async()=>{console.log(await t('permitido.invalid'));console.log(await t('example.com'))})()`;
    const { dir, order: o } = order({
      argv: [process.execPath, '-e', js],
      sandbox: { mode: 'docker', home: '/tmp/casa-falsa', mounts: [], read_only: [nodeRoot], network_hosts: ['permitido.invalid'], workspace_read_only: false },
    });
    writeOrder(dir, o);
    spawnRunner(dir, RUNNER);
    const status = await waitForLaunch(dir, 30_000);
    expect(status.state === 'terminado' && status.result.status, JSON.stringify(readSpool(dir))).toBe('terminado');
    const spool = readSpool(dir);
    const out = spool.filter((r) => r.stream === 'stdout').map((r) => r.line);
    expect(out).toEqual(['HTTP/1.1 502 Bad Gateway', 'HTTP/1.1 403 Forbidden']);
  });

  it('el workspace de sólo lectura no se puede escribir', async () => {
    const { dir, order: o } = order({
      argv: ['sh', '-c', '(echo x > archivo.txt) 2>/dev/null && echo escribio || echo no_escribio'],
      sandbox: { mode: 'docker', home: '/tmp/casa-falsa', mounts: [], read_only: [], network_hosts: null, workspace_read_only: true },
    });
    writeOrder(dir, o);
    spawnRunner(dir, RUNNER);
    await waitForLaunch(dir, 30_000);
    const lines = readSpool(dir)
      .filter((r) => r.stream === 'stdout')
      .map((r) => r.line.trim());
    expect(lines).toEqual(['no_escribio']);
  });
});
