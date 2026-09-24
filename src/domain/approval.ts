import { z } from 'zod';

/** Approval from v2/formatos/especificacion-y-configuracion.md. */
export const Approval = z
  .object({
    approval_id: z.string().min(1),
    actor: z.string().min(1),
    issued_at: z.iso.datetime(),
    expires_at: z.iso.datetime().optional(),
    target_type: z.enum(['plan', 'accion']),
    target_id: z.string().min(1),
    target_hash: z.string().regex(/^sha256:/),
    spec_revision: z.number().int().positive(),
    plan_revision: z.number().int().positive(),
    profile_hash: z.string().regex(/^sha256:/),
    policy_hash: z.string().regex(/^sha256:/),
    allowed_task_ids: z.array(z.string()),
    connections: z.array(z.string()).default([]),
    state: z.enum(['vigente', 'revocada', 'consumida', 'obsoleta']),
    request_id: z.string().min(1),
  })
  .strict();
export type Approval = z.infer<typeof Approval>;

/** What is about to run, computed from the current plan, profile and policy. */
export type ApprovalTarget = {
  target_type: Approval['target_type'];
  target_id: string;
  target_hash: string;
  spec_revision: number;
  plan_revision: number;
  profile_hash: string;
  policy_hash: string;
  task_id?: string;
};

export type ApprovalCheck = { ok: true } | { ok: false; reasons: string[] };

/** An approval covers exactly what was shown: any hash or revision drift invalidates it. */
export function checkApproval(approval: Approval, target: ApprovalTarget, now: Date = new Date()): ApprovalCheck {
  const reasons: string[] = [];
  if (approval.state !== 'vigente') reasons.push(`aprobación ${approval.state}`);
  if (approval.expires_at && new Date(approval.expires_at) <= now) reasons.push('aprobación vencida');
  const same: [keyof ApprovalTarget & keyof Approval, string][] = [
    ['target_type', 'tipo de objetivo'],
    ['target_id', 'objetivo'],
    ['target_hash', 'contenido del plan'],
    ['spec_revision', 'revisión de la spec'],
    ['plan_revision', 'revisión del plan'],
    ['profile_hash', 'perfil de ejecución'],
    ['policy_hash', 'política'],
  ];
  for (const [key, label] of same) {
    if (approval[key] !== target[key]) reasons.push(`cambió ${label} desde la aprobación`);
  }
  if (target.task_id !== undefined && !approval.allowed_task_ids.includes(target.task_id)) {
    reasons.push(`la tarea ${target.task_id} no está incluida en la aprobación`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
