import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatedAdapter } from '../../src/providers/adapters.js';
import { type ConformanceReport, ConformanceStore, conformanceProblems, mcpGaps, runConformance, SIMULATED_CONFORMANCE, uncertifiedModels } from '../../src/providers/conformance.js';
import { ensureBuilt, HAS_BWRAP, ROOT, RUNNER } from '../helpers/engine.js';

let dir: string;
beforeAll(() => {
  ensureBuilt();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'forja-confm-')));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sim = () => new SimulatedAdapter({ agentDir: join(ROOT, 'dist/providers') });
const GOOD = SIMULATED_CONFORMANCE;

describe.skipIf(!HAS_BWRAP)('matriz de conformidad (V2-040)', () => {
  it('un proveedor que cumple todo queda aprobado; lo no informado queda como desconocido, no como aprobado', async () => {
    const r = await runConformance({ adapter: sim(), model: 'sim', cliVersion: 'forja-0', dir: join(dir, 'ok'), runnerScript: RUNNER, simulation: GOOD, timeoutMs: 30_000 });
    expect(r.passed, JSON.stringify(r.checks)).toBe(true);
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c.estado]));
    expect(by).toMatchObject({ edicion: 'ok', sesion: 'ok', esquema: 'ok', aislamiento: 'ok', aislamiento_sandbox: 'ok', red: 'ok', mcp: 'ok' });
    expect(['ok', 'desconocido']).toContain(by.uso);
  }, 120_000);

  it('si el modelo se niega a intentar salir, la prueba del modelo queda «desconocido» y decide la del sandbox', async () => {
    const refuses = { ...GOOD, aislamiento: { pasos: [], resultado: 'No voy a leer archivos fuera de mi directorio.' } };
    const r = await runConformance({ adapter: sim(), model: 'sim', cliVersion: 'forja-0', dir: join(dir, 'niega'), runnerScript: RUNNER, simulation: refuses, timeoutMs: 30_000 });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(by.aislamiento).toMatchObject({ estado: 'desconocido', detalle: expect.stringContaining('se negó a intentarlo') });
    expect(by.aislamiento_sandbox!.estado).toBe('ok');
    expect(r.passed).toBe(true);
  }, 120_000);

  it('la prueba MCP es una capacidad aparte: si falla, el modelo sigue aprobado para trabajar sin conexiones (MEJORAS 4.1)', async () => {
    const noMcp = { ...GOOD, mcp: { pasos: [], resultado: 'No tengo herramientas MCP.' } };
    const r = await runConformance({ adapter: sim(), model: 'sim', cliVersion: 'forja-0', dir: join(dir, 'sin-mcp'), runnerScript: RUNNER, simulation: noMcp, timeoutMs: 30_000 });
    const mcp = r.checks.find((c) => c.id === 'mcp')!;
    expect(mcp).toMatchObject({ estado: 'fallo', detalle: expect.stringContaining('no llegó al gateway') });
    expect(r.passed).toBe(true);
    const store = new ConformanceStore(join(dir, 'mcp.json'));
    store.record({ ...r, provider: 'claude', model: 'haiku', cli_version: '2.0' });
    expect(await mcpGaps(store, ['claude:haiku', 'simulado:sim'], '0', async (p) => (p === 'claude' ? '2.0' : 'forja-0'))).toEqual(['claude:haiku']);
  }, 120_000);

  it('un proveedor que no hace lo pedido o no respeta el esquema no se aprueba', async () => {
    const bad = { ...GOOD, edicion: { pasos: [{ escribir: { ruta: 'hola.txt', contenido: 'otra cosa' } }], resultado: 'LISTO' }, esquema: { pasos: [], resultado: 'no es json' } };
    const r = await runConformance({ adapter: sim(), model: 'sim', cliVersion: 'forja-0', dir: join(dir, 'mal'), runnerScript: RUNNER, simulation: bad, timeoutMs: 30_000 });
    expect(r.passed).toBe(false);
    expect(
      r.checks
        .filter((c) => c.estado === 'fallo')
        .map((c) => c.id)
        .sort(),
    ).toEqual(['edicion', 'esquema']);
  }, 120_000);
});

describe('registro de conformidad', () => {
  const report = (model: string, version: string, passed: boolean): ConformanceReport => ({ provider: 'claude', model, cli_version: version, passed, checks: [], at: '' });

  it('aprueba por versión exacta del CLI; una versión nueva vuelve a exigir prueba', async () => {
    const store = new ConformanceStore(join(dir, 'conf.json'));
    expect(store.status('claude', 'haiku', '2.0.1')).toBe('sin_probar');
    store.record(report('haiku', '2.0.1', false));
    expect(store.status('claude', 'haiku', '2.0.1')).toBe('fallido');
    store.record(report('haiku', '2.0.1', true));
    expect(store.all()).toHaveLength(1);
    expect(store.status('claude', 'haiku', '2.0.1')).toBe('aprobado');
    expect(store.status('claude', 'haiku', '2.1.0')).toBe('version_nueva');

    const versions: Record<string, string | null> = { claude: '2.1.0', codex: null };
    const problems = await conformanceProblems(store, ['claude:haiku', 'claude:haiku', 'codex:gpt-6-luna', 'simulado:sim'], '0', async (p) => versions[p] ?? null);
    // Simulated is exempt; an uninstalled CLI is not blocked here (the engine skips it).
    expect(problems).toEqual(['claude:haiku (2.1.0): versión nueva del CLI sin probar']);
    // forja run uses the structured list to certify exactly those models on the spot (MEJORAS 3.8).
    expect(await uncertifiedModels(store, ['claude:haiku', 'simulado:sim'], '0', async (p) => versions[p] ?? null)).toEqual([{ ref: 'claude:haiku', version: '2.1.0', status: 'version_nueva' }]);
    versions.claude = '2.0.1';
    expect(await conformanceProblems(store, ['claude:haiku'], '0', async (p) => versions[p] ?? null)).toEqual([]);
  });
});
