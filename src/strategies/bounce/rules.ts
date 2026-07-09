import { floorStep, roundStep } from '../../bot/math';
import { ScoredZone } from './wallPersistence';
import {
  BOUNCE_CONFIRM_CVD,
  BOUNCE_CONFIRM_REBOUND_PCT,
  BOUNCE_ZONE_TOUCH_PCT,
} from './config';

export type TradeSide = 'LONG' | 'SHORT';

export interface TouchMatch {
  zone: ScoredZone;
  tradeSide: TradeSide;
}

/** Price entered within touchPct of a scored zone boundary. */
export function detectZoneTouch(
  price: number,
  bidZones: ScoredZone[],
  askZones: ScoredZone[],
  touchPct: number = BOUNCE_ZONE_TOUCH_PCT
): TouchMatch | null {
  if (price <= 0) return null;

  for (const zone of bidZones) {
    const dist = Math.abs(price - zone.price) / zone.price;
    if (price <= zone.price * (1 + touchPct) && dist <= touchPct) {
      return { zone, tradeSide: 'LONG' };
    }
  }

  for (const zone of askZones) {
    const dist = Math.abs(price - zone.price) / zone.price;
    if (price >= zone.price * (1 - touchPct) && dist <= touchPct) {
      return { zone, tradeSide: 'SHORT' };
    }
  }

  return null;
}

/** Track the adverse extreme while price interacts with the zone. */
export function updateTouchExtreme(
  tradeSide: TradeSide,
  extreme: number,
  price: number
): number {
  if (tradeSide === 'LONG') return Math.min(extreme, price);
  return Math.max(extreme, price);
}

export interface ConfirmInput {
  tradeSide: TradeSide;
  price: number;
  touchExtreme: number;
  cvd1m: number;
  requireCvd?: boolean;
  reboundPct?: number;
}

/** Rebound + optional CVD confirmation after a zone touch. */
export function isReboundConfirmed(input: ConfirmInput): boolean {
  const {
    tradeSide,
    price,
    touchExtreme,
    cvd1m,
    requireCvd = BOUNCE_CONFIRM_CVD,
    reboundPct = BOUNCE_CONFIRM_REBOUND_PCT,
  } = input;

  const reboundOk =
    tradeSide === 'LONG'
      ? price >= touchExtreme * (1 + reboundPct)
      : price <= touchExtreme * (1 - reboundPct);

  if (!reboundOk) return false;
  if (!requireCvd) return true;
  return tradeSide === 'LONG' ? cvd1m > 0 : cvd1m < 0;
}

/** Initial stop beyond the zone outer edge. */
export function computeZoneSlPrice(
  tradeSide: TradeSide,
  zonePrice: number,
  atr1m: number,
  atrBuffer: number,
  tickSize: number
): number {
  const buffer = atrBuffer * atr1m;
  if (tradeSide === 'LONG') {
    return Math.max(tickSize, roundStep(zonePrice - buffer, tickSize));
  }
  return roundStep(zonePrice + buffer, tickSize);
}

export interface SizingResult {
  qty: number;
  valid: boolean;
  reason: string;
}

export function computeEntryQty(
  balance: number,
  riskPct: number,
  entry: number,
  slPrice: number,
  tradeSide: TradeSide,
  stepSize: number,
  minQty: number,
  minNotional: number
): SizingResult {
  const stopDistance = Math.abs(entry - slPrice);
  if (stopDistance <= 0 || entry <= 0 || balance <= 0) {
    return { qty: 0, valid: false, reason: 'invalid_inputs' };
  }
  const qty = floorStep((balance * riskPct) / stopDistance, stepSize);
  if (qty < minQty) return { qty, valid: false, reason: 'qty_below_min' };
  if (qty * entry < minNotional) return { qty, valid: false, reason: 'notional_below_min' };
  void tradeSide;
  return { qty, valid: true, reason: 'ok' };
}

/** Unrealized PnL in USDT. */
export function unrealizedPnl(
  tradeSide: TradeSide,
  entry: number,
  qty: number,
  price: number
): number {
  const dir = tradeSide === 'LONG' ? 1 : -1;
  return (price - entry) * qty * dir;
}

export function shouldMoveToBreakeven(
  tradeSide: TradeSide,
  entry: number,
  price: number,
  triggerPct: number
): boolean {
  const dir = tradeSide === 'LONG' ? 1 : -1;
  return (price - entry) * dir >= entry * triggerPct;
}

export function canAntiMartingaleAdd(
  unrealized: number,
  riskAmount: number,
  addsDone: number,
  maxAdds: number,
  triggerR: number
): boolean {
  if (addsDone >= maxAdds) return false;
  if (riskAmount <= 0) return false;
  return unrealized >= riskAmount * triggerR;
}

/** SL never loosens when position grows. */
export function ratchetStop(
  tradeSide: TradeSide,
  candidate: number,
  current: number | null
): number {
  if (current === null || current <= 0) return candidate;
  return tradeSide === 'LONG' ? Math.max(candidate, current) : Math.min(candidate, current);
}

/** Abort when origin zone liquidity collapses before breakeven lock. */
export function shouldAbortOnZoneWithdrawal(
  breakevenActive: boolean,
  volumeRetained: boolean
): boolean {
  return !breakevenActive && !volumeRetained;
}
