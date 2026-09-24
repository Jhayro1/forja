import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Last `count` complete lines of a text file, reading at most `maxBytes` from its end. */
export function readTailLines(path: string, count: number, maxBytes = 256 * 1024): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
}
