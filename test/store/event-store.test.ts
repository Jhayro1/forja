import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeTaskState, createTask, DomainError, tasksReadyToUnblock } from '../../src/core/task-commands.js';
import { CommandConflictError, EventStore } from '../../src/store/event-store.js';
import { listTasks } from '../../src/store/projections.js';
import { openDatabase } from '../../src/store/sqlite.js';

const RUN = 'run_1';
let dir: string;
let store: EventStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-store-'));
  clock = Date.parse('2026-09-24T12:00:00Z');
  store = EventStore.open(join(dir, 'estado.db'), 'chk_1', () => new Date(clock));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function walkToIntegrated(taskId: string, prefix: string) {
  const path = [
    ['reservada', 'reservada'],
    ['ejecutando', 'lanzamiento_iniciado'],
    ['verificando', 'proceso_terminado'],
    ['verificada', 'verificacion_aprobada'],
    ['integrando', 'integracion_iniciada'],
    ['integrada', 'integracion_confirmada'],
  ] as const;
  path.forEach(([to, reason], i) => changeTaskState(store, `${prefix}-${i}`, { run_id: RUN, task_id: taskId, to, reason }));
}

describe('almacén de eventos', () => {
  it('crea tareas: sin dependencias nacen listas, con dependencias pendientes', () => {
    createTask(store, 'r1', { run_id: RUN, task_id: 'T-001', title: 'Contratos' });
    createTask(store, 'r2', { run_id: RUN, task_id: 'T-002', title: 'API', depends_on: ['T-001'] });
    expect(listTasks(store.db, RUN).map((t) => [t.task_id, t.state])).toEqual([
      ['T-001', 'lista'],
      ['T-002', 'pendiente'],
    ]);
  });

  it('una dependencia desbloquea sólo al integrarse (I04)', () => {
    createTask(store, 'r1', { run_id: RUN, task_id: 'T-001', title: 'Contratos' });
    createTask(store, 'r2', { run_id: RUN, task_id: 'T-002', title: 'API', depends_on: ['T-001'] });
    changeTaskState(store, 'a', { run_id: RUN, task_id: 'T-001', to: 'reservada', reason: 'reservada' });
    changeTaskState(store, 'b', { run_id: RUN, task_id: 'T-001', to: 'ejecutando', reason: 'lanzamiento_iniciado' });
    changeTaskState(store, 'c', { run_id: RUN, task_id: 'T-001', to: 'verificando', reason: 'proceso_terminado' });
    changeTaskState(store, 'd', { run_id: RUN, task_id: 'T-001', to: 'verificada', reason: 'verificacion_aprobada' });
    expect(tasksReadyToUnblock(store, RUN)).toEqual([]);
    expect(() => changeTaskState(store, 'e', { run_id: RUN, task_id: 'T-002', to: 'lista', reason: 'dependencias_integradas' })).toThrow(/sin integrar: T-001/);
    changeTaskState(store, 'f', { run_id: RUN, task_id: 'T-001', to: 'integrando', reason: 'integracion_iniciada' });
    changeTaskState(store, 'g', { run_id: RUN, task_id: 'T-001', to: 'integrada', reason: 'integracion_confirmada' });
    expect(tasksReadyToUnblock(store, RUN)).toEqual(['T-002']);
  });

  it('una solicitud repetida no duplica eventos ni efectos', () => {
    createTask(store, 'r1', { run_id: RUN, task_id: 'T-001', title: 'Contratos' });
    const first = changeTaskState(store, 'reservar', { run_id: RUN, task_id: 'T-001', to: 'reservada', reason: 'reservada' }, [{ kind: 'lanzar', payload: { task_id: 'T-001' } }]);
    const again = changeTaskState(store, 'reservar', { run_id: RUN, task_id: 'T-001', to: 'reservada', reason: 'reservada' }, [{ kind: 'lanzar', payload: { task_id: 'T-001' } }]);
    expect(again.duplicated).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(again.events.map((e) => e.seq)).toEqual(first.events.map((e) => e.seq));
    expect(store.events()).toHaveLength(2);
    expect(store.claimOutbox(30_000)).toHaveLength(1);
  });

  it('rechaza reusar un request_id con otro contenido', () => {
    createTask(store, 'r1', { run_id: RUN, task_id: 'T-001', title: 'Contratos' });
    expect(() => createTask(store, 'r1', { run_id: RUN, task_id: 'T-009', title: 'Otra' })).toThrow(CommandConflictError);
  });

  it('un comando inválido no deja rastro (rollback completo)', () => {
    createTask(store, 'r1', { run_id: RUN, task_id: 'T-001', title: 'Contratos' });
    expect(() => changeTaskState(store, 'mal', { run_id: RUN, task_id: 'T-001', to: 'integrada', reason: 'integracion_confirmada' })).toThrow(DomainError);
    expect(store.events()).toHaveLength(1);
    // The failed request_id was not recorded, so a corrected retry with a new id works.
    changeTaskState(store, 'bien', { run_id: RUN, task_id: 'T-001', to: 'reservada', reason: 'reservada' });
    expect(store.events()).toHaveLength(2);
  });

  it('reconstruir proyecciones desde los eventos da el mismo estado', () => {
    createTask(store, 'r1', { run_id: RUN, task_id: 'T-001', title: 'Contratos' });
    createTask(store, 'r2', { run_id: RUN, task_id: 'T-002', title: 'API', depends_on: ['T-001'] });
    createTask(store, 'r3', { run_id: RUN, task_id: 'T-003', title: 'UI', depends_on: ['T-001'] });
    walkToIntegrated('T-001', 't1');
    changeTaskState(store, 'u2', { run_id: RUN, task_id: 'T-002', to: 'lista', reason: 'dependencias_integradas' });
    changeTaskState(store, 'c3', { run_id: RUN, task_id: 'T-003', to: 'cancelada', reason: 'cancelacion' });
    const before = listTasks(store.db, RUN);
    store.rebuildProjections();
    expect(listTasks(store.db, RUN)).toEqual(before);
  });

  it('los eventos son inmutables', () => {
    createTask(store, 'r1', { run_id: RUN, task_id: 'T-001', title: 'Contratos' });
    expect(() => store.db.exec("UPDATE events SET type = 'x'")).toThrow(/inmutables/);
    expect(() => store.db.exec('DELETE FROM events')).toThrow(/inmutables/);
  });

  it('el estado sobrevive a cerrar y reabrir', () => {
    createTask(store, 'r1', { run_id: RUN, task_id: 'T-001', title: 'Contratos' });
    store.close();
    store = EventStore.open(join(dir, 'estado.db'), 'chk_1');
    expect(listTasks(store.db, RUN)).toHaveLength(1);
    expect(createTask(store, 'r1', { run_id: RUN, task_id: 'T-001', title: 'Contratos' }).duplicated).toBe(true);
  });

  it('rechaza una base de una versión más nueva de Forja', () => {
    store.db.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    store.close();
    expect(() => EventStore.open(join(dir, 'estado.db'), 'chk_1')).toThrow(/versión más nueva/);
    store = EventStore.open(join(dir, 'otra.db'), 'chk_1');
  });

  it('outbox: una orden tomada vuelve a estar disponible si vence su lease', () => {
    createTask(store, 'r1', { run_id: RUN, task_id: 'T-001', title: 'Contratos' });
    changeTaskState(store, 'r2', { run_id: RUN, task_id: 'T-001', to: 'reservada', reason: 'reservada' }, [{ kind: 'lanzar', payload: { task_id: 'T-001' } }]);
    const [order] = store.claimOutbox(10_000);
    expect(order?.attempts).toBe(1);
    expect(store.claimOutbox(10_000)).toHaveLength(0);
    clock += 11_000;
    const [retaken] = store.claimOutbox(10_000);
    expect(retaken?.id).toBe(order?.id);
    expect(retaken?.attempts).toBe(2);
    store.completeOutbox(retaken!.id);
    clock += 60_000;
    expect(store.claimOutbox(10_000)).toHaveLength(0);
  });

  it('usa WAL y sincronización FULL', () => {
    const db = openDatabase(join(dir, 'pragma.db'));
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    db.close();
  });
});
