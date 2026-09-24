#!/usr/bin/env node
import { LockHeldError } from '../registry/lock.js';
import { runLaunch } from './runner.js';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('uso: runner-main.js <carpeta-del-lanzamiento>\n');
  process.exit(2);
}

try {
  const result = await runLaunch(dir);
  process.exit(result.status === 'error_inicio' ? 1 : 0);
} catch (error) {
  // Another runner already owns this launch: not an error, the order is served.
  if (error instanceof LockHeldError) process.exit(0);
  process.stderr.write(`runner: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
}
