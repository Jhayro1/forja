import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineBoardSource, taskLogLines } from '../../src/cli/board-source.js';
import type { Simulation } from '../../src/core/engine.js';
import { agentActivity, launchPrompt, readableLog, readSpoolTail, SpoolFollower } from '../../src/run/activity.js';
import { taskDetailLines } from '../../src/run/describe.js';
import { answerTaskQuestion, Orchestrator, startOrResumeRun } from '../../src/run/orchestrator.js';
import { RunLog } from '../../src/run/run-log.js';
import { currentChange, elapsed, runSnapshot } from '../../src/run/snapshot.js';
import { taskDiff } from '../../src/run/task-diff.js';
import { HAS_BWRAP, testEngine } from '../helpers/engine.js';
import { FILES, seedApprovedPlan } from './fixture.js';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const APPROVE_REVIEW = { pasos: [], estructurado: { criterios: [], hallazgos: [], veredicto: 'aprobado', resumen: 'correcto' } };

describe('vista del run (estado, preguntas y tablero leen lo mismo)', () => {
  it('antes del run muestra el plan aprobado y el siguiente paso', async () => {
    const t = testEngine(() => APPROVE_REVIEW);
    cleanup = t.cleanup;
    const { changeId } = await seedApprovedPlan(t.engine, t.dir);
    const s = runSnapshot(t.engine, currentChange(t.engine)!);
    expect(s.change.change_id).toBe(changeId);
    expect(s.run).toBeNull();
    expect(s.approved).toBe(true);
    expect(s.total).toBe(5);
    expect(s.nextStep).toBe('forja run');
    expect(s.pending).toEqual([]);
  });

  it('pregunta de un agente: aparece como pendiente, con detalle, log e instrucciones; al responder se entrega', async () => {
    let asked = false;
    const simulation: Simulation = ({ role, taskId }) => {
      if (role === 'revisor') return APPROVE_REVIEW;
      if (taskId === 'T-003' && !asked) {
        asked = true;
        return { pasos: [{ escribir: { ruta: 'src/uc-001.mjs', contenido: '// borrador\n' } }], resultado: 'NECESITA_ACLARACION: ¿Se permiten montos con decimales?' };
      }
      return { pasos: Object.entries(FILES[taskId] ?? {}).map(([ruta, contenido]) => ({ escribir: { ruta, contenido } })), resultado: 'Listo.' };
    };
    const t = testEngine(simulation);
    cleanup = t.cleanup;
    const { repo, changeId } = await seedApprovedPlan(t.engine, t.dir);
    const { runId } = await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const log = RunLog.of(t.dir, runId);
    const first = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 100, onLog: (l) => log.append(l) }).loop();
    expect(first.state).toBe('bloqueado');

    const s = runSnapshot(t.engine, currentChange(t.engine)!);
    expect(s.run?.run_id).toBe(runId);
    expect(s.pending).toEqual([{ kind: 'pregunta_tarea', id: 'T-003', text: '¿Se permiten montos con decimales?', action: 'forja responder T-003 "<respuesta>"' }]);
    expect(s.nextStep).toMatch(/forja preguntas/);
    expect(s.counts.esperando_respuesta).toBe(1);
    expect(s.usage.find((u) => u.role === 'trabajador')?.calls).toBeGreaterThanOrEqual(3);
    expect(log.tail(100).some((l) => /\? T-003 pregunta/.test(l))).toBe(true);

    const task = s.tasks.find((x) => x.id === 'T-003')!;
    const detail = taskDetailLines(
      task,
      s.plan!.tareas.find((x) => x.id === 'T-003'),
    );
    expect(detail).toContain('Pregunta del agente:');
    expect(detail.join('\n')).toMatch(/Registrar fiado/);
    expect(taskLogLines(task).join('\n')).toMatch(/⚙ Write src\/uc-001\.mjs/);
    expect(launchPrompt(task.exec.launch_dir)).toMatch(/T-003/);
    expect(agentActivity(task.exec.launch_dir, task.exec.provider).current).toBe('terminó');
    // The worker's draft is visible as a live diff even without a candidate.
    expect(await taskDiff(repo, task.exec)).toMatch(/uc-001\.mjs/);

    // The board answers through the same domain command as the CLI.
    const ctx = { engine: t.engine, dataDir: t.dir, config: t.engine.config, checkout: { path: repo } } as unknown as ConstructorParameters<typeof EngineBoardSource>[0];
    const board = new EngineBoardSource(ctx);
    const snap = board.snapshot()!;
    board.answer(snap.tasks.find((x) => x.id === 'T-003')!, 'Sí, con dos decimales.');
    expect(runSnapshot(t.engine, currentChange(t.engine)!).pending).toEqual([]);
    expect(() => answerTaskQuestion(t.engine, runId, 'T-003', 'otra vez')).toThrow(/no está esperando/);

    await startOrResumeRun(t.engine, { changeId, repoPath: repo });
    const second = await new Orchestrator(t.engine, repo, runId, { sandbox: HAS_BWRAP, pollMs: 100 }).loop();
    expect(second.state).toBe('completado');
    const done = runSnapshot(t.engine, currentChange(t.engine)!);
    expect(done.change.phase).toBe('entregado');
    expect(done.integrated).toBe(5);
    expect(done.deliveryBranch).toBe(`forja/entrega/${changeId}`);
    expect(done.nextStep).toMatch(/forja informe/);
  }, 300_000);
});

describe('lectura de registros', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'forja-act-'));

  it('lee sólo registros completos al cortar el final del spool', () => {
    const d = dir();
    try {
      const rec = (seq: number, line: string) => JSON.stringify({ seq, ts: `2026-09-24T10:00:0${seq}Z`, stream: 'stdout', line });
      const tool = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
      writeFileSync(join(d, 'spool.jsonl'), `${rec(1, tool)}\n${rec(2, 'x'.repeat(300))}\n${rec(3, tool)}\n{"seq":4,"ts":"cortado`);
      expect(readSpoolTail(d).map((r) => r.seq)).toEqual([1, 2, 3]);
      // Small window: the first (cut) record is dropped, never half-parsed.
      expect(readSpoolTail(d, 300).map((r) => r.seq)).toEqual([3]);
      const act = agentActivity(d, 'claude');
      expect(act.current).toBe('Bash npm test');
      expect(act.startedAt).toBe('2026-09-24T10:00:01Z');
      expect(readableLog(readSpoolTail(d), 'claude').map((l) => l.text)).toEqual(['⚙ Bash npm test', '⚙ Bash npm test']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('el seguidor lee sólo lo nuevo, completa líneas cortadas y distingue tokens medidos de estimados', () => {
    const d = dir();
    try {
      const rec = (seq: number, line: string) => `${JSON.stringify({ seq, ts: `2026-09-24T10:00:0${seq}Z`, stream: 'stdout', line })}\n`;
      const text = (t: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
      const spool = join(d, 'spool.jsonl');
      const first = rec(1, text('x'.repeat(400)));
      writeFileSync(spool, first.slice(0, 50));
      const f = new SpoolFollower(d, 'claude');
      expect(f.poll()).toMatchObject({ current: null, tokens: null, tokensKind: 'desconocido' });
      appendFileSync(spool, first.slice(50));
      expect(f.poll()).toMatchObject({ tokens: 100, tokensKind: 'estimado', startedAt: '2026-09-24T10:00:01Z' });
      appendFileSync(spool, rec(2, JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1200, output_tokens: 34 } })));
      expect(f.poll()).toMatchObject({ current: 'terminó', tokens: 1234, tokensKind: 'medido', lastAt: '2026-09-24T10:00:02Z' });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('el registro del run rota por tamaño, conserva N generaciones y la cola sigue en la anterior', () => {
    const d = dir();
    try {
      const log = RunLog.of(d, 'run_r', { maxBytes: 200, keep: 2 });
      for (let i = 0; i < 40; i++) log.append(`línea ${String(i).padStart(2, '0')} ${'x'.repeat(20)}`, new Date('2026-09-24T12:00:00Z'));
      expect(existsSync(log.generation(1))).toBe(true);
      expect(existsSync(log.generation(2))).toBe(true);
      expect(existsSync(log.generation(3))).toBe(false);
      expect(statSync(log.path).size).toBeLessThanOrEqual(200);
      const tail = log.tail(8);
      expect(tail).toHaveLength(8);
      expect(tail.at(-1)).toContain('línea 39');
      expect(tail[0]).toContain('línea 32');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('el registro del run conserva las últimas líneas en una sola línea cada una', () => {
    const d = dir();
    try {
      const log = RunLog.of(d, 'run_x');
      expect(log.tail(5)).toEqual([]);
      for (let i = 0; i < 10; i++) log.append(`línea ${i}\ncon salto`, new Date('2026-09-24T12:34:56Z'));
      expect(log.tail(2)).toEqual(['12:34:56 línea 8 con salto', '12:34:56 línea 9 con salto']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('formatea tiempos transcurridos', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(elapsed(null, now)).toBe('—');
    expect(elapsed('2026-09-24T11:59:15Z', now)).toBe('45s');
    expect(elapsed('2026-09-24T11:57:46Z', now)).toBe('2m14s');
    expect(elapsed('2026-09-24T10:30:00Z', now)).toBe('1h30m');
  });
});
