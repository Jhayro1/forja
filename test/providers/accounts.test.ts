import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountStore, accountPauseKey, chooseAccount, PRINCIPAL } from '../../src/providers/accounts.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'forja-cuentas-'));
  const home = join(root, 'forja');
  const env = { CLAUDE_CONFIG_DIR: join(root, 'claude-default'), CODEX_HOME: join(root, 'codex-default') };
  return { home, env, store: new AccountStore(home, env) };
}

const signIn = (store: AccountStore, provider: 'claude' | 'codex', alias: string) => {
  const file = store.credentialFile(provider, alias);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '{}');
};

describe('cuentas por proveedor', () => {
  it('siempre hay una cuenta principal que usa la carpeta por defecto del CLI', () => {
    const { store, env } = setup();
    const claude = store.list('claude');
    expect(claude).toHaveLength(1);
    expect(claude[0]).toMatchObject({ alias: PRINCIPAL, principal: true, activa: true });
    expect(store.configDir('claude', PRINCIPAL)).toBe(env.CLAUDE_CONFIG_DIR);
    expect(store.credentialFile('codex', PRINCIPAL)).toBe(join(env.CODEX_HOME, 'auth.json'));
  });

  it('agrega, actualiza y elimina cuentas extra con su propia carpeta', () => {
    const { store, home } = setup();
    store.add('claude', 'trabajo');
    expect(store.configDir('claude', 'trabajo')).toBe(join(home, 'cuentas', 'claude', 'trabajo'));
    expect(store.envFor('claude', 'trabajo')).toEqual({ CLAUDE_CONFIG_DIR: join(home, 'cuentas', 'claude', 'trabajo') });
    expect(() => store.add('claude', 'trabajo')).toThrow(/ya existe/);
    expect(() => store.add('claude', 'Mal Alias')).toThrow();
    expect(() => store.add('claude', PRINCIPAL)).toThrow();
    store.update('claude', 'trabajo', { activa: false, max_agentes: 2 });
    expect(store.get('claude', 'trabajo')).toMatchObject({ activa: false, max_agentes: 2 });
    expect(() => store.remove('claude', PRINCIPAL)).toThrow(/principal/);
    store.remove('claude', 'trabajo');
    expect(store.list('claude').map((a) => a.alias)).toEqual([PRINCIPAL]);
  });

  it('reparte a la cuenta con sesión, activa, sin pausa y menos ocupada', () => {
    const { store } = setup();
    store.add('codex', 'b');
    store.add('codex', 'c');
    signIn(store, 'codex', PRINCIPAL);
    signIn(store, 'codex', 'b');
    // «c» no tiene sesión: nunca se elige.
    const busy: Record<string, number> = { principal: 2, b: 1, c: 0 };
    const pick = (paused: string[] = []) => chooseAccount(store, 'codex', { paused: (k) => paused.includes(k), running: (a) => busy[a] ?? 0 });
    expect(pick()?.alias).toBe('b');
    expect(pick([accountPauseKey('codex', 'b')])?.alias).toBe(PRINCIPAL);
    expect(pick([accountPauseKey('codex', 'b'), accountPauseKey('codex', PRINCIPAL)])).toBeNull();
    store.update('codex', 'b', { max_agentes: 1 });
    expect(pick()?.alias).toBe(PRINCIPAL);
    store.update('codex', PRINCIPAL, { activa: false });
    expect(pick()).toBeNull();
  });

  it('la pausa de la principal conserva la clave de siempre', () => {
    expect(accountPauseKey('claude', PRINCIPAL)).toBe('claude');
    expect(accountPauseKey('claude', null)).toBe('claude');
    expect(accountPauseKey('claude', 'dos')).toBe('claude@dos');
  });
});
