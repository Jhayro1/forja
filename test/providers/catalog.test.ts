import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter, CodexAdapter, type LaunchParams } from '../../src/providers/adapters.js';
import { catalogModel, EFFORTS, effortFor, MODEL_CATALOG } from '../../src/providers/catalog.js';
import { ForjaConfig } from '../../src/registry/config.js';

describe('catálogo de modelos', () => {
  it('cada modelo es un proveedor:modelo válido para forja.yaml y sin repetidos', () => {
    const refs = MODEL_CATALOG.map((m) => m.ref);
    expect(new Set(refs).size).toBe(refs.length);
    const base = { schema_version: 1, project_id: 'prj_01HZZZZZZZZZZZZZZZZZZZZZZZ', nombre: 'x' };
    for (const ref of refs) {
      const r = ForjaConfig.safeParse({ ...base, roles: { planeador: [ref] } });
      expect(r.success, ref).toBe(true);
    }
    for (const m of MODEL_CATALOG) for (const e of m.efforts) expect(EFFORTS).toContain(e);
  });

  it('ajusta el esfuerzo del rol al más alto que acepta el modelo', () => {
    expect(effortFor('codex:gpt-6-sol', 'ultra')).toBe('ultra');
    expect(effortFor('codex:gpt-6-luna', 'ultra')).toBe('max');
    expect(effortFor('claude:opus', 'ultra')).toBe('max');
    expect(effortFor('claude:claude-sonnet-4-6', 'xhigh')).toBe('high');
    expect(effortFor('claude:haiku', 'high')).toBeUndefined();
    expect(effortFor('claude:opus', undefined)).toBeUndefined();
    // Fuera del catálogo decide el CLI; el simulado no recibe esfuerzo.
    expect(effortFor('claude:claude-futuro-9', 'high')).toBe('high');
    expect(effortFor('simulado:rapido', 'high')).toBeUndefined();
    expect(catalogModel('codex:gpt-5.5')?.retires).toBe('2026-10-14');
  });
});

describe('los adaptadores pasan el esfuerzo a cada CLI', () => {
  let dir = '';
  const prev = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-esfuerzo-'));
    writeFileSync(join(dir, '.credentials.json'), '{}');
    writeFileSync(join(dir, 'auth.json'), '{}');
    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.CODEX_HOME = dir;
  });
  afterEach(() => {
    for (const [k, v] of [
      ['CLAUDE_CONFIG_DIR', prev.claude],
      ['CODEX_HOME', prev.codex],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const params = (extra: Partial<LaunchParams>): LaunchParams => ({
    launchId: 'lan_1',
    fencingToken: 1,
    runId: 'run',
    taskId: 'T-1',
    attempt: 1,
    model: 'opus',
    prompt: 'hola',
    workspace: dir,
    providerStateDir: join(dir, 'estado'),
    inputsDir: join(dir, 'entrada'),
    tools: 'lectura',
    timeoutMs: 1000,
    ...extra,
  });

  it('Claude: --effort sólo si el rol lo pide', () => {
    const a = new ClaudeAdapter('/usr/bin/true');
    const argv = a.buildOrder(params({ model: 'sonnet[1m]', effort: 'xhigh' })).argv;
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'sonnet[1m]']);
    expect(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2)).toEqual(['--effort', 'xhigh']);
    expect(a.buildOrder(params({})).argv).not.toContain('--effort');
  });

  it('Codex: model_reasoning_effort por -c, también al reanudar', () => {
    const a = new CodexAdapter('/usr/bin/true');
    const argv = a.buildOrder(params({ model: 'gpt-6-sol', effort: 'ultra' })).argv;
    expect(argv).toContain('model_reasoning_effort="ultra"');
    expect(a.buildOrder(params({ model: 'gpt-6-sol', effort: 'low', resumeSessionId: 'ses' })).argv).toContain('model_reasoning_effort="low"');
    expect(a.buildOrder(params({ model: 'gpt-6-sol' })).argv.join(' ')).not.toContain('model_reasoning_effort');
  });
});
