#!/usr/bin/env node
// Arma el paquete de Forja Ligera (ligera/PLAN.md F5) a partir del build normal:
// mismo dist/ y panel/dist, otro package.json (nombre, binario, sin "os": ["linux"]).
// Deja build/ligera/forja-ligera.tgz, el archivo que instalan ligera.ps1 y ligera.sh.
//   npm run build && node scripts/empaquetar-ligera.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'build', 'ligera');
const pkgDir = join(out, 'paquete');
const base = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

for (const need of ['dist/cli/bin-ligera.js', 'panel/dist/index.html']) {
  if (!existsSync(join(root, need))) throw new Error(`falta ${need}: corre «npm run build» antes`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(pkgDir, { recursive: true });
// panel/dist/.vite/manifest.json stays: the server reads it to serve the login page.
const copy = (from, to = from) => cpSync(join(root, from), join(pkgDir, to), { recursive: true, filter: (src) => !src.endsWith('.map') && !src.endsWith('.d.ts') });
copy('dist');
copy('panel/dist');
copy('prompts');
copy('LICENSE');
copy('NOTICE');
copy('docs/guias/LIGERA.md', 'README.md');

const pkg = {
  name: '@jhayro1/forja-ligera',
  version: base.version,
  description: 'Forja Ligera: un agente (Claude o Codex, los que ya tienes) hace tus tareas por bloques, en su propia rama. Instalación de un comando, sin WSL.',
  license: base.license,
  repository: base.repository,
  homepage: 'https://github.com/Jhayro1/forja/blob/main/docs/guias/LIGERA.md',
  keywords: [...base.keywords, 'windows'],
  type: 'module',
  engines: base.engines,
  bin: { forja: './dist/cli/bin-ligera.js' },
  dependencies: base.dependencies,
};
writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const name = execFileSync(npm, ['pack', '--silent', '--pack-destination', out], { cwd: pkgDir, encoding: 'utf8', shell: process.platform === 'win32' })
  .trim()
  .split('\n')
  .at(-1);
renameSync(join(out, name), join(out, 'forja-ligera.tgz'));
console.log(`listo: ${join(out, 'forja-ligera.tgz')} (${pkg.name}@${pkg.version})`);
