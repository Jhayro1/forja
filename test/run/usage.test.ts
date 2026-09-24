import { afterEach, describe, expect, it } from 'vitest';
import { costLabel, usageByRole } from '../../src/run/snapshot.js';
import { EV } from '../../src/store/planning-projections.js';
import { testEngine } from '../helpers/engine.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('costo medido, estimado o desconocido (MEJORAS 2.10)', () => {
  it('usa el costo del proveedor si lo informa y estima con precios.yaml si no', () => {
    const t = testEngine(() => ({}));
    cleanup = t.cleanup;
    t.engine.prices = { 'codex:gpt': { entrada: 2, salida: 8 } };
    const usage = (id: string, role: string, provider: string, model: string, input: number | null, output: number | null, cost: number | null) =>
      t.engine.store.execute({ request_id: id, type: 'uso', input: null }, () => ({
        result: null,
        events: [
          {
            type: EV.usage,
            aggregate_type: 'tarea',
            aggregate_id: 'run_1/T-001',
            run_id: 'run_1',
            task_id: 'T-001',
            launch_id: id,
            payload: { launch_id: id, role, provider, model, input, output, cache_read: null, cache_write: null, cost_micro: cost },
          },
        ],
      }));
    usage('a', 'trabajador', 'claude', 'haiku', 1000, 100, 5000);
    usage('b', 'revisor', 'codex', 'gpt', 1000, 100, null);
    usage('c', 'complejo', 'codex', 'otro', 1000, 100, null);
    usage('d', 'planeador', 'claude', 'opus', 10, 10, 100);
    usage('e', 'planeador', 'codex', 'gpt', 10, 10, null);
    const by = Object.fromEntries(usageByRole(t.engine, 'run_1').map((u) => [u.role, u]));
    expect(by.trabajador).toMatchObject({ costMicro: 5000, costKind: 'medido', tokens: 1100 });
    expect(by.revisor).toMatchObject({ costMicro: 2800, costKind: 'estimado' });
    expect(by.complejo).toMatchObject({ costMicro: null, costKind: 'desconocido' });
    expect(by.planeador).toMatchObject({ costMicro: 200, costKind: 'mixto', calls: 2 });
    expect(costLabel(by.revisor!)).toBe('≈US$ 0.00 (estimado)');
    expect(costLabel({ costMicro: 1_250_000, costKind: 'medido' })).toBe('US$ 1.25');
    expect(costLabel(by.complejo!)).toBe('');
  });
});
