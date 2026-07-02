import { MIN_LADDER_SPACING_PCT, MAX_LADDER_SPACING_PCT } from '../config';
import { LadderState } from '../types';
import { Wall } from '../orderbook';
import { roundStep } from '../math';

export function activeEntrySide(side: 'LONG' | 'SHORT'): 'BUY' | 'SELL' {
  return side === 'LONG' ? 'BUY' : 'SELL';
}

export function wallMeetsSpacing(
  wallPrice: number,
  side: 'LONG' | 'SHORT',
  refPrices: number[],
  minSpacingPct: number = MIN_LADDER_SPACING_PCT
): boolean {
  for (const ref of refPrices) {
    if (side === 'LONG') {
      if (wallPrice > ref * (1 - minSpacingPct)) return false;
    } else {
      if (wallPrice < ref * (1 + minSpacingPct)) return false;
    }
  }
  return true;
}

export function getLastLadderRefPrice(l: LadderState): number {
  const entrySide = activeEntrySide(l.side!);
  const prices = l.entryOrders.filter((o) => o.side === entrySide).map((o) => o.price);
  if (prices.length) return l.side === 'LONG' ? Math.min(...prices) : Math.max(...prices);
  return l.entryPrice;
}

export function resolveNextLadderPrice(
  walls: Wall[],
  side: 'LONG' | 'SHORT',
  refPrices: number[],
  lastRefPrice: number,
  usedPrices: number[],
  tickSize: number,
  minSpacingPct: number = MIN_LADDER_SPACING_PCT,
  maxSpacingPct: number = MAX_LADDER_SPACING_PCT
): { price: number; source: 'wall' | 'pct' } {
  let bandMin: number;
  let bandMax: number;
  let pctPrice: number;

  if (side === 'LONG') {
    bandMin = lastRefPrice * (1 - maxSpacingPct);
    bandMax = lastRefPrice * (1 - minSpacingPct);
    pctPrice = lastRefPrice * (1 - maxSpacingPct);
  } else {
    bandMin = lastRefPrice * (1 + minSpacingPct);
    bandMax = lastRefPrice * (1 + maxSpacingPct);
    pctPrice = lastRefPrice * (1 + maxSpacingPct);
  }

  const inBand = walls
    .filter((w) => !usedPrices.some((u) => Math.abs(u - w.price) < 1e-9))
    .filter((w) => wallMeetsSpacing(w.price, side, refPrices, minSpacingPct))
    .filter((w) => w.price >= bandMin && w.price <= bandMax)
    .sort((a, b) => b.volume - a.volume);

  if (inBand.length > 0) {
    return { price: roundStep(inBand[0].price, tickSize), source: 'wall' };
  }

  return { price: roundStep(pctPrice, tickSize), source: 'pct' };
}

export function getSpacingRefPrices(l: LadderState): number[] {
  const refs: number[] = [];
  if (l.entryPrice > 0) refs.push(l.entryPrice);
  const entrySide = l.side ? activeEntrySide(l.side) : null;
  if (!entrySide) return refs;
  for (const o of l.entryOrders) {
    if (o.side === entrySide && (o.status === 'OPEN' || o.status === 'FILLED')) {
      refs.push(o.price);
    }
  }
  return [...new Set(refs)];
}

export function getUsedPricesOnSide(l: LadderState): number[] {
  if (!l.side) return [];
  const entrySide = activeEntrySide(l.side);
  return l.entryOrders.filter((o) => o.side === entrySide).map((o) => o.price);
}

export function dedupeLadderPrice(
  orderPrice: number,
  lastRef: number,
  side: 'LONG' | 'SHORT',
  usedPrices: number[],
  tickSize: number,
  minSpacingPct: number = MIN_LADDER_SPACING_PCT
): number {
  if (!usedPrices.some((u) => Math.abs(u - orderPrice) < tickSize)) {
    return orderPrice;
  }
  return side === 'LONG'
    ? roundStep(lastRef * (1 - minSpacingPct), tickSize)
    : roundStep(lastRef * (1 + minSpacingPct), tickSize);
}
