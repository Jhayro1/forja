import { readFileSync } from 'node:fs';

export type SimulationFaults = {
  /** Size of each emitted chunk; small values exercise lines split across chunks. */
  chunkSize?: number;
  /** Stop after this many bytes, as if the process died mid-output. */
  cutAtByte?: number;
  /** Drop every line whose `type` matches, e.g. `result` to simulate an exit without result. */
  dropTypes?: string[];
  /** Emit every line twice, to test deduplication of repeated events. */
  duplicateLines?: boolean;
  delayMs?: number;
};

/**
 * Replays a recorded provider output (m0/fixtures) with injectable faults, so the
 * core can be tested without paid calls (V2-013).
 */
export async function* simulateProviderOutput(fixturePath: string, faults: SimulationFaults = {}): AsyncGenerator<string> {
  let lines = readFileSync(fixturePath, 'utf8').split('\n').filter(Boolean);
  if (faults.dropTypes?.length) {
    lines = lines.filter((l) => {
      try {
        return !faults.dropTypes!.includes((JSON.parse(l) as { type?: string }).type ?? '');
      } catch {
        return true;
      }
    });
  }
  if (faults.duplicateLines) lines = lines.flatMap((l) => [l, l]);
  let text = lines.map((l) => `${l}\n`).join('');
  if (faults.cutAtByte !== undefined) text = text.slice(0, faults.cutAtByte);
  const size = Math.max(1, faults.chunkSize ?? 4096);
  for (let i = 0; i < text.length; i += size) {
    if (faults.delayMs) await new Promise((r) => setTimeout(r, faults.delayMs));
    yield text.slice(i, i + size);
  }
}
