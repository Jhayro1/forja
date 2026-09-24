import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionStore } from '../../src/actions/connections.js';
import { ActionService } from '../../src/actions/protocol.js';
import { ExternalMcp, outputValidator } from '../../src/mcp/external.js';
import { GatewayHost, gatewayHandler } from '../../src/mcp/gateway.js';
import { McpRegistry, mcpLinkName } from '../../src/mcp/registry.js';
import { ClaudeAdapter, CodexAdapter, MCP_SOCKET_IN_SANDBOX } from '../../src/providers/adapters.js';
import { Orchestrator, startOrResumeRun } from '../../src/run/orchestrator.js';
import { EventStore } from '../../src/store/event-store.js';
import { HAS_BWRAP, ROOT, testEngine } from '../helpers/engine.js';
import { FILES, seedApprovedPlan } from '../run/fixture.js';

const FAKE = join(ROOT, 'test/mcp/fake-server.mjs');
let dir: string;
let closers: (() => void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-mcp-'));
});
afterEach(() => {
  for (const c of closers.reverse()) c();
  closers = [];
  rmSync(dir, { recursive: true, force: true });
});

function services(store: EventStore) {
  const conns = ConnectionStore.in(dir);
  conns.save({
    name: 'pedidos',
    type: 'http',
    base_url: 'https://api.example.com/',
    secret: 'TOKEN',
    auth_header: 'Authorization',
    auth_scheme: 'Bearer',
    idempotent: true,
    allow_local: false,
    test_path: null,
  });
  const actions = new ActionService(store, conns);
  actions.link('pedidos', ['http.json']);
  return actions;
}

describe('registro de servidores MCP', () => {
  it('sólo acepta ejecutables instalados con ruta absoluta; nunca instaladores automáticos', () => {
    const reg = McpRegistry.in(dir);
    const base = { name: 'falso', args: [], declared_version: '1.0.0', tools: ['buscar'], secrets: {} };
    expect(() => reg.save({ ...base, command: 'fake-server.mjs' })).toThrow(/ruta absoluta/);
    expect(() => reg.save({ ...base, command: '/usr/bin/npx', args: ['-y', 'algo'] })).toThrow(/instaladores automáticos/);
    expect(() => reg.save({ ...base, command: '/usr/bin/node', args: ['--yes'] })).toThrow(/instaladores automáticos/);
    expect(() => reg.save({ ...base, command: join(dir, 'no-existe') })).toThrow(/no existe/);
    expect(reg.save({ ...base, command: FAKE }).version).toBe(1);
    expect(reg.save({ ...base, command: FAKE, tools: ['buscar', 'grande'] }).version).toBe(2);
  });
});

describe('servidor MCP externo a través del gateway', () => {
  it('expone sólo herramientas autorizadas, sin HOME del usuario, con secretos redactados y respuestas acotadas', async () => {
    const def = McpRegistry.in(dir).save({ name: 'falso', command: FAKE, args: [], declared_version: '1.0.0', tools: ['buscar', 'grande', 'no_existe'], secrets: { SECRET_TOKEN: 'X' } });
    const ext = await ExternalMcp.start({ ...def, max_response_bytes: 1000 }, { SECRET_TOKEN: 'tok-del-mcp-123' });
    closers.push(() => ext.close());
    expect(ext.tools.map((t) => t.name)).toEqual(['buscar', 'grande']);
    const r = await ext.call('buscar', { q: 'arroz' });
    expect(r.content[0]!.text).toContain('resultado de arroz');
    expect(r.content[0]!.text).not.toContain('tok-del-mcp-123');
    expect(r.content[0]!.text).toContain('home=sin HOME');
    const big = await ext.call('grande', {});
    expect(big.content[0]!.text).toMatch(/recortada a 1000 bytes/);
    expect(big.content[0]!.text.length).toBeLessThan(1200);
    expect((await ext.call('borrar_todo', {})).isError).toBe(true);
  });

  it('valida la salida estructurada contra el outputSchema declarado (MEJORAS 4.10)', async () => {
    const def = McpRegistry.in(dir).save({ name: 'falso', command: FAKE, args: [], declared_version: '1.0.0', tools: ['precio'], secrets: { SECRET_TOKEN: 'X' } });
    const ext = await ExternalMcp.start(def, { SECRET_TOKEN: 'tok-precio-456' });
    closers.push(() => ext.close());
    const ok = await ext.call('precio', { q: 'ok' });
    expect(ok.isError).toBeUndefined();
    // Validated and redacted before reaching the agent.
    expect(ok.structuredContent).toEqual({ monto: 5, moneda: '«secreto:SECRET_TOKEN»' });
    const bad = await ext.call('precio', { q: 'mal' });
    expect(bad).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('no cumple su outputSchema: monto') }] });
    expect(bad.structuredContent).toBeUndefined();
    expect((await ext.call('precio', { q: 'nada' })).content[0]!.text).toMatch(/no devolvió structuredContent/);
    expect(outputValidator({ type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] })({ a: 1 })).toEqual({ ok: true });
    expect(outputValidator(undefined)(undefined)).toEqual({ ok: true });
  });

  it('el gateway ofrece sus herramientas y las externas con prefijo; proponer nunca ejecuta', async () => {
    const store = EventStore.open(join(dir, 'e.db'), 'chk');
    closers.push(() => store.close());
    const actions = services(store);
    const def = McpRegistry.in(dir).save({ name: 'falso', command: FAKE, args: [], declared_version: '1.0.0', tools: ['buscar'], secrets: {} });
    const ext = await ExternalMcp.start(def, {});
    closers.push(() => ext.close());
    const call = gatewayHandler({ origin: 'agente T-001 · run_1', actions, externals: [ext] });
    const init = (await call('initialize', {})) as { serverInfo: { name: string } };
    expect(init.serverInfo.name).toBe('forja');
    const list = (await call('tools/list', {})) as { tools: { name: string }[] };
    expect(list.tools.map((t) => t.name)).toEqual(['listar_conexiones', 'proponer_accion', 'estado_accion', 'falso__buscar']);

    const tool = async (name: string, args: unknown) => (await call('tools/call', { name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    expect(JSON.parse((await tool('listar_conexiones', {})).content[0]!.text)).toEqual([{ conexion: 'pedidos', operaciones: ['http.json'] }]);
    const proposed = JSON.parse(
      (await tool('proponer_accion', { conexion: 'pedidos', operacion: 'http.json', parametros: { ruta: '/pedidos', cuerpo: { a: 1 } }, motivo: 'la tarea crea el pedido' })).content[0]!.text,
    );
    expect(proposed.estado).toBe('pendiente de aprobación humana');
    const action = actions.get(proposed.id);
    expect(action).toMatchObject({ state: 'propuesta', origin: 'agente T-001 · run_1 · la tarea crea el pedido' });
    expect(JSON.stringify(proposed)).not.toMatch(/Bearer [^<]/);
    expect(JSON.parse((await tool('estado_accion', { id: proposed.id })).content[0]!.text).estado).toBe('propuesta');

    // Another agent cannot read it; invalid proposals and unknown tools are errors, not crashes.
    const other = gatewayHandler({ origin: 'agente T-002 · run_1', actions, externals: [] });
    expect(((await other('tools/call', { name: 'estado_accion', arguments: { id: proposed.id } })) as { isError?: boolean }).isError).toBe(true);
    expect((await tool('proponer_accion', { conexion: 'otra', operacion: 'http.json', parametros: { ruta: '/x' }, motivo: 'x' })).isError).toBe(true);
    expect((await tool('borrar_todo', {})).isError).toBe(true);
    expect((await tool('falso__borrar_todo', {})).isError).toBe(true);
    expect((await tool('falso__buscar', { q: 'z' })).content[0]!.text).toContain('resultado de z');
    expect((await tool('proponer_accion', { conexion: 'pedidos', operacion: 'http.json', parametros: { ruta: 'x'.repeat(70_000) }, motivo: '' })).content[0]!.text).toMatch(/demasiado grandes/);
    await expect(call('recursos/secretos', {})).rejects.toThrow(/no soportado/);
  });
});

describe('adaptadores con gateway', () => {
  it('Claude y Codex reciben sólo el servidor «forja» y el socket montado; sin gateway, ninguno', () => {
    const claudeHome = join(dir, 'claude');
    const codexHome = join(dir, 'codex');
    mkdirSync(claudeHome);
    mkdirSync(codexHome);
    writeFileSync(join(claudeHome, '.credentials.json'), '{}');
    writeFileSync(join(codexHome, 'auth.json'), '{}');
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    process.env.CODEX_HOME = codexHome;
    try {
      const params = (mcpSocket?: string) => ({
        launchId: 'lan_1',
        fencingToken: 1,
        runId: 'run_1',
        taskId: 'T-001',
        attempt: 1,
        model: 'm',
        prompt: 'p',
        workspace: dir,
        providerStateDir: join(dir, 'estado'),
        inputsDir: join(dir, 'in'),
        tools: 'edicion' as const,
        timeoutMs: 1000,
        ...(mcpSocket ? { mcpSocket } : {}),
      });
      const claude = new ClaudeAdapter('/usr/bin/true');
      const withGw = claude.buildOrder(params('/tmp/fmcp-x/a1/p.sock'));
      const cfg = JSON.parse(withGw.argv[withGw.argv.indexOf('--mcp-config') + 1]!);
      expect(Object.keys(cfg.mcpServers)).toEqual(['forja']);
      expect(cfg.mcpServers.forja.args).toContain(MCP_SOCKET_IN_SANDBOX);
      expect(withGw.argv[withGw.argv.indexOf('--allowedTools') + 1]).toMatch(/mcp__forja$/);
      // The socket's folder is mounted, so a gateway recreated at the same path stays visible (MEJORAS 4.7).
      expect(withGw.sandbox.mode === 'bwrap' && withGw.sandbox.mounts.some((m) => m.src === '/tmp/fmcp-x/a1' && `${m.dest}/p.sock` === MCP_SOCKET_IN_SANDBOX)).toBe(true);
      expect(() => claude.buildOrder(params('/tmp/fmcp-x/otro.sock'))).toThrow(/debe llamarse p.sock/);
      const without = claude.buildOrder(params());
      expect(JSON.parse(without.argv[without.argv.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: {} });
      expect(without.argv.join(' ')).not.toContain('mcp__forja');

      const codex = new CodexAdapter('/usr/bin/true').buildOrder(params('/tmp/fmcp-x/a2/p.sock'));
      expect(codex.argv.join(' ')).toMatch(/mcp_servers\.forja\.command=/);
      expect(new CodexAdapter('/usr/bin/true').buildOrder(params()).argv.join(' ')).not.toContain('mcp_servers');
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CODEX_HOME;
    }
  });
});

describe.skipIf(!HAS_BWRAP)('de punta a punta: un agente en el sandbox propone por MCP', () => {
  it('la propuesta queda con el origen del lanzamiento y pendiente; el agente no tuvo secretos', async () => {
    const t = testEngine(({ role, taskId }) => {
      if (role === 'revisor') return { pasos: [], estructurado: { criterios: [], hallazgos: [], veredicto: 'aprobado', resumen: 'ok' } };
      const files = Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } }));
      const mcp =
        taskId === 'T-001'
          ? [{ mcp: { herramienta: 'proponer_accion', argumentos: { conexion: 'pedidos', operacion: 'http.json', parametros: { ruta: '/avisos', cuerpo: { texto: 'listo' } }, motivo: 'avisar' } } }]
          : [];
      return { pasos: [...mcp, ...files], resultado: 'Listo.' };
    });
    closers.push(t.cleanup);
    const actions = services(t.engine.store);
    const gateway = new GatewayHost(actions);
    closers.push(() => gateway.close());
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const summary = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 100, gateway }).loop();
    expect(summary.state).toBe('completado');
    const [a] = actions.list();
    expect(a).toMatchObject({ state: 'propuesta', type: 'http.json', connection: 'pedidos' });
    expect(a!.origin).toBe(`agente T-001 · ${runId} · avisar`);
    expect(a!.preview.peticion).toBe('POST https://api.example.com/avisos');
    expect(mcpLinkName('x')).toBe('mcp:x');
  }, 300_000);
});

describe('el agente conserva el gateway si forja run se reinicia (MEJORAS 4.7)', () => {
  it('el socket se recrea en la misma ruta y el puente responde error a lo que quedó en vuelo y se reconecta', async () => {
    const { spawn } = await import('node:child_process');
    const store = EventStore.open(join(mkdtempSync(join(tmpdir(), 'forja-gw7-')), 'estado.db'), 'chk');
    closers.push(() => store.close());
    const actions = services(store);
    const base = join(tmpdir(), `fmcp-t${Date.now().toString(36)}`);
    const first = new GatewayHost(actions, [], base);
    const path = await first.socketFor('agente T-001 · run_x', 'lan_abc');
    expect(path).toBe(await first.socketFor('agente T-001 · run_x', 'lan_abc'));
    expect(path.endsWith('/p.sock')).toBe(true);
    const bridge = spawn(process.execPath, [join(ROOT, 'dist/mcp/bridge-main.js'), path], { stdio: ['pipe', 'pipe', 'pipe'] });
    closers.push(() => bridge.kill());
    const lines: Record<string, unknown>[] = [];
    let buf = '';
    bridge.stdout.on('data', (c) => {
      buf += String(c);
      let i = buf.indexOf('\n');
      while (i >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
        buf = buf.slice(i + 1);
        i = buf.indexOf('\n');
      }
    });
    const ask = (id: number) => bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`);
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 50));
    };
    ask(1);
    await until(() => lines.some((l) => l.id === 1));
    expect((lines.find((l) => l.id === 1)!.result as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
    // forja run stops: the old process closes its gateway.
    first.close();
    await new Promise((r) => setTimeout(r, 300));
    ask(2);
    // A new forja run recreates the socket for the running agent at the same path.
    const second = new GatewayHost(actions, [], base);
    closers.push(() => second.close());
    expect(await second.socketFor('agente T-001 · run_x', 'lan_abc')).toBe(path);
    await until(() => lines.some((l) => l.id === 2));
    ask(3);
    await until(() => lines.some((l) => l.id === 3));
    const byId = (id: number) => lines.find((l) => l.id === id)!;
    // The request sent while the gateway was down is delivered after reconnecting (or answered with an error): never lost.
    expect(byId(2).result ?? byId(2).error).toBeTruthy();
    expect((byId(3).result as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
  }, 30_000);
});
