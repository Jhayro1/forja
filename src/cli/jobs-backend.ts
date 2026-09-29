import { join } from 'node:path';
import type { JobsBackend } from '../api/modules/jobs.js';
import type { EngineContext } from './engine-context.js';
import { FORJA_BIN, type JobCommand, JobRunner } from './jobs.js';

/** The only commands the panel can start: fixed arguments, nothing typed by the browser reaches a shell. */
export const PROJECT_JOBS: Record<string, { titulo: string; args: string[] }> = {
  especificar: { titulo: 'Especificar', args: ['especificar'] },
  dividir: { titulo: 'Dividir en tareas', args: ['dividir'] },
  estimar: { titulo: 'Estimar el run', args: ['run', '--estimar'] },
  run: { titulo: 'Ejecutar el plan', args: ['run'] },
  'perfil-aprobar': { titulo: 'Aprobar el perfil detectado', args: ['perfil', 'aprobar'] },
  'linea-base': { titulo: 'Medir la línea base (build y tests)', args: ['perfil', 'linea-base'] },
  conformidad: { titulo: 'Probar los modelos configurados', args: ['conformidad'] },
  informe: { titulo: 'Informe final', args: ['informe'] },
  validar: { titulo: 'Validar el sprint (QA y auditoría)', args: ['validar'] },
};

export function jobsDir(ctx: EngineContext): string {
  return join(ctx.dataDir, 'trabajos');
}

export class ProjectJobsBackend implements JobsBackend {
  private readonly runner: JobRunner;

  constructor(
    private readonly ctx: EngineContext,
    runner?: JobRunner,
    private readonly bin: string = FORJA_BIN,
  ) {
    this.runner = runner ?? new JobRunner(jobsDir(ctx));
  }

  kinds() {
    return Object.entries(PROJECT_JOBS).map(([tipo, j]) => ({ tipo, titulo: j.titulo }));
  }

  list(): object[] {
    return this.runner.list();
  }

  get(id: string) {
    const trabajo = this.runner.view(id);
    return trabajo ? { trabajo, salida: this.runner.output(id) } : null;
  }

  command(kind: string): JobCommand {
    const job = PROJECT_JOBS[kind];
    if (!job) throw new Error(`tipo de trabajo desconocido: ${kind}`);
    return { title: job.titulo, file: process.execPath, args: [this.bin, '--proyecto', this.ctx.checkout.checkout_id, ...job.args], cwd: this.ctx.checkout.path };
  }

  start(kind: string): object {
    return this.runner.start(kind, this.command(kind));
  }

  cancel(id: string, force: boolean): object {
    return this.runner.cancel(id, force);
  }
}
