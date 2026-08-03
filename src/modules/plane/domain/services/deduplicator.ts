export class Deduplicator {
  private recentEvents = new Map<string, number>();

  constructor(private ttlMs = 10_000) {}

  isDuplicate(key: string): boolean {
    const now = Date.now();
    for (const [k, ts] of this.recentEvents) {
      if (now - ts > this.ttlMs) this.recentEvents.delete(k);
    }
    if (this.recentEvents.has(key)) return true;
    this.recentEvents.set(key, now);
    return false;
  }
}
