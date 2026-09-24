import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blobHash, buildGraph } from '../../src/memory/build.js';
import { extractGo } from '../../src/memory/extract/go.js';
import { extractJava } from '../../src/memory/extract/java.js';
import { extractRust } from '../../src/memory/extract/rust.js';
import { GraphStore } from '../../src/memory/graph-store.js';
import { parseJsonc } from '../../src/memory/resolve-context.js';

let dir: string;
let graph: GraphStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-lang-'));
  graph = GraphStore.open(join(dir, 'datos'));
});
afterEach(() => {
  graph.close();
  rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();
function repo(files: Record<string, string>): string {
  const r = join(dir, 'repo');
  mkdirSync(join(dir, 'datos'), { recursive: true });
  mkdirSync(r, { recursive: true });
  git(r, 'init', '-q');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(r, p)), { recursive: true });
    writeFileSync(join(r, p), c);
  }
  git(r, 'add', '-A');
  return r;
}
const out = (id: string, kind?: string) =>
  graph
    .out(id, kind ? [kind as never] : undefined)
    .map((e) => `${e.kind}:${e.dst}${e.confidence === 'posible' ? '?' : ''}`)
    .sort();

describe('más lenguajes (MEJORAS 5.6)', () => {
  it('Go: imports del módulo por carpeta, estándar como paquete; símbolos exportados por mayúscula', async () => {
    const x = extractGo(
      'package main\n// import "falso"\nimport (\n  "fmt"\n  st "example.com/app/internal/store"\n)\nfunc main() {}\nfunc (s *Srv) Handle() {}\ntype Store struct{}\nvar version = "1"\n',
    );
    expect(x.imports.map((i) => i.specifier)).toEqual(['fmt', 'example.com/app/internal/store']);
    expect(x.symbols.map((s) => `${s.name}:${s.exported}`)).toEqual(['main:false', 'Handle:true', 'Store:true', 'version:false']);
    const r = repo({
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
      'cmd/main.go': 'package main\nimport (\n "fmt"\n "example.com/app/internal/store"\n)\nfunc main() { fmt.Println(store.New()) }\n',
      'internal/store/store.go': 'package store\nfunc New() *Store { return nil }\ntype Store struct{}\n',
      'internal/store/store_test.go': 'package store\n// CA-UC-001-01\nfunc TestNew(t *testing.T) {}\n',
    });
    await buildGraph(graph, { repoPath: r });
    expect(out('archivo:cmd/main.go', 'importa')).toEqual(['importa:archivo:internal/store/store.go?', 'importa:paquete:fmt']);
    expect(out('archivo:internal/store/store_test.go', 'verifica')).toEqual(['verifica:criterio:CA-UC-001-01']);
  });

  it('Rust: mod declara archivos, use crate:: llega al módulo; cadenas crudas no engañan', async () => {
    const x = extractRust(
      'mod db;\npub mod api;\nuse crate::models::User;\nuse serde::{Serialize, Deserialize};\nconst Q: &str = r#"use falso::x;"#;\npub fn run() {}\nstruct Interna;\npub(crate) trait Repo {}\n',
    );
    expect(x.imports.map((i) => i.specifier)).toEqual(['mod:db', 'mod:api', 'crate::models::User', 'serde']);
    expect(x.symbols.map((s) => `${s.name}:${s.exported}`)).toEqual(['Q:false', 'run:true', 'Interna:false', 'Repo:true']);
    const r = repo({
      'Cargo.toml': '[package]\nname = "app"\n',
      'src/lib.rs': 'mod db;\nmod models;\npub fn run() {}\n',
      'src/db.rs': 'use crate::models::User;\nuse super::run;\npub fn guardar(u: User) {}\n',
      'src/models/mod.rs': 'pub struct User;\n',
    });
    await buildGraph(graph, { repoPath: r });
    expect(out('archivo:src/lib.rs', 'importa')).toEqual(['importa:archivo:src/db.rs', 'importa:archivo:src/models/mod.rs']);
    // `models::User` is an item inside models/mod.rs: resolved to the module, «posible».
    expect(out('archivo:src/db.rs', 'importa')).toContain('importa:archivo:src/models/mod.rs?');
  });

  it('Java: clases por ruta de paquete bajo cualquier raíz; static y comodín; java.* es paquete', async () => {
    const x = extractJava(
      'package com.x;\nimport java.util.List;\nimport com.x.util.Helper;\nimport static com.x.util.Helper.ayuda;\nimport com.x.model.*;\n/* import com.falso.X; */\npublic final class App {}\ninterface Interna {}\n',
    );
    expect(x.imports.map((i) => i.specifier)).toEqual(['java.util.List', 'com.x.util.Helper', 'static:com.x.util.Helper.ayuda', 'com.x.model.*']);
    expect(x.symbols.map((s) => `${s.name}:${s.exported}`)).toEqual(['App:true', 'Interna:false']);
    const r = repo({
      'src/main/java/com/x/App.java': 'package com.x;\nimport java.util.List;\nimport com.x.util.Helper;\nimport static com.x.util.Helper.ayuda;\nimport com.x.model.*;\npublic class App {}\n',
      'src/main/java/com/x/util/Helper.java': 'package com.x.util;\npublic class Helper { public static void ayuda() {} }\n',
      'src/main/java/com/x/model/Pedido.java': 'package com.x.model;\npublic record Pedido(int id) {}\n',
      'src/test/java/com/x/AppTest.java': 'package com.x;\n// CA-UC-002-01\nclass AppTest {}\n',
    });
    await buildGraph(graph, { repoPath: r });
    expect(out('archivo:src/main/java/com/x/App.java', 'importa')).toEqual([
      'importa:archivo:src/main/java/com/x/model/Pedido.java?',
      'importa:archivo:src/main/java/com/x/util/Helper.java',
      'importa:paquete:java',
    ]);
    expect(out('archivo:src/test/java/com/x/AppTest.java', 'verifica')).toEqual(['verifica:criterio:CA-UC-002-01']);
  });
});

describe('barrels, alias y workspaces (MEJORAS 5.2, 5.3)', () => {
  it('sigue un símbolo a través de barrels hasta quien lo define y resuelve alias de tsconfig y paquetes del workspace', async () => {
    const r = repo({
      'tsconfig.json': '{\n  // comentarios y comas finales como en tsc\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, },\n}\n',
      'package.json': JSON.stringify({ name: 'raiz', workspaces: ['packages/*'], imports: { '#config': './src/config.ts' } }),
      'src/a.ts': 'export function sumar(a: number, b: number) { return a + b; }\nexport const nada = 0;\n',
      'src/index.ts': "export * from './a';\nexport { sumar as total } from './a';\n",
      'src/config.ts': 'export const puerto = 3000;\n',
      'src/uso.ts':
        "import { sumar, nada } from '@/index';\nimport { total } from './index.js';\nimport { puerto } from '#config';\nimport { base } from '@app/core';\nexport const r = sumar(1, 2) + total(3, 4) + puerto + base;\n",
      'packages/core/package.json': JSON.stringify({ name: '@app/core', exports: { '.': { import: './src/index.ts' } } }),
      'packages/core/src/index.ts': 'export const base = 1;\n',
    });
    const report = await buildGraph(graph, { repoPath: r });
    expect(report.sin_resolver).toEqual([]);
    const uses = out('archivo:src/uso.ts', 'usa');
    // `nada` is imported but never used: no «usa» edge.
    expect(uses).toEqual(['usa:simbolo:packages/core/src/index.ts#base', 'usa:simbolo:src/a.ts#sumar', 'usa:simbolo:src/config.ts#puerto']);
    expect(out('archivo:src/uso.ts', 'importa')).toEqual(
      expect.arrayContaining(['importa:archivo:src/index.ts', 'importa:archivo:src/a.ts', 'importa:archivo:src/config.ts', 'importa:archivo:packages/core/src/index.ts']),
    );
    expect(graph.in('simbolo:src/a.ts#sumar', ['usa']).map((e) => e.src)).toEqual(['archivo:src/uso.ts']);
    expect(parseJsonc('{"a": "x // no es comentario", /* c */ "b": [1,],}')).toEqual({ a: 'x // no es comentario', b: [1] });
  });
});

describe('hash desde el índice de git (MEJORAS 5.8)', () => {
  it('usa el blob de git para lo no modificado y sólo reanaliza lo cambiado en el árbol de trabajo', async () => {
    const r = repo({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
    const first = await buildGraph(graph, { repoPath: r });
    expect(first).toMatchObject({ archivos: 2, analizados: 2 });
    const staged = git(r, 'ls-files', '-s', 'src/a.ts').split(/\s+/)[1];
    expect(graph.fileRecord('src/a.ts')!.hash).toBe(staged);
    expect(blobHash(Buffer.from('export const a = 1;\n'))).toBe(staged);
    writeFileSync(join(r, 'src/b.ts'), 'export const b = 3;\n');
    const second = await buildGraph(graph, { repoPath: r });
    expect(second).toMatchObject({ archivos: 2, analizados: 1, reutilizados: 1 });
    const third = await buildGraph(graph, { repoPath: r });
    expect(third).toMatchObject({ analizados: 0, reutilizados: 2 });
  });
});

describe('buscador léxico local (MEJORAS 5.9)', () => {
  it('ubica los archivos que se parecen a la tarea, sin red, y el selector los ofrece como «posible»', async () => {
    const { LexicalFinder, terms } = await import('../../src/memory/locator.js');
    const { graphSelection } = await import('../../src/memory/selector.js');
    expect(terms('calcularSaldoPendiente del_cliente áreas')).toEqual(['calcular', 'saldo', 'pendiente', 'cliente', 'areas']);
    const r = repo({
      'src/cobranza/saldo.ts': 'export function calcularSaldoPendiente(fiados: number[], abonos: number[]) { /* saldo pendiente del cliente */ return 0; }\n',
      'src/inventario/stock.ts': 'export function reponerStock(producto: string) { return producto; }\n',
      'src/ui/menu.ts': 'export const menu = ["inicio", "ajustes"];\n',
    });
    await buildGraph(graph, { repoPath: r });
    const finder = new LexicalFinder(graph);
    expect(finder.find('mostrar el saldo pendiente de un cliente', 3)[0]!.path).toBe('src/cobranza/saldo.ts');
    expect(finder.find('zzz', 3)).toEqual([]);
    const task = {
      id: 'T-001',
      titulo: 'Saldo pendiente',
      objetivo: 'mostrar el saldo pendiente del cliente',
      tipo: 'implementacion',
      criterios: [],
      requisitos: [],
      depende_de: [],
      escribe: ['src/ui/menu.ts'],
      lee: [],
      recursos_exclusivos: [],
      complejidad: 'baja',
      red: false,
      notas: '',
    } as const;
    const tree = ['src/cobranza/saldo.ts', 'src/inventario/stock.ts', 'src/ui/menu.ts'];
    const withFinder = graphSelection(
      graph,
      { ...task, criterios: [], requisitos: [], depende_de: [], escribe: [...task.escribe], lee: [], recursos_exclusivos: [] },
      { tareas: [], recursos_implicitos: {} } as never,
      tree,
      { finder },
    );
    expect(withFinder.find((f) => f.path === 'src/cobranza/saldo.ts')).toMatchObject({ confidence: 'posible', reason: expect.stringContaining('se parece a la tarea') });
  });
});
