import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/domain/ids.js';
import { ClaudeAdapter, CodexAdapter, SimulatedAdapter, type ProviderAdapter } from '../../src/providers/adapters.js';
import { runToCompletion } from '../../src/runtime/launch-service.js';

const ROOT = resolve(import.meta.dirname, '../..');
const RUNNER = join(ROOT, 'dist/runtime/runner-main.js');
const SIM = () => new SimulatedAdapter({ agentDir: join(ROOT, 'dist/providers') });
const HAS_BWRAP = spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status === 0;
/** Real providers cost quota: only with FORJA_REAL=1. */
const REAL = process.env.FORJA_REAL === '1';

let base: string;
beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
  base = realpathSync(mkdtempSync(join(tmpdir(), 'forja-conf-')));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function params(model: string, prompt: string, extra: Record<string, unknown> = {}) {
  const ws = join(base, newId('ws'));
  mkdirSync(ws, { recursive: true });
  return {
    ws,
    p: {
      launchId: newId('lan'),
      fencingToken: 1,
      runId: 'run_1',
      taskId: 'T-001',
      attempt: 1,
      model,
      prompt,
      workspace: ws,
      providerStateDir: join(base, 'estado-proveedor', model),
      tools: 'edicion' as const,
      timeoutMs: 180_000,
      ...extra,
    },
  };
}

const EDIT_PROMPT = 'Crea el archivo hola.txt en el directorio actual con exactamente el contenido: hola forja (sin salto de línea extra). Luego responde LISTO.';
const SCHEMA = { type: 'object', properties: { color: { type: 'string' }, numero: { type: 'integer' } }, required: ['color', 'numero'], additionalProperties: false };

type Case = { name: string; adapter: ProviderAdapter; model: string; enabled: boolean };
const CASES: Case[] = [
  { name: 'simulado', adapter: SIM(), model: 'sim', enabled: HAS_BWRAP },
  { name: 'claude', adapter: new ClaudeAdapter(), model: 'haiku', enabled: HAS_BWRAP && REAL },
  { name: 'codex', adapter: new CodexAdapter(), model: 'gpt-6-luna', enabled: HAS_BWRAP && REAL },
];

describe.each(CASES)('conformidad: $name', ({ name, adapter, model, enabled }) => {
  it.skipIf(!enabled)('edita dentro del workspace y termina con resultado', async () => {
    const { ws, p } = params(model, EDIT_PROMPT, {
      simulationScript: { pasos: [{ escribir: { ruta: 'hola.txt', contenido: 'hola forja' } }], resultado: 'LISTO' },
    });
    const out = await runToCompletion(base, adapter, p, { runnerScript: RUNNER });
    expect(out.summary.status, JSON.stringify(out.summary.error)).toBe('completed');
    expect(out.summary.sessionId).toBeTruthy();
    expect(readFileSync(join(ws, 'hola.txt'), 'utf8').trim()).toBe('hola forja');
    expect(out.summary.usage.length).toBeGreaterThan(0);
    if (name !== 'simulado') expect(out.deniedHosts.filter((h) => !h.includes('datadog') && !h.includes('statsig') && !h.includes('chatgpt.com') && !h.includes('oaiusercontent'))).toEqual([]);
  });

  it.skipIf(!enabled)('devuelve salida estructurada según el esquema', async () => {
    const { p } = params(model, 'Elige un color y el número 7.', {
      tools: 'lectura' as const,
      outputSchema: SCHEMA,
      simulationScript: { pasos: [], estructurado: { color: 'azul', numero: 7 } },
    });
    const out = await runToCompletion(base, adapter, p, { runnerScript: RUNNER });
    expect(out.summary.status, JSON.stringify(out.summary.error)).toBe('completed');
    expect(out.summary.structured).toMatchObject({ numero: 7 });
  });
});

describe.skipIf(!HAS_BWRAP)('simulado: errores normalizados', () => {
  it('cuota agotada llega como error de cuota', async () => {
    const { p } = params('sim', 'x', { simulationScript: { pasos: [], error: { status: 429, code: 'credits_required', mensaje: 'sin créditos' } } });
    const out = await runToCompletion(base, SIM(), p, { runnerScript: RUNNER });
    expect(out.summary.error).toMatchObject({ category: 'quota', retryable: true });
  });

  it('el aviso de segundo plano llega al resumen', async () => {
    const { p } = params('sim', 'x', { simulationScript: { pasos: [{ segundo_plano: 'bucle largo' }], resultado: 'ejecutándose' } });
    const out = await runToCompletion(base, SIM(), p, { runnerScript: RUNNER });
    expect(out.summary.warnings[0]).toMatch(/segundo plano/);
  });

  it('respuesta no JSON cuando se pidió esquema es un error de esquema', async () => {
    const { p } = params('sim', 'x', { outputSchema: SCHEMA, simulationScript: { pasos: [], resultado: 'no es json' } });
    const out = await runToCompletion(base, SIM(), p, { runnerScript: RUNNER });
    expect(out.summary.error?.category).toBe('schema');
  });

  it('el agente simulado no puede escribir fuera del workspace', async () => {
    const { p } = params('sim', 'x', { simulationScript: { pasos: [{ escribir: { ruta: '/etc/forja-no', contenido: 'x' } }] } });
    const out = await runToCompletion(base, SIM(), p, { runnerScript: RUNNER });
    expect(existsSync('/etc/forja-no')).toBe(false);
    expect(out.summary.status).not.toBe('completed');
  });
});
