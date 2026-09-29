import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { callRole, type Engine, NoProviderError } from '../core/engine.js';
import { newId } from '../domain/ids.js';
import { git } from '../git/git.js';
import { deliveryBranch, detachedWorktree, refSha, removeWorktree } from '../git/workspace.js';
import { latestPlan } from '../plan/divide.js';
import { compose, loadPrompt } from '../planner/prompts.js';
import { llmSchema } from '../planner/session.js';
import { runsOf } from '../run/records.js';
import { Redactor } from '../security/redact.js';
import { latestSpec } from '../spec/generate.js';
import { runCommand } from '../verify/commands.js';
import { ObservationService } from './observations.js';

/**
 * Validation of a whole delivered sprint (v3/PLAN.md §5.1): QA and the auditor on the
 * delivery branch. Deterministic checks first (build, lint, full tests, secrets and
 * destructive operations in the diff), then the models. Everything they find becomes an
 * observation; NOTHING is corrected here — the user decides with an action plan.
 */
export const AuditOutput = z
  .object({
    hallazgos: z.array(
      z
        .object({
          severidad: z.enum(['critica', 'alta', 'media', 'baja']),
          clase: z.enum(['defecto', 'sugerencia', 'requisito_nuevo']),
          ubicacion: z.string(),
          motivo: z.string(),
          recomendacion: z.string(),
          condicion_cierre: z.string(),
        })
        .strict(),
    ),
    cobertura: z.array(z.string()),
    resumen: z.string(),
  })
  .strict();

export const QaOutput = z
  .object({
    escenarios: z.array(
      z
        .object({
          criterio: z.string(),
          resultado: z.enum(['paso', 'fallo', 'bloqueado', 'no_ejecutado']),
          pasos: z.string(),
          esperado: z.string(),
          obtenido: z.string(),
          evidencia: z.string(),
        })
        .strict(),
    ),
    resumen: z.string(),
  })
  .strict();

export type CheckResult = { paso: string; ok: boolean | null; detalle: string };
export type ValidationReport = {
  id: string;
  change_id: string;
  commit: string;
  fecha: string;
  comprobaciones: CheckResult[];
  auditor: z.infer<typeof AuditOutput> | { error: string };
  qa: z.infer<typeof QaOutput> | { error: string };
  observaciones: number;
};

export const VALIDATION_EV = 'validacion.registrada';

const DESTRUCTIVE: [RegExp, string][] = [
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA|COLUMN)\b/i, 'borra una tabla, base, esquema o columna'],
  [/\bTRUNCATE\b/i, 'vacía una tabla'],
  [/\bDELETE\s+FROM\s+[\w."]+\s*;/i, 'DELETE sin WHERE'],
  [/\brm\s+-rf\s+(\/|~|\$HOME)/, 'borrado recursivo de la raíz o del HOME'],
];

/** Secrets and destructive operations in the ADDED lines of the sprint's diff (no tokens). */
export function scanDiff(diff: string, redactor = new Redactor()): { secrets: string[]; destructive: string[] } {
  const secrets: string[] = [];
  const destructive: string[] = [];
  let file = '';
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      file = raw.slice(6);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]) - 1;
      continue;
    }
    if (raw.startsWith('-')) continue;
    line++;
    if (!raw.startsWith('+')) continue;
    const text = raw.slice(1);
    if (redactor.containsSecret(text)) secrets.push(`${file}:${line}`);
    for (const [re, what] of DESTRUCTIVE) if (re.test(text)) destructive.push(`${file}:${line} ${what}`);
  }
  return { secrets, destructive };
}

export async function validateSprint(engine: Engine, input: { changeId: string; repoPath: string; sandbox?: boolean; onLog?: (line: string) => void }): Promise<ValidationReport> {
  const log = input.onLog ?? (() => {});
  const run = runsOf(engine, input.changeId)[0];
  if (run?.state !== 'completado') throw new Error('el sprint todavía no tiene una entrega completa: termina el run antes de validar');
  const branch = deliveryBranch(engine.config.git.prefijo, input.changeId);
  const commit = await refSha(input.repoPath, branch);
  const plan = latestPlan(engine, input.changeId)?.plan;
  const spec = latestSpec(engine, input.changeId)?.spec;
  if (!plan || !spec) throw new Error('falta el plan o la especificación del sprint');
  const wt = await detachedWorktree(input.repoPath, join(engine.dataDir, 'worktrees', 'validacion', input.changeId), commit);
  const observations = new ObservationService(engine);
  let recorded = 0;
  const observe = (o: Omit<Parameters<ObservationService['record']>[0], 'change_id' | 'run_id' | 'commit_sha'>) => {
    observations.record({ ...o, change_id: input.changeId, run_id: run.run_id, commit_sha: commit });
    recorded++;
  };
  const checks: CheckResult[] = [];
  try {
    // 1) QA, deterministic: the whole profile on the delivered code, in the sandbox.
    const cmd = {
      dataDir: engine.dataDir,
      sandbox: input.sandbox ?? true,
      timeoutMs: engine.config.ejecucion.timeout_min * 60_000,
      ...(engine.runnerScript ? { runnerScript: engine.runnerScript } : {}),
    };
    const c = plan.perfil.comandos;
    if (c.instalar && existsSync(join(wt, 'package.json'))) {
      const r = await runCommand({ ...cmd, networkHosts: plan.perfil.red_instalar }, wt, c.instalar);
      checks.push({ paso: 'instalar', ok: r.ok, detalle: r.ok ? 'ok' : r.output.slice(-800) });
    }
    for (const name of ['typecheck', 'build', 'lint', 'test'] as const) {
      const recipe = c[name];
      if (!recipe) {
        checks.push({ paso: name, ok: null, detalle: 'no configurado en el perfil: no se comprobó' });
        continue;
      }
      log(`⋯ QA: ${name}`);
      const r = await runCommand(cmd, wt, recipe);
      checks.push({ paso: name, ok: r.ok, detalle: r.ok ? `${Math.round(r.durationMs / 1000)}s` : r.output.slice(-1500) });
      if (!r.ok) observe({ source: 'qa', severity: 'alta', kind: 'defecto', location: name, text: `«${name}» falla sobre la entrega`, evidence: r.output.slice(-1500) });
    }

    // 2) Auditor, deterministic: the diff of the whole sprint.
    const diff = (await git(input.repoPath, ['diff', '--no-color', `${run.base_sha}..${commit}`, '--', '.', ':(exclude)package-lock.json'])).stdout;
    const scan = scanDiff(diff);
    checks.push({ paso: 'secretos', ok: scan.secrets.length === 0, detalle: scan.secrets.length ? scan.secrets.join(', ') : 'ninguno en las líneas añadidas' });
    for (const s of scan.secrets) observe({ source: 'auditor', severity: 'critica', kind: 'defecto', location: s, text: 'Hay algo con forma de credencial en el código entregado' });
    checks.push({ paso: 'operaciones_destructivas', ok: scan.destructive.length === 0, detalle: scan.destructive.length ? scan.destructive.join('; ') : 'ninguna' });
    for (const d of scan.destructive) observe({ source: 'auditor', severity: 'alta', kind: 'defecto', location: d.split(' ')[0]!, text: `Operación destructiva: ${d.split(' ').slice(1).join(' ')}` });
    checks.push({ paso: 'dependencias', ok: null, detalle: 'no cubierto: la auditoría de dependencias necesita red y no se ejecuta en el sandbox' });

    const trimmed = diff.length > 80_000 ? `${diff.slice(0, 80_000)}\n… [recortado]` : diff;
    const call = async <T>(role: 'auditor' | 'qa', schema: z.ZodType<T>, data: Record<string, unknown>): Promise<T | { error: string }> => {
      log(`⋯ ${role === 'qa' ? 'QA' : 'auditor'}: revisando con ${engine.config.roles[role][0]}`);
      try {
        const { prompt } = compose([loadPrompt(`trabajo/${role}`)], data);
        const r = await callRole(engine, {
          role,
          prompt,
          tools: 'lectura',
          workspace: wt,
          workspaceReadOnly: true,
          outputSchema: llmSchema(schema),
          scope: { change_id: input.changeId, run_id: run.run_id },
        });
        const parsed = schema.safeParse(r.outcome.summary.structured);
        return parsed.success ? parsed.data : { error: `el ${role} no devolvió un resultado válido` };
      } catch (error) {
        return { error: error instanceof NoProviderError ? error.message : `no se pudo ejecutar: ${(error as Error).message}` };
      }
    };

    // 3) The models, with the deterministic results as evidence.
    const auditor = await call('auditor', AuditOutput, { reglas: spec.reglas, entidades: spec.entidades, comprobaciones: checks, diff: trimmed });
    if (!('error' in auditor))
      for (const h of auditor.hallazgos)
        observe({
          source: 'auditor',
          severity: h.severidad,
          kind: h.clase,
          location: h.ubicacion,
          text: h.motivo,
          evidence: `Recomendación: ${h.recomendacion}\nSe cierra cuando: ${h.condicion_cierre}`,
        });
    else observe({ source: 'auditor', severity: 'media', kind: 'defecto', location: 'auditoría', text: `La auditoría no se pudo completar: ${auditor.error}` });

    const qa = await call('qa', QaOutput, {
      criterios: spec.criterios,
      casos_de_uso: spec.casos_uso,
      pruebas: checks.filter((x) => ['typecheck', 'build', 'lint', 'test'].includes(x.paso)),
      diff: trimmed,
    });
    if (!('error' in qa)) {
      for (const e of qa.escenarios.filter((x) => x.resultado === 'fallo'))
        observe({
          source: 'qa',
          severity: 'alta',
          kind: 'defecto',
          location: e.criterio,
          text: `Falla ${e.criterio}: esperado «${e.esperado}», obtenido «${e.obtenido}»`,
          evidence: `Pasos: ${e.pasos}\n${e.evidencia}`,
        });
      for (const e of qa.escenarios.filter((x) => x.resultado === 'bloqueado'))
        observe({ source: 'qa', severity: 'media', kind: 'defecto', location: e.criterio, text: `No se pudo comprobar ${e.criterio}: ${e.obtenido || e.evidencia}` });
    } else observe({ source: 'qa', severity: 'media', kind: 'defecto', location: 'qa', text: `QA no se pudo completar: ${qa.error}` });

    const report: ValidationReport = { id: newId('val'), change_id: input.changeId, commit, fecha: new Date().toISOString(), comprobaciones: checks, auditor, qa, observaciones: recorded };
    const dir = join(engine.dataDir, 'validaciones', input.changeId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${commit.slice(0, 12)}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
    engine.store.execute({ request_id: newId('req'), type: 'registrar_validacion', input: { id: report.id } }, () => ({
      result: null,
      events: [
        {
          type: VALIDATION_EV,
          aggregate_type: 'cambio',
          aggregate_id: input.changeId,
          run_id: run.run_id,
          payload: { id: report.id, commit, observaciones: recorded, comprobaciones: checks.map((x) => ({ paso: x.paso, ok: x.ok })) },
        },
      ],
    }));
    return report;
  } finally {
    await removeWorktree(input.repoPath, wt);
  }
}

/** The latest validation of a sprint (for the panel), or null. */
export function latestValidation(
  engine: Engine,
  changeId: string,
): { id: string; commit: string; fecha: string; observaciones: number; comprobaciones: { paso: string; ok: boolean | null }[] } | null {
  const row = engine.store.db.prepare('SELECT payload, occurred_at FROM events WHERE type = ? AND aggregate_id = ? ORDER BY seq DESC LIMIT 1').get(VALIDATION_EV, changeId) as
    | { payload: string; occurred_at: string }
    | undefined;
  if (!row) return null;
  const p = JSON.parse(row.payload) as { id: string; commit: string; observaciones: number; comprobaciones: { paso: string; ok: boolean | null }[] };
  return { ...p, fecha: row.occurred_at };
}
