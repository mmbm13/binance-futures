/** One minute of signed aggressive volume (buy − sell). */
export interface CvdBucket {
  minuteTs: number;
  delta: number;
}

/**
 * Rolling CVD from aggTrade events. `m === true` → seller was aggressor (negative delta).
 * Keeps the last `windowMinutes` buckets.
 */
export class CvdAccumulator {
  private buckets = new Map<number, number>();

  constructor(private readonly windowMinutes = 15) {}

  onTrade(price: number, qty: number, buyerIsMaker: boolean): void {
    if (price <= 0 || qty <= 0) return;
    const minuteTs = Math.floor(Date.now() / 60_000) * 60_000;
    const signed = buyerIsMaker ? -qty : qty;
    this.buckets.set(minuteTs, (this.buckets.get(minuteTs) ?? 0) + signed);
    this.prune(minuteTs);
  }

  /** Net delta over the last `minutes` full minute buckets (default 1). */
  deltaLastMinutes(minutes = 1, now = Date.now()): number {
    const currentMinute = Math.floor(now / 60_000) * 60_000;
    let sum = 0;
    for (let i = 0; i < minutes; i++) {
      sum += this.buckets.get(currentMinute - i * 60_000) ?? 0;
    }
    return sum;
  }

  toJSON(): CvdBucket[] {
    return [...this.buckets.entries()]
      .map(([minuteTs, delta]) => ({ minuteTs, delta }))
      .sort((a, b) => a.minuteTs - b.minuteTs);
  }

  restore(data: CvdBucket[]): void {
    this.buckets.clear();
    for (const b of data) this.buckets.set(b.minuteTs, b.delta);
  }

  private prune(currentMinute: number): void {
    const cutoff = currentMinute - this.windowMinutes * 60_000;
    for (const ts of [...this.buckets.keys()]) {
      if (ts < cutoff) this.buckets.delete(ts);
    }
  }
}
