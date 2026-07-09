import { roundStep } from '../../bot/math';

export type LiqSide = 'BUY' | 'SELL';
export type CascadeDirection = 'bearish' | 'bullish';
export type TradeSide = 'LONG' | 'SHORT';

export interface LiqEvent {
  ts: number;
  side: LiqSide;
  notional: number;
  price: number;
}

export interface PricePoint {
  ts: number;
  price: number;
}

/** Percentile with linear interpolation (p in 0..1). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function notionalInWindow(
  events: LiqEvent[],
  side: LiqSide,
  now: number,
  windowSec: number
): number {
  const cutoff = now - windowSec * 1000;
  return events
    .filter((e) => e.side === side && e.ts >= cutoff)
    .reduce((s, e) => s + e.notional, 0);
}

export function pruneEvents(events: LiqEvent[], now: number, windowSec: number): LiqEvent[] {
  const cutoff = now - windowSec * 1000;
  return events.filter((e) => e.ts >= cutoff);
}

/** Price change over the window (current − oldest sample in window). */
export function priceChangeOverWindow(history: PricePoint[], now: number, windowSec: number): number | null {
  const cutoff = now - windowSec * 1000;
  const inWindow = history.filter((p) => p.ts >= cutoff);
  if (inWindow.length < 2) return null;
  const oldest = inWindow[0];
  const latest = inWindow[inWindow.length - 1];
  return latest.price - oldest.price;
}

export interface CascadeDetectInput {
  sellNotional60s: number;
  buyNotional60s: number;
  priceChange60s: number | null;
  atr1m: number;
  sellThreshold: number;
  buyThreshold: number;
  priceMoveAtrMult: number;
}

export interface CascadeDetectResult {
  direction: CascadeDirection;
  tradeSide: TradeSide;
  liqSide: LiqSide;
}

/** Detect bearish (long liqs → fade with LONG) or bullish cascade. */
export function detectCascade(input: CascadeDetectInput): CascadeDetectResult | null {
  const { sellNotional60s, buyNotional60s, priceChange60s, atr1m, sellThreshold, buyThreshold, priceMoveAtrMult } =
    input;
  if (atr1m <= 0 || priceChange60s === null) return null;

  const move = priceMoveAtrMult * atr1m;

  if (sellNotional60s > sellThreshold && priceChange60s <= -move) {
    return { direction: 'bearish', tradeSide: 'LONG', liqSide: 'SELL' };
  }
  if (buyNotional60s > buyThreshold && priceChange60s >= move) {
    return { direction: 'bullish', tradeSide: 'SHORT', liqSide: 'BUY' };
  }
  return null;
}

export interface ArmedCascade {
  direction: CascadeDirection;
  tradeSide: TradeSide;
  liqSide: LiqSide;
  cascadeStartPrice: number;
  cascadeExtreme: number;
  armedAt: number;
  lastLiqAt: number;
  lastExtremeAt: number;
  cvdAtArm: number;
}

export function createArmedCascade(
  detected: CascadeDetectResult,
  currentPrice: number,
  cascadeStartPrice: number,
  cvd1m: number,
  now: number
): ArmedCascade {
  const cascadeExtreme =
    detected.direction === 'bearish'
      ? Math.min(currentPrice, cascadeStartPrice)
      : Math.max(currentPrice, cascadeStartPrice);
  return {
    direction: detected.direction,
    tradeSide: detected.tradeSide,
    liqSide: detected.liqSide,
    cascadeStartPrice,
    cascadeExtreme,
    armedAt: now,
    lastLiqAt: now,
    lastExtremeAt: now,
    cvdAtArm: cvd1m,
  };
}

/** Update armed state when new cascade-side liquidations arrive. */
export function refreshArmedOnLiq(armed: ArmedCascade, price: number, now: number): ArmedCascade {
  const next = { ...armed, lastLiqAt: now };
  if (armed.direction === 'bearish') {
    if (price < armed.cascadeExtreme) {
      next.cascadeExtreme = price;
      next.lastExtremeAt = now;
    }
  } else if (price > armed.cascadeExtreme) {
    next.cascadeExtreme = price;
    next.lastExtremeAt = now;
  }
  return next;
}

export interface ExhaustInput {
  armed: ArmedCascade;
  now: number;
  price: number;
  cvd1m: number;
  exhaustSec: number;
}

/** True when liquidation flow stopped, price stabilized, and CVD flipped. */
export function isCascadeExhausted(input: ExhaustInput): boolean {
  const { armed, now, price, cvd1m, exhaustSec } = input;
  if (now - armed.lastLiqAt < exhaustSec * 1000) return false;

  const noNewExtreme =
    armed.direction === 'bearish'
      ? price >= armed.cascadeExtreme
      : price <= armed.cascadeExtreme;
  if (!noNewExtreme) return false;

  if (armed.direction === 'bearish') {
    return cvd1m > 0 && armed.cvdAtArm <= 0;
  }
  return cvd1m < 0 && armed.cvdAtArm >= 0;
}

export function computeLiqRevStops(
  tradeSide: TradeSide,
  entry: number,
  cascadeStart: number,
  cascadeExtreme: number,
  atr1m: number,
  slBufferAtr: number,
  tpRetrace: number,
  tickSize: number
): { sl: number; tp: number } {
  const buffer = slBufferAtr * atr1m;
  const range = Math.abs(cascadeStart - cascadeExtreme);

  if (tradeSide === 'LONG') {
    const sl = Math.max(tickSize, roundStep(cascadeExtreme - buffer, tickSize));
    const tp = roundStep(entry + tpRetrace * range, tickSize);
    return { sl, tp };
  }
  const sl = roundStep(cascadeExtreme + buffer, tickSize);
  const tp = Math.max(tickSize, roundStep(entry - tpRetrace * range, tickSize));
  return { sl, tp };
}

/** Rolling history of completed 60s liquidation notionals per side. */
export class LiqWindowHistory {
  private sellWindows: number[] = [];
  private buyWindows: number[] = [];

  constructor(private readonly maxWindows: number) {}

  push(sellTotal: number, buyTotal: number): void {
    this.sellWindows.push(sellTotal);
    this.buyWindows.push(buyTotal);
    if (this.sellWindows.length > this.maxWindows) this.sellWindows.shift();
    if (this.buyWindows.length > this.maxWindows) this.buyWindows.shift();
  }

  threshold(side: LiqSide, p: number, minNotional: number): number {
    const arr = side === 'SELL' ? this.sellWindows : this.buyWindows;
    if (arr.length < 10) return minNotional;
    return Math.max(minNotional, percentile(arr, p));
  }

  toJSON() {
    return { sellWindows: this.sellWindows, buyWindows: this.buyWindows };
  }

  restore(data: { sellWindows?: number[]; buyWindows?: number[] }): void {
    this.sellWindows = data.sellWindows ?? [];
    this.buyWindows = data.buyWindows ?? [];
  }
}
