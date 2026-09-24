import { describe, expect, it } from 'vitest';
import { type BatchOutcome, integrateBisecting } from '../../src/run/pipeline/batching.js';

/** A fake integration: a batch passes unless it contains a culprit; `serie` for listed batches. */
function world(culprits: string[], serial: string[][] = []) {
  const calls: string[] = [];
  const integrated: string[] = [];
  const blocked: string[] = [];
  const tryBatch = async (ids: string[]): Promise<BatchOutcome> => {
    calls.push(ids.join('+'));
    if (serial.some((s) => s.join('+') === ids.join('+'))) return 'serie';
    if (ids.some((id) => culprits.includes(id))) return 'fallo';
    integrated.push(...ids);
    return 'integrado';
  };
  const one = async (id: string) => {
    calls.push(id);
    (culprits.includes(id) ? blocked : integrated).push(id);
  };
  return { calls, integrated, blocked, run: (ids: string[]) => integrateBisecting(ids, tryBatch, one) };
}

describe('integración por lotes con bisección', () => {
  it('sin fallos: una sola verificación para todo el lote', async () => {
    const w = world([]);
    await w.run(['T-001', 'T-002', 'T-003', 'T-004']);
    expect(w.calls).toEqual(['T-001+T-002+T-003+T-004']);
    expect(w.integrated).toEqual(['T-001', 'T-002', 'T-003', 'T-004']);
  });

  it('con un culpable: divide hasta aislarlo; el resto se integra en lotes', async () => {
    const w = world(['T-003']);
    await w.run(['T-001', 'T-002', 'T-003', 'T-004']);
    expect(w.calls).toEqual(['T-001+T-002+T-003+T-004', 'T-001+T-002', 'T-003+T-004', 'T-003', 'T-004']);
    expect(w.integrated).toEqual(['T-001', 'T-002', 'T-004']);
    expect(w.blocked).toEqual(['T-003']);
  });

  it('un lote que no se puede probar junto (conflicto, ref movida) pasa a serie', async () => {
    const w = world([], [['T-001', 'T-002']]);
    await w.run(['T-001', 'T-002']);
    expect(w.calls).toEqual(['T-001+T-002', 'T-001', 'T-002']);
    expect(w.integrated).toEqual(['T-001', 'T-002']);
  });

  it('una sola tarea va directo por el camino en serie', async () => {
    const w = world([]);
    await w.run(['T-009']);
    expect(w.calls).toEqual(['T-009']);
    await w.run([]);
    expect(w.calls).toEqual(['T-009']);
  });
});
