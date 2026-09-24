import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

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

/** Vault passphrase: FORJA_BOVEDA_CLAVE (scripts; visible to your other processes) or a hidden prompt. */
export async function vaultPassphrase(label = 'Clave de la bóveda: ', env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return env.FORJA_BOVEDA_CLAVE ?? (await readSecret(label));
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
