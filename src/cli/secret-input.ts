import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { forjaHome } from '../registry/home.js';
import { type Keyring, systemKeyring, vaultAccount } from '../vault/keyring.js';
import { vaultPaths } from '../vault/vault.js';

/**
 * Reads a secret without echo on a terminal, or one line from stdin when piped.
 * Secrets are never accepted as command-line arguments (shell history, `ps`).
 */
export async function readSecret(label: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    const rl = createInterface({ input, terminal: false });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    return '';
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, done) {
      if (!muted) process.stderr.write(chunk as Buffer);
      done();
    },
  });
  const rl = createInterface({ input, output, terminal: true });
  const answer = await new Promise<string>((resolve) => {
    rl.question(label, resolve);
    muted = true;
  });
  rl.close();
  process.stderr.write('\n');
  return answer;
}

/**
 * Vault passphrase: FORJA_BOVEDA_CLAVE (scripts; visible to your other
 * processes), else the system keyring if you saved it there (forja boveda
 * llavero guardar), else a hidden prompt.
 */
export async function vaultPassphrase(label = 'Clave de la bóveda: ', env: NodeJS.ProcessEnv = process.env, keyring: Keyring | null = systemKeyring()): Promise<string> {
  if (env.FORJA_BOVEDA_CLAVE) return env.FORJA_BOVEDA_CLAVE;
  const saved = keyring?.get(vaultAccount(vaultPaths(forjaHome(env)).file));
  return saved ?? (await readSecret(label));
}

/** Yes/no question on an interactive terminal; `false` when there is no TTY (scripts never block). */
export async function confirm(question: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) return false;
  const rl = createInterface({ input, output, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [s/N] `, resolve));
    return /^(s|si|sí|y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
