import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarize, type ProviderEvent } from '../../src/providers/normalized.js';
import { simulateProviderOutput, type SimulationFaults } from '../../src/providers/simulated.js';
import { parseProviderStream, type ProviderKind } from '../../src/providers/stream.js';

const FIX = join(import.meta.dirname, '../../m0/fixtures');

async function run(kind: ProviderKind, fixture: string, faults: SimulationFaults = {}) {
  const events: ProviderEvent[] = [];
  for await (const e of parseProviderStream(kind, simulateProviderOutput(join(FIX, fixture), faults))) events.push(e);
  return { events, summary: summarize(events) };
}

describe('Claude (salidas reales de M0)', () => {
  it('trabajador aislado: sesión, modelo efectivo, resultado y costo', async () => {
    const { summary } = await run('claude', 'claude-trabajador-aislado.jsonl');
    expect(summary.status).toBe('completed');
    expect(summary.model).toBe('claude-haiku-4-5-20251001');
    expect(summary.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(summary.text).toBe('NO_DOKO');
    expect(summary.usage[0]?.costEquivalentMicroUsd).toBeGreaterThan(0);
    expect(summary.usage[0]?.semantics).toBe('acumulado_sesion');
  });

  it('salida con esquema: devuelve el objeto estructurado', async () => {
    const { summary } = await run('claude', 'claude-esquema.jsonl');
    expect(summary.structured).toEqual({ color: 'blue', numero: 7 });
  });

  it('429 sin créditos llega como subtype success pero es un error de cuota', async () => {
    const { summary } = await run('claude', 'claude-sin-creditos-429.jsonl');
    expect(summary.status).toBe('failed');
    expect(summary.error).toMatchObject({ category: 'quota', providerCode: 'credits_required', retryable: true });
    expect(summary.model).toBe('claude-fable-5-1');
  });

  it('avisa cuando el agente mandó trabajo a segundo plano (falso éxito de M0)', async () => {
    const { summary } = await run('claude', 'claude-exito-falso-bg.jsonl');
    expect(summary.status).toBe('completed');
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toMatch(/segundo plano/);
  });

  it('un proceso muerto a mitad queda incompleto, nunca completado', async () => {
    const { summary } = await run('claude', 'claude-kill9.jsonl');
    expect(summary.status).toBe('incomplete');
    expect(summary.sessionId).not.toBeNull();
  });

  it('es igual con chunks de 7 bytes (líneas partidas)', async () => {
    const whole = await run('claude', 'claude-esquema.jsonl');
    const split = await run('claude', 'claude-esquema.jsonl', { chunkSize: 7 });
    expect(split.summary).toEqual(whole.summary);
  });

  it('salida cortada en medio de una línea: sin éxito inventado', async () => {
    const { summary } = await run('claude', 'claude-esquema.jsonl', { cutAtByte: 2500 });
    expect(summary.status).toBe('incomplete');
    expect(summary.unknownEvents).toBeGreaterThanOrEqual(1);
  });

  it('sin línea result el lanzamiento queda incompleto', async () => {
    const { summary } = await run('claude', 'claude-esquema.jsonl', { dropTypes: ['result'] });
    expect(summary.status).toBe('incomplete');
  });
});

describe('Codex (salidas reales de M0)', () => {
  it('respuesta simple: hilo, uso por turno, sin modelo informado', async () => {
    const { summary } = await run('codex', 'codex-luna.jsonl');
    expect(summary.status).toBe('completed');
    expect(summary.text).toBe('OK');
    expect(summary.model).toBeNull();
    expect(summary.usage[0]).toMatchObject({ semantics: 'por_turno', costEquivalentMicroUsd: null });
    expect(summary.usage[0]?.inputTokens).toBeGreaterThan(0);
  });

  it('reanudar mantiene el mismo hilo', async () => {
    const { summary } = await run('codex', 'codex-reanudar-tras-kill.jsonl');
    expect(summary.sessionId).toBe('01a0d479-b508-73f1-b453-ea8c011c827e');
    expect(summary.status).toBe('completed');
  });

  it('kill -9 a mitad: incompleto y con el comando observado', async () => {
    const { events, summary } = await run('codex', 'codex-kill9.jsonl');
    expect(summary.status).toBe('incomplete');
    expect(events.some((e) => e.t === 'inicio')).toBe(true);
  });

  it('clasifica turn.failed por cuota', async () => {
    const chunks = (async function* () {
      yield '{"type":"thread.started","thread_id":"t1"}\n';
      yield '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Try again at 8:05 PM."}}\n';
    })();
    const events: ProviderEvent[] = [];
    for await (const e of parseProviderStream('codex', chunks)) events.push(e);
    expect(summarize(events).error?.category).toBe('quota');
  });

  it('eventos desconocidos se cuentan pero no rompen', async () => {
    const chunks = (async function* () {
      yield '{"type":"thread.started","thread_id":"t1"}\n{"type":"algo.nuevo"}\n';
      yield '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n{"type":"turn.completed","usage":{}}\n';
    })();
    const events: ProviderEvent[] = [];
    for await (const e of parseProviderStream('codex', chunks)) events.push(e);
    const summary = summarize(events);
    expect(summary.unknownEvents).toBe(1);
    expect(summary.usage[0]?.inputTokens).toBeNull();
    expect(summary.status).toBe('completed');
  });
});
