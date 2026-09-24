import { parseClaudeLine } from './claude-parser.js';
import { CodexParser } from './codex-parser.js';
import { JsonLineSplitter } from './lines.js';
import type { ProviderEvent } from './normalized.js';

export type ProviderKind = 'claude' | 'codex';

/** Turns raw stdout chunks into normalized events, whatever the chunk boundaries. */
export async function* parseProviderStream(kind: ProviderKind, chunks: AsyncIterable<string>): AsyncGenerator<ProviderEvent> {
  const splitter = new JsonLineSplitter();
  const codex = new CodexParser();
  const map = (entry: { value: unknown } | { invalid: string }): ProviderEvent[] => {
    if ('invalid' in entry) return [{ t: 'desconocido', rawType: 'linea_invalida' }];
    return kind === 'claude' ? parseClaudeLine(entry.value) : codex.parseLine(entry.value);
  };
  for await (const chunk of chunks) {
    for (const entry of splitter.push(chunk)) yield* map(entry);
  }
  for (const entry of splitter.end()) yield* map(entry);
}
