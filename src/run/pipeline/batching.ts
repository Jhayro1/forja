/**
 * Speculative batch integration (MEJORAS 7): several verified tasks are merged
 * and checked together once; only when that fails is the batch split in halves
 * until the culprit is integrated alone, where the serial path attributes the
 * failure to it. With k tasks and no failures: 1 check instead of k.
 *
 * `tryBatch` returns:
 *  - «integrado»: the whole batch was published;
 *  - «fallo»: the combined check failed (bisect);
 *  - «serie»: the batch could not be tried as such (conflict, a moved ref,
 *    an already contained candidate): each task goes through the serial path.
 */
export type BatchOutcome = 'integrado' | 'fallo' | 'serie';

export async function integrateBisecting(ids: readonly string[], tryBatch: (ids: string[]) => Promise<BatchOutcome>, one: (id: string) => Promise<void>): Promise<void> {
  if (ids.length === 0) return;
  if (ids.length === 1) return one(ids[0]!);
  const outcome = await tryBatch([...ids]);
  if (outcome === 'integrado') return;
  if (outcome === 'serie') {
    for (const id of ids) await one(id);
    return;
  }
  // The left half goes first; the right half is then tried on the new tip.
  const mid = Math.ceil(ids.length / 2);
  await integrateBisecting(ids.slice(0, mid), tryBatch, one);
  await integrateBisecting(ids.slice(mid), tryBatch, one);
}
