import { floorStep } from '../../bot/math';
import { TAKER_FEE } from '../../bot/config';

/** APR from an 8h funding rate (3 windows/day × 365). */
export function computeApr(rate8h: number): number {
  return rate8h * 3 * 365;
}

export function countConsecutiveAbove(rates8h: number[], entryApr: number): number {
  let n = 0;
  for (let i = rates8h.length - 1; i >= 0; i--) {
    if (computeApr(rates8h[i]) > entryApr) n++;
    else break;
  }
  return n;
}

export function countConsecutiveBelow(rates8h: number[], exitApr: number): number {
  let n = 0;
  for (let i = rates8h.length - 1; i >= 0; i--) {
    if (computeApr(rates8h[i]) < exitApr) n++;
    else break;
  }
  return n;
}

export function shouldOpen(
  rates8h: number[],
  entryApr: number,
  entryWindows: number
): boolean {
  return countConsecutiveAbove(rates8h, entryApr) >= entryWindows;
}

export function shouldClose(
  rates8h: number[],
  exitApr: number,
  exitWindows: number
): boolean {
  return countConsecutiveBelow(rates8h, exitApr) >= exitWindows;
}

export function needsRebalance(spotQty: number, perpQty: number, driftPct: number): boolean {
  if (perpQty <= 0) return false;
  return Math.abs(spotQty - perpQty) / perpQty > driftPct;
}

export function rebalancePerpDelta(spotQty: number, perpQty: number): number {
  return spotQty - perpQty;
}

export const FUNDING_CYCLE_FEE_RATE = TAKER_FEE * 4;

/** Pre-entry: expected APR yield over hold must beat 3× round-trip fees. */
export function passesPreEntryFeeGate(
  apr: number,
  estimatedHoldDays: number,
  cycleFeeRate: number = FUNDING_CYCLE_FEE_RATE
): boolean {
  const expectedReturn = apr * (estimatedHoldDays / 365);
  return expectedReturn > cycleFeeRate * 3;
}

export function computeMarginRatio(maintMargin: number, marginBalance: number): number {
  if (marginBalance <= 0) return 1;
  return maintMargin / marginBalance;
}

export function shouldReduceMargin(marginRatio: number, warnRatio: number): boolean {
  return marginRatio > warnRatio;
}

export function reduceQty(qty: number, ratio: number, stepSize: number): number {
  return floorStep(qty * (1 - ratio), stepSize);
}

export interface NotionalSizing {
  qty: number;
  valid: boolean;
  reason: string;
}

export function computeNotionalQty(
  balance: number,
  notionalPct: number,
  price: number,
  stepSize: number,
  minQty: number,
  minNotional: number
): NotionalSizing {
  if (balance <= 0 || price <= 0 || notionalPct <= 0) {
    return { qty: 0, valid: false, reason: 'invalid_inputs' };
  }
  const qty = floorStep((balance * notionalPct) / price, stepSize);
  if (qty < minQty) return { qty, valid: false, reason: 'qty_below_min' };
  if (qty * price < minNotional) return { qty, valid: false, reason: 'notional_below_min' };
  return { qty, valid: true, reason: 'ok' };
}

export function baseAssetFromSymbol(symbol: string): string {
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  if (symbol.endsWith('USDC')) return symbol.slice(0, -4);
  return symbol;
}

export type OpenLegAction = 'buy_spot' | 'short_perp' | 'complete' | 'rollback_spot' | 'idle';

/** Pure open-sequence planner (rollback when perp fails after spot fill). */
export function resolveOpenLegAction(input: {
  spotQty: number;
  perpQty: number;
  spotFailed?: boolean;
  perpFailed?: boolean;
}): OpenLegAction {
  if (input.spotFailed) return 'idle';
  if (input.spotQty > 0 && input.perpFailed) return 'rollback_spot';
  if (input.spotQty > 0 && input.perpQty > 0) return 'complete';
  if (input.spotQty > 0) return 'short_perp';
  return 'buy_spot';
}

/** Basis PnL when closing: (entryBasis − currentBasis) × qty for short-perp/long-spot. */
export function computeBasisPnl(
  entryBasis: number,
  exitBasis: number,
  qty: number
): number {
  return (entryBasis - exitBasis) * qty;
}
