import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreVault, Vault, VaultAuthError, VaultError, type VaultPaths, VaultRollbackError, vaultPaths } from '../../src/vault/vault.js';

const PASS = 'una clave larga de prueba';
const FAST = { logN: 14, r: 8, p: 1 };
let dir: string;
let paths: VaultPaths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-boveda-'));
  paths = vaultPaths(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const envelope = () => JSON.parse(readFileSync(paths.file, 'utf8')) as Record<string, any>;
const tamper = (fn: (e: Record<string, any>) => void) => {
  const e = envelope();
  fn(e);
  writeFileSync(paths.file, JSON.stringify(e));
};

describe('bóveda (V2-050)', () => {
  it('guarda cifrado: ni valores ni nombres aparecen en el archivo', () => {
    const v = Vault.create(paths, PASS, FAST);
    v.set('SMTP_CLAVE', 'valor-super-secreto-123');
    const raw = readFileSync(paths.file, 'utf8');
    expect(raw).not.toContain('valor-super-secreto-123');
    expect(raw).not.toContain('SMTP_CLAVE');
    expect(envelope()).toMatchObject({ format: 'forja-boveda', version: 1, kdf: { name: 'scrypt', logN: 14, r: 8, p: 1 } });
    expect(Vault.open(paths, PASS).get('SMTP_CLAVE')).toBe('valor-super-secreto-123');
  });

  it('clave incorrecta y archivo modificado dan el mismo error (no se distinguen)', () => {
    Vault.create(paths, PASS, FAST).set('A', 'x');
    expect(() => Vault.open(paths, 'otra clave distinta')).toThrow(VaultAuthError);
    tamper((e) => {
      const c = Buffer.from(e.ciphertext, 'base64');
      c[0]! ^= 1;
      e.ciphertext = c.toString('base64');
    });
    expect(() => Vault.open(paths, PASS)).toThrow(VaultAuthError);
  });

  it('la cabecera está autenticada: cambiar nonce, generación o salt se detecta', () => {
    Vault.create(paths, PASS, FAST).set('A', 'x');
    const good = readFileSync(paths.file, 'utf8');
    for (const mutate of [
      (e: Record<string, any>) => (e.generation += 5),
      (e: Record<string, any>) => (e.nonce = Buffer.alloc(12, 7).toString('base64')),
      (e: Record<string, any>) => (e.kdf.salt = Buffer.alloc(16, 1).toString('base64')),
    ]) {
      writeFileSync(paths.file, good);
      tamper(mutate);
      expect(() => Vault.open(paths, PASS)).toThrow(VaultAuthError);
    }
  });

  it('parámetros de KDF inflados se rechazan ANTES de derivar (sin agotar memoria)', () => {
    Vault.create(paths, PASS, FAST).set('A', 'x');
    const good = readFileSync(paths.file, 'utf8');
    for (const [k, v] of [
      ['logN', 30],
      ['logN', 5],
      ['r', 64],
      ['p', 1000],
    ] as const) {
      writeFileSync(paths.file, good);
      tamper((e) => (e.kdf[k] = v));
      const started = Date.now();
      expect(() => Vault.open(paths, PASS)).toThrow(/fuera de límites/);
      expect(Date.now() - started).toBeLessThan(500);
    }
    expect(() => Vault.create(vaultPaths(join(dir, 'b')), PASS, { logN: 22, r: 8, p: 1 })).toThrow(/fuera de límites/);
  });

  it('detecta que volvieron a poner una copia anterior (rollback)', () => {
    const v = Vault.create(paths, PASS, FAST);
    v.set('TOKEN', 'viejo');
    const old = join(dir, 'vieja.json');
    copyFileSync(paths.file, old);
    v.set('TOKEN', 'nuevo');
    copyFileSync(old, paths.file);
    expect(() => Vault.open(paths, PASS)).toThrow(VaultRollbackError);
    // Only with an explicit decision.
    expect(Vault.open(paths, PASS, { acceptRollback: true }).get('TOKEN')).toBe('viejo');
  });

  it('rotar un secreto conserva versiones anteriores para recuperación, con límite', () => {
    const v = Vault.create(paths, PASS, FAST);
    for (let i = 1; i <= 6; i++) v.set('API', `v${i}`);
    expect(v.get('API')).toBe('v6');
    expect(v.get('API', 3)).toBe('v3');
    expect(() => v.get('API', 1)).toThrow(/no tiene la versión 1/);
    expect(v.list()).toEqual([expect.objectContaining({ name: 'API', version: 6, previous_versions: 3 })]);
    expect(JSON.stringify(v.list())).not.toContain('v6');
    expect(() => v.set('1malo', 'x')).toThrow(/nombre inválido/);
    expect(() => v.set('VACIO', '')).toThrow(/vacío/);
  });

  it('borrar elimina los valores y deja constancia', () => {
    const v = Vault.create(paths, PASS, FAST);
    v.set('X', 'secreto-x');
    v.remove('X');
    expect(v.has('X')).toBe(false);
    expect(() => v.get('X')).toThrow(/no existe/);
    expect(Vault.open(paths, PASS).values()).not.toContain('secreto-x');
  });

  it('cambiar la clave vuelve a cifrar con salt nueva; la copia anterior abre con la clave vieja', () => {
    const v = Vault.create(paths, PASS, FAST);
    v.set('A', 'valor-a');
    const salt = envelope().kdf.salt;
    v.changePassphrase('otra clave también larga', FAST);
    expect(envelope().kdf.salt).not.toBe(salt);
    expect(() => Vault.open(paths, PASS)).toThrow(VaultAuthError);
    expect(Vault.open(paths, 'otra clave también larga').get('A')).toBe('valor-a');
    const backups = readdirSync(paths.backups).sort();
    const beforeChange = join(paths.backups, backups.at(-1)!);
    expect(Vault.verifyFile(beforeChange, PASS)).toMatchObject({ secrets: 1 });
    expect(() => v.changePassphrase('corta')).toThrow(/al menos 12/);
  });

  it('cerrada no permite operar; también se cierra sola por inactividad', () => {
    const v = Vault.create(paths, PASS, FAST);
    v.set('A', 'x');
    v.close();
    expect(v.isOpen).toBe(false);
    expect(() => v.get('A')).toThrow(/cerrada/);
    let now = 0;
    const idle = Vault.open(paths, PASS, { idleMs: 1000, now: () => now });
    expect(idle.get('A')).toBe('x');
    now = 1500;
    expect(() => idle.get('A')).toThrow(/cerrada/);
  });

  it('restaurar exige una copia que abra con la clave y aparta la actual sin borrarla', () => {
    const v = Vault.create(paths, PASS, FAST);
    v.set('A', 'uno');
    const copy = join(dir, 'copia.json');
    copyFileSync(paths.file, copy);
    v.set('A', 'dos');
    expect(() => restoreVault(paths, copy, 'clave equivocada!!')).toThrow(VaultAuthError);
    const r = restoreVault(paths, copy, PASS);
    expect(existsSync(r.previous!)).toBe(true);
    // The watermark accepts the restored generation: no rollback error.
    expect(Vault.open(paths, PASS).get('A')).toBe('uno');
  });

  it('no se crea con clave corta ni sobre una existente', () => {
    expect(() => Vault.create(paths, 'corta', FAST)).toThrow(VaultError);
    Vault.create(paths, PASS, FAST);
    expect(() => Vault.create(paths, PASS, FAST)).toThrow(/ya existe/);
  });
});

describe('llavero del sistema (MEJORAS 4.3)', () => {
  it('secret-tool: guarda por stdin, lee y borra; el secreto nunca va en los argumentos', async () => {
    const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SecretToolKeyring, MacKeychain, vaultAccount } = await import('../../src/vault/keyring.js');
    const { vaultPassphrase } = await import('../../src/cli/secret-input.js');
    const dir = mkdtempSync(join(tmpdir(), 'forja-llavero-'));
    try {
      const store = join(dir, 'guardado');
      const argsLog = join(dir, 'args');
      const fake = join(dir, 'secret-tool');
      writeFileSync(
        fake,
        `#!/bin/sh\necho "$@" >> ${argsLog}\ncase "$1" in\n  store) cat > ${store} ;;\n  lookup) [ -f ${store} ] && cat ${store} || exit 1 ;;\n  clear) [ -f ${store} ] && rm ${store} || exit 1 ;;\nesac\n`,
      );
      chmodSync(fake, 0o755);
      const k = new SecretToolKeyring(fake);
      expect(k.get('cuenta')).toBeNull();
      k.set('cuenta', 'clave muy secreta 123');
      expect(k.get('cuenta')).toBe('clave muy secreta 123');
      expect(readFileSync(argsLog, 'utf8')).not.toContain('secreta');
      const home = join(dir, 'home');
      const acct = vaultAccount(join(home, 'boveda', 'boveda.json'));
      expect(acct).toMatch(/^boveda-[0-9a-f]{16}$/);
      // Without the env var, the passphrase comes from the keyring instead of a prompt.
      const fromKeyring = await vaultPassphrase('x', { FORJA_HOME: home }, { id: 'falso', get: () => 'desde-llavero', set: () => {}, delete: () => true });
      expect(fromKeyring).toBe('desde-llavero');
      expect(await vaultPassphrase('x', { FORJA_HOME: home, FORJA_BOVEDA_CLAVE: 'env' }, { id: 'falso', get: () => 'desde-llavero', set: () => {}, delete: () => true })).toBe('env');
      expect(k.delete('cuenta')).toBe(true);
      expect(k.get('cuenta')).toBeNull();

      const calls: { args: string[]; input: string | undefined }[] = [];
      const mac = new MacKeychain((_cmd, args, input) => {
        calls.push({ args, input });
        return { status: 0, stdout: 'valor\n' };
      });
      mac.set('cuenta', 'clave "rara"');
      expect(calls[0]!.args).toEqual(['-i']);
      expect(calls[0]!.input).toContain('-w "clave \\"rara\\""');
      expect(mac.get('cuenta')).toBe('valor');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('purgar copias viejas (MEJORAS 4.9)', () => {
  it('conserva las N generaciones más recientes y borra el resto, incluidos valores ya borrados', async () => {
    const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { purgeBackups, Vault, vaultPaths } = await import('../../src/vault/vault.js');
    const dir = mkdtempSync(join(tmpdir(), 'forja-purga-'));
    try {
      const paths = vaultPaths(dir);
      const v = Vault.create(paths, 'una clave bastante larga', { logN: 14, r: 8, p: 1 });
      v.set('TOKEN', 'valor-viejo-1');
      v.set('TOKEN', 'valor-viejo-2');
      v.remove('TOKEN');
      v.set('OTRO', 'x');
      v.close();
      const before = readdirSync(paths.backups).sort();
      expect(before.length).toBeGreaterThanOrEqual(4);
      const r = purgeBackups(paths, 1);
      expect(r.kept).toHaveLength(1);
      expect(r.removed).toHaveLength(before.length - 1);
      expect(readdirSync(paths.backups)).toEqual(r.kept);
      expect(existsSync(paths.file)).toBe(true);
      expect(() => purgeBackups(paths, -1)).toThrow(/entero/);
      // The kept one is the newest generation.
      const gen = (f: string) => Number(/gen(\d+)/.exec(f)![1]);
      expect(gen(r.kept[0]!)).toBe(Math.max(...before.map(gen)));
      expect(readFileSync(paths.file, 'utf8')).not.toContain('valor-viejo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
