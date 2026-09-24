#!/usr/bin/env node
/**
 * Entry point of the `forja` binary (MEJORAS 3.10). It hides only Node's
 * «SQLite is experimental» warning and keeps every other warning visible,
 * without `env -S` in the shebang (not available on BusyBox/Alpine). The CLI is
 * imported dynamically so the filter is in place before node:sqlite loads.
 * Remove this file when node:sqlite is stable.
 */
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});
await import('./main.js');
