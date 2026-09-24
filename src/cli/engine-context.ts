import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine, type Engine } from '../core/engine.js';
import { git } from '../git/git.js';
import { inspectRepo } from '../registry/inspect.js';
import { openProject, type GlobalOptions, type ProjectContext } from './context.js';

export type EngineContext = ProjectContext & { engine: Engine };

export function openEngine(options: GlobalOptions): EngineContext {
  const ctx = openProject(options);
  const engine = createEngine({ store: ctx.store, dataDir: ctx.dataDir, config: ctx.config });
  return { ...ctx, engine };
}

/** Static evidence for improvement planning: never runs anything from the repo. */
export async function repoEvidence(path: string): Promise<object> {
  const inspection = await inspectRepo(path);
  const files = (await git(path, ['ls-files'])).stdout.split('\n').filter(Boolean);
  const readme = ['README.md', 'readme.md', 'README'].map((f) => join(path, f)).find((f) => existsSync(f));
  return {
    lenguajes: inspection.languages,
    manifiestos: inspection.manifests,
    archivos: files.length > 400 ? [...files.slice(0, 400), `… y ${files.length - 400} más`] : files,
    readme: readme ? readFileSync(readme, 'utf8').split('\n').slice(0, 60).join('\n') : null,
    nota: 'Puedes leer archivos del repositorio con tus herramientas de lectura para comprobar afirmaciones.',
  };
}

/** Whether a repo has product code beyond Forja's own files (decides idea vs improvement). */
export async function hasProductCode(path: string): Promise<boolean> {
  const files = (await git(path, ['ls-files'])).stdout.split('\n').filter(Boolean);
  return files.some((f) => !f.startsWith('.forja/') && !['forja.yaml', '.gitignore', 'README.md'].includes(f));
}
