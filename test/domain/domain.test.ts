import { describe, expect, it } from 'vitest';
import { canonicalJson, hashJson } from '../../src/domain/hash.js';
import { isId, newId } from '../../src/domain/ids.js';
import { checkTransition } from '../../src/domain/task-state.js';
import { Approval, checkApproval, type ApprovalTarget } from '../../src/domain/approval.js';
import { countsAsQualityFailure } from '../../src/domain/errors.js';

describe('ids', () => {
  it('genera ids con prefijo, ordenables por tiempo', () => {
    const a = newId('run', 1_000);
    const b = newId('run', 2_000);
    expect(isId(a, 'run')).toBe(true);
    expect(isId(a, 'task')).toBe(false);
    expect(a.slice(0, 14) < b.slice(0, 14)).toBe(true);
  });

  it('rechaza prefijos inválidos', () => {
    expect(() => newId('Run')).toThrow();
  });
});

describe('hash canónico', () => {
  it('no depende del orden de las claves', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
  });

  it('declara algoritmo y versión de canonicalización', () => {
    expect(hashJson({})).toMatch(/^sha256:canon-v1:[0-9a-f]{64}$/);
  });

  it('rechaza valores que JSON no representa fielmente', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/no representable/);
    expect(() => canonicalJson({ a: new Date() })).toThrow(/no plano/);
  });
});

describe('transiciones de tarea', () => {
  it('permite el camino feliz completo', () => {
    const steps = [
      ['pendiente', 'lista', 'dependencias_integradas'],
      ['lista', 'reservada', 'reservada'],
      ['reservada', 'ejecutando', 'lanzamiento_iniciado'],
      ['ejecutando', 'verificando', 'proceso_terminado'],
      ['verificando', 'verificada', 'verificacion_aprobada'],
      ['verificada', 'integrando', 'integracion_iniciada'],
      ['integrando', 'integrada', 'integracion_confirmada'],
    ] as const;
    for (const [from, to, reason] of steps) expect(checkTransition(from, to, reason)).toEqual({ ok: true });
  });

  it('no desbloquea dependientes con sólo verificar: hay que integrar', () => {
    expect(checkTransition('verificada', 'integrada', 'integracion_confirmada').ok).toBe(false);
  });

  it('no mueve tareas terminadas', () => {
    expect(checkTransition('integrada', 'bloqueada', 'bloqueo')).toEqual({ ok: false, error: 'la tarea ya terminó (integrada)' });
  });

  it('exige el motivo correcto', () => {
    expect(checkTransition('verificando', 'lista', 'fallo_calidad').ok).toBe(true);
    expect(checkTransition('verificando', 'lista', 'bloqueo').ok).toBe(false);
  });

  it('no permite cancelar algo que se está integrando', () => {
    expect(checkTransition('integrando', 'cancelada', 'cancelacion').ok).toBe(false);
  });
});

describe('aprobaciones', () => {
  const approval = Approval.parse({
    approval_id: 'apr_1',
    actor: 'local',
    issued_at: '2026-09-24T10:00:00Z',
    target_type: 'plan',
    target_id: 'plan_1',
    target_hash: 'sha256:canon-v1:aa',
    spec_revision: 3,
    plan_revision: 2,
    profile_hash: 'sha256:canon-v1:bb',
    policy_hash: 'sha256:canon-v1:cc',
    allowed_task_ids: ['T-001', 'T-002'],
    state: 'vigente',
    request_id: 'req_1',
  });
  const target: ApprovalTarget = {
    target_type: 'plan',
    target_id: 'plan_1',
    target_hash: 'sha256:canon-v1:aa',
    spec_revision: 3,
    plan_revision: 2,
    profile_hash: 'sha256:canon-v1:bb',
    policy_hash: 'sha256:canon-v1:cc',
    task_id: 'T-001',
  };

  it('vale para exactamente lo aprobado', () => {
    expect(checkApproval(approval, target)).toEqual({ ok: true });
  });

  it('queda obsoleta si cambia el plan o la política', () => {
    const r = checkApproval(approval, { ...target, target_hash: 'sha256:canon-v1:zz', policy_hash: 'sha256:canon-v1:yy' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toEqual(['cambió contenido del plan desde la aprobación', 'cambió política desde la aprobación']);
  });

  it('no cubre tareas fuera de la lista', () => {
    expect(checkApproval(approval, { ...target, task_id: 'T-099' }).ok).toBe(false);
  });

  it('respeta vencimiento y revocación', () => {
    const expired = { ...approval, expires_at: '2026-09-24T11:00:00Z' };
    expect(checkApproval(expired, target, new Date('2026-09-24T12:00:00Z')).ok).toBe(false);
    expect(checkApproval({ ...approval, state: 'revocada' }, target).ok).toBe(false);
  });
});

describe('errores', () => {
  it('sólo la calidad sube de modelo', () => {
    expect(countsAsQualityFailure({ category: 'quality', message: '', retryable: true })).toBe(true);
    expect(countsAsQualityFailure({ category: 'quota', message: '', retryable: true })).toBe(false);
  });
});
