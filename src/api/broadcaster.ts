import type { EventFeed } from './server.js';

export type FeedEvent = ReturnType<EventFeed['after']>[number];

/**
 * One poll of the event store for every open SSE connection (MEJORAS 3.5): the
 * broadcaster reads new events once per tick and hands them to each subscriber.
 * It only polls while someone listens.
 */
export class FeedBroadcaster {
  private readonly subscribers = new Set<(events: FeedEvent[]) => void>();
  private cursor: number;
  private timer: NodeJS.Timeout | null = null;
  reads = 0;

  constructor(
    private readonly feed: EventFeed,
    private readonly pollMs = 500,
  ) {
    this.cursor = feed.lastSeq();
  }

  subscribe(cb: (events: FeedEvent[]) => void): () => void {
    this.subscribers.add(cb);
    this.timer ??= setInterval(() => this.tick(), this.pollMs);
    return () => {
      this.subscribers.delete(cb);
      if (this.subscribers.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  /** Reads what is new once and delivers it to every subscriber. */
  tick(): void {
    for (;;) {
      const batch = this.feed.after(this.cursor, 500);
      this.reads++;
      if (batch.length === 0) return;
      this.cursor = batch.at(-1)!.seq;
      for (const cb of this.subscribers) cb(batch);
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.subscribers.clear();
  }
}
