import { describe, expect, it } from 'vitest';
import { buildAgentEnv } from '../../src/security/env.js';
import { intersectPolicy, RuntimePolicy } from '../../src/security/policy.js';
import { Redactor } from '../../src/security/redact.js';

const CANARY = 'canario-7731-super-secreto';

describe('redacción', () => {
  it('reemplaza valores conocidos y sus variantes base64 y url', () => {
    const r = new Redactor([{ name: 'cf.token', value: CANARY }]);
    const b64 = Buffer.from(CANARY).toString('base64');
    expect(r.redact(`a ${CANARY} b ${b64} c ${encodeURIComponent(CANARY)}`)).toBe('a «secreto:cf.token» b «secreto:cf.token» c «secreto:cf.token»');
  });

  it('reconoce formas típicas de credenciales aunque no las conozca', () => {
    const r = new Redactor();
    const text = 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 y sk-ant-api03-abcdefghijklmnopqrstuv y Authorization: Bearer abcdefghijklmnopqrstuvwxyz123';
    const out = r.redact(text);
    expect(out).not.toMatch(/ghp_|sk-ant-|abcdefghijklmnopqrstuvwxyz123/);
    expect(out).toContain('Bearer «secreto»');
    expect(r.containsSecret(text)).toBe(true);
    expect(r.containsSecret('texto normal')).toBe(false);
  });

  it('ignora valores demasiado cortos para no destrozar el texto', () => {
    expect(new Redactor([{ name: 'x', value: 'abc' }]).redact('abc abc')).toBe('abc abc');
  });

  it('en streaming detecta un secreto partido entre chunks', () => {
    const r = new Redactor([{ name: 'k', value: CANARY }]);
    const s = r.stream();
    const input = `${'x'.repeat(5000)}\nlinea con ${CANARY} al medio\n${'y'.repeat(5000)}\n`;
    let out = '';
    for (let i = 0; i < input.length; i += 13) out += s.push(input.slice(i, i + 13));
    out += s.end();
    expect(out).not.toContain(CANARY);
    expect(out).toContain('«secreto:k»');
    expect(out.length).toBe(input.length - CANARY.length + '«secreto:k»'.length);
  });
});

describe('entorno de agentes', () => {
  const parent = {
    PATH: '/usr/bin',
    LANG: 'es_PE.UTF-8',
    LC_ALL: 'C',
    HOME: '/root',
    CLAUDE_CODE_MESSAGING_TOKEN: 'x',
    GITHUB_TOKEN: 'x',
    SSH_AUTH_SOCK: '/tmp/ssh',
    AWS_SECRET_ACCESS_KEY: 'x',
    RANDOM_VAR: 'x',
  };

  it('sólo pasa la lista positiva y reemplaza HOME y TMPDIR', () => {
    expect(buildAgentEnv(parent, { home: '/sbx/home', tmpdir: '/sbx/tmp' })).toEqual({
      PATH: '/usr/bin',
      LANG: 'es_PE.UTF-8',
      LC_ALL: 'C',
      HOME: '/sbx/home',
      TMPDIR: '/sbx/tmp',
    });
  });

  it('no deja pedir variables con forma de credencial', () => {
    expect(() => buildAgentEnv(parent, { home: '/h', tmpdir: '/t', extra: { NPM_TOKEN: 'x' } })).toThrow(/credencial/);
    expect(buildAgentEnv(parent, { home: '/h', tmpdir: '/t', extra: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } })).toHaveProperty('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', '1');
  });
});

describe('política', () => {
  const approved = RuntimePolicy.parse({
    network: { mode: 'lista', hosts: ['registry.npmjs.org'] },
    tools: ['Read', 'Edit', 'Bash'],
    write_globs: ['src/**', 'test/**'],
    protected_paths: ['test/aceptacion/**'],
    timeout_ms: 600_000,
  });

  it('el repo no puede ampliar su propio sandbox', () => {
    const requested = RuntimePolicy.parse({
      network: { mode: 'lista', hosts: ['registry.npmjs.org', 'evil.example.com'] },
      tools: ['Read', 'Edit', 'Bash', 'WebFetch'],
      write_globs: ['src/**', '**'],
      timeout_ms: 9_000_000,
      max_memory_mb: 99_999,
    });
    const effective = intersectPolicy(requested, approved);
    expect(effective).toEqual({
      network: { mode: 'lista', hosts: ['registry.npmjs.org'] },
      tools: ['Read', 'Edit', 'Bash'],
      write_globs: ['src/**'],
      protected_paths: ['test/aceptacion/**'],
      timeout_ms: 600_000,
      max_memory_mb: 2048,
    });
  });

  it('pedir red cuando lo aprobado es sin red da sin red', () => {
    const effective = intersectPolicy({ ...approved, network: { mode: 'lista', hosts: ['registry.npmjs.org'] } }, { ...approved, network: { mode: 'ninguna' } });
    expect(effective.network).toEqual({ mode: 'ninguna' });
  });
});

describe('redacción en streaming: casos límite', () => {
  it('una línea gigante sin saltos se corta sin partir un secreto conocido', () => {
    const r = new Redactor([{ name: 'k', value: CANARY }]);
    const s = r.stream(); // maxHold por defecto: 64 KiB
    const input = `${'x'.repeat(70_000)}${CANARY}${'y'.repeat(70_000)}`;
    let out = '';
    for (let i = 0; i < input.length; i += 997) out += s.push(input.slice(i, i + 997));
    out += s.end();
    expect(out).not.toContain(CANARY);
  });

  it('retiene un bloque de llave privada hasta su línea END', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQUJDREVGR0hJSktMTU5PUFFS\n-----END OPENSSH PRIVATE KEY-----\n';
    const s = new Redactor().stream();
    let out = '';
    for (const line of `antes\n${key}despues\n`.split(/(?<=\n)/)) out += s.push(line);
    out += s.end();
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    expect(out).toContain('antes\n«secreto:llave_privada»');
  });
});
