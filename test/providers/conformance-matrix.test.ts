import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatedAdapter } from '../../src/providers/adapters.js';
import { ConformanceStore, SIMULATED_CONFORMANCE, conformanceProblems, runConformance, type ConformanceReport } from '../../src/providers/conformance.js';
import { HAS_BWRAP, ROOT, RUNNER, ensureBuilt } from '../helpers/engine.js';

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
    expect(by).toMatchObject({ edicion: 'ok', sesion: 'ok', esquema: 'ok', aislamiento: 'ok', red: 'ok' });
    expect(['ok', 'desconocido']).toContain(by.uso);
  }, 120_000);

  it('un proveedor que no hace lo pedido o no respeta el esquema no se aprueba', async () => {
    const bad = { ...GOOD, edicion: { pasos: [{ escribir: { ruta: 'hola.txt', contenido: 'otra cosa' } }], resultado: 'LISTO' }, esquema: { pasos: [], resultado: 'no es json' } };
    const r = await runConformance({ adapter: sim(), model: 'sim', cliVersion: 'forja-0', dir: join(dir, 'mal'), runnerScript: RUNNER, simulation: bad, timeoutMs: 30_000 });
    expect(r.passed).toBe(false);
    expect(r.checks.filter((c) => c.estado === 'fallo').map((c) => c.id).sort()).toEqual(['edicion', 'esquema']);
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
    versions.claude = '2.0.1';
    expect(await conformanceProblems(store, ['claude:haiku'], '0', async (p) => versions[p] ?? null)).toEqual([]);
  });
});
