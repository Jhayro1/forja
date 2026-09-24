import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ForjaConfig } from '../registry/config.js';

/**
 * Static profile detection (V2-030): reads manifests only — it never runs a
 * command from the repository. The result is a PROPOSAL the user approves
 * (`forja perfil aprobar`); until then the planner proposes one per plan.
 */

type Recipe = { executable: string; args: string[] };
export type ProfileCommands = Partial<Record<'instalar' | 'build' | 'typecheck' | 'lint' | 'test', Recipe>>;
export type DetectedProfile = {
  stack: string[];
  gestor: string | null;
  comandos: ProfileCommands;
  red_instalar: string[];
  /** Why each command was chosen (shown to the user before approving). */
  evidencia: string[];
};

export interface ProfileDetector {
  readonly id: string;
  applies(root: string): boolean;
  detect(root: string): DetectedProfile;
}

const read = (root: string, file: string): string => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '');

/** npm's placeholder script: it always fails, so it is not a test command. */
const PLACEHOLDER_TEST = /no test specified/;

export const nodeDetector: ProfileDetector = {
  id: 'node',
  applies: (root) => existsSync(join(root, 'package.json')),
  detect(root) {
    const evidencia: string[] = [];
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(read(root, 'package.json')) as typeof pkg;
    } catch {
      evidencia.push('package.json no es JSON válido: sólo se propone instalar');
    }
    const scripts = pkg.scripts ?? {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const gestor = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : existsSync(join(root, 'bun.lockb')) ? 'bun' : 'npm';
    evidencia.push(`gestor ${gestor} (${gestor === 'npm' ? (existsSync(join(root, 'package-lock.json')) ? 'package-lock.json' : 'sin lockfile') : 'lockfile'})`);
    const comandos: ProfileCommands = {};
    comandos.instalar =
      gestor === 'npm'
        ? { executable: 'npm', args: existsSync(join(root, 'package-lock.json')) ? ['ci', '--ignore-scripts'] : ['install', '--ignore-scripts'] }
        : gestor === 'pnpm'
          ? { executable: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts'] }
          : gestor === 'yarn'
            ? { executable: 'yarn', args: ['install', '--frozen-lockfile', '--ignore-scripts'] }
            : { executable: 'bun', args: ['install', '--frozen-lockfile', '--ignore-scripts'] };
    const run = (script: string): Recipe => ({ executable: gestor, args: gestor === 'npm' ? ['run', script, '--'] : ['run', script] });
    for (const [step, names] of [
      ['build', ['build']],
      ['typecheck', ['typecheck', 'type-check', 'tsc', 'check-types']],
      ['lint', ['lint']],
    ] as const) {
      const name = names.find((n) => scripts[n]);
      if (name) {
        comandos[step] = run(name);
        evidencia.push(`${step}: script «${name}» (${scripts[name]})`);
      }
    }
    if (!comandos.typecheck && existsSync(join(root, 'tsconfig.json')) && deps.typescript) {
      comandos.typecheck = { executable: 'npx', args: ['--no-install', 'tsc', '--noEmit'] };
      evidencia.push('typecheck: tsconfig.json y typescript en dependencias');
    }
    if (scripts.test && !PLACEHOLDER_TEST.test(scripts.test)) {
      comandos.test = gestor === 'npm' ? { executable: 'npm', args: ['test', '--'] } : { executable: gestor, args: ['test'] };
      evidencia.push(`test: script «test» (${scripts.test})`);
    } else {
      evidencia.push('sin script de pruebas: la verificación no podrá correr pruebas hasta que exista');
    }
    const stack = ['node', ...(deps.typescript ? ['typescript'] : [])];
    for (const f of ['react', 'next', 'vue', 'svelte', 'express', 'fastify', 'vitest', 'jest']) if (deps[f]) stack.push(f);
    const red = gestor === 'yarn' ? ['registry.yarnpkg.com', 'registry.npmjs.org'] : ['registry.npmjs.org'];
    return { stack, gestor, comandos, red_instalar: red, evidencia };
  },
};

export const pythonDetector: ProfileDetector = {
  id: 'python',
  applies: (root) => ['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => existsSync(join(root, f))),
  detect(root) {
    const evidencia: string[] = [];
    const text = `${read(root, 'pyproject.toml')}\n${read(root, 'requirements.txt')}\n${read(root, 'requirements-dev.txt')}`;
    const uses = (name: string) => new RegExp(`(^|[\\s"'\\[])${name}\\b`, 'mi').test(text);
    const gestor = existsSync(join(root, 'uv.lock')) ? 'uv' : existsSync(join(root, 'poetry.lock')) ? 'poetry' : 'pip';
    const comandos: ProfileCommands = {};
    comandos.instalar =
      gestor === 'uv'
        ? { executable: 'uv', args: ['sync', '--frozen'] }
        : gestor === 'poetry'
          ? { executable: 'poetry', args: ['install', '--no-interaction'] }
          : existsSync(join(root, 'requirements.txt'))
            ? { executable: 'python3', args: ['-m', 'pip', 'install', '-r', 'requirements.txt'] }
            : { executable: 'python3', args: ['-m', 'pip', 'install', '-e', '.'] };
    evidencia.push(`gestor ${gestor}`);
    const py = (mod: string, ...args: string[]): Recipe => (gestor === 'pip' ? { executable: 'python3', args: ['-m', mod, ...args] } : { executable: gestor, args: ['run', mod, ...args] });
    if (uses('pytest')) {
      comandos.test = py('pytest', '-q');
      evidencia.push('test: pytest declarado');
    }
    if (uses('ruff')) {
      comandos.lint = py('ruff', 'check', '.');
      evidencia.push('lint: ruff declarado');
    }
    if (uses('mypy')) {
      comandos.typecheck = py('mypy', '.');
      evidencia.push('typecheck: mypy declarado');
    }
    return { stack: ['python'], gestor, comandos, red_instalar: ['pypi.org', 'files.pythonhosted.org'], evidencia };
  },
};

export const goDetector: ProfileDetector = {
  id: 'go',
  applies: (root) => existsSync(join(root, 'go.mod')),
  detect: () => ({
    stack: ['go'],
    gestor: 'go',
    comandos: {
      instalar: { executable: 'go', args: ['mod', 'download'] },
      build: { executable: 'go', args: ['build', './...'] },
      typecheck: { executable: 'go', args: ['vet', './...'] },
      test: { executable: 'go', args: ['test', './...'] },
    },
    red_instalar: ['proxy.golang.org', 'sum.golang.org'],
    evidencia: ['go.mod: comandos estándar de Go (las pruebas se seleccionan por paquete, no por archivo)'],
  }),
};

export const rustDetector: ProfileDetector = {
  id: 'rust',
  applies: (root) => existsSync(join(root, 'Cargo.toml')),
  detect: () => ({
    stack: ['rust'],
    gestor: 'cargo',
    comandos: {
      instalar: { executable: 'cargo', args: ['fetch'] },
      build: { executable: 'cargo', args: ['build'] },
      typecheck: { executable: 'cargo', args: ['check'] },
      lint: { executable: 'cargo', args: ['clippy', '--', '-D', 'warnings'] },
      test: { executable: 'cargo', args: ['test'] },
    },
    red_instalar: ['index.crates.io', 'static.crates.io', 'crates.io'],
    evidencia: ['Cargo.toml: comandos estándar de Cargo'],
  }),
};

/** Registry of detectors (Open/Closed: a new ecosystem is one more entry). The first that applies wins. */
export const DETECTORS: readonly ProfileDetector[] = [nodeDetector, pythonDetector, goDetector, rustDetector];

export function detectProfile(root: string, detectors: readonly ProfileDetector[] = DETECTORS): DetectedProfile | null {
  const d = detectors.find((x) => x.applies(root));
  return d ? d.detect(root) : null;
}

/** The detected profile in forja.yaml's shape. */
export function toConfigProfile(p: DetectedProfile): ForjaConfig['perfil'] {
  const comandos: ForjaConfig['perfil']['comandos'] = {};
  for (const [k, v] of Object.entries(p.comandos)) comandos[k as keyof typeof comandos] = { executable: v.executable, args: v.args, cwd: '.' };
  return { stack: p.stack, ...(p.gestor ? { gestor: p.gestor } : {}), comandos, red_instalar: p.red_instalar };
}

/** Commands only, without cwd defaults: what identifies a profile for its baseline. */
export function profileCommands(perfil: { comandos: Partial<Record<string, { executable: string; args: string[] } | null | undefined>> }): ProfileCommands {
  const out: ProfileCommands = {};
  for (const [k, v] of Object.entries(perfil.comandos)) if (v) out[k as keyof ProfileCommands] = { executable: v.executable, args: [...v.args] };
  return out;
}
