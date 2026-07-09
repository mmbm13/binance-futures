import { floorStep, roundStep } from '../../bot/math';
import { adx, atr, Candle, donchianHigh, donchianLow } from './indicators';
import {
  MOM_ADX_MIN,
  MOM_ADX_PERIOD,
  MOM_ATR_PERIOD,
  MOM_ATR_STOP_MULT,
  MOM_DONCHIAN_PERIOD,
  MOM_FUNDING_VETO_APR,
  MOM_MAX_BREAKOUT_ATR,
} from './config';

export interface EntryIndicators {
  close: number;
  high: number;
  low: number;
  channelHigh: number;
  channelLow: number;
  atrValue: number;
  adxValue: number;
}

export interface MomentumSignal {
  side: 'LONG' | 'SHORT';
  close: number;
  atrValue: number;
  stopDistance: number;
}

export interface EntryEvaluation {
  signal: MomentumSignal | null;
  /** 'no_breakout' | 'adx_below_min' | 'breakout_candle_too_large' | 'funding_veto' | 'ok' */
  reason: string;
  indicators?: EntryIndicators;
}

export interface EntryParams {
  adxMin?: number;
  atrStopMult?: number;
  maxBreakoutAtr?: number;
  fundingVetoApr?: number;
}

/** Funding APR from an 8h rate (3 windows/day × 365). */
export function computeFundingApr(rate8h: number): number {
  return rate8h * 3 * 365;
}

/**
 * Pure entry decision on precomputed indicators.
 * Breakout first; vetoes only apply when a breakout actually happened.
 */
export function evaluateEntrySignal(
  ind: EntryIndicators,
  fundingApr: number,
  params: EntryParams = {}
): EntryEvaluation {
  const adxMin = params.adxMin ?? MOM_ADX_MIN;
  const atrStopMult = params.atrStopMult ?? MOM_ATR_STOP_MULT;
  const maxBreakoutAtr = params.maxBreakoutAtr ?? MOM_MAX_BREAKOUT_ATR;
  const fundingVetoApr = params.fundingVetoApr ?? MOM_FUNDING_VETO_APR;

  const side: 'LONG' | 'SHORT' | null =
    ind.close > ind.channelHigh ? 'LONG' : ind.close < ind.channelLow ? 'SHORT' : null;

  if (!side) return { signal: null, reason: 'no_breakout', indicators: ind };

  if (ind.adxValue < adxMin) {
    return { signal: null, reason: 'adx_below_min', indicators: ind };
  }

  const candleRange = ind.high - ind.low;
  if (ind.atrValue > 0 && candleRange > maxBreakoutAtr * ind.atrValue) {
    return { signal: null, reason: 'breakout_candle_too_large', indicators: ind };
  }

  if (
    (side === 'LONG' && fundingApr > fundingVetoApr) ||
    (side === 'SHORT' && fundingApr < -fundingVetoApr)
  ) {
    return { signal: null, reason: 'funding_veto', indicators: ind };
  }

  return {
    signal: {
      side,
      close: ind.close,
      atrValue: ind.atrValue,
      stopDistance: atrStopMult * ind.atrValue,
    },
    reason: 'ok',
    indicators: ind,
  };
}

/** Compute indicators from closed candles and delegate to evaluateEntrySignal. */
export function evaluateEntryFromCandles(
  candles: Candle[],
  fundingApr: number,
  params: EntryParams & {
    donchianPeriod?: number;
    atrPeriod?: number;
    adxPeriod?: number;
  } = {}
): EntryEvaluation {
  const donchianPeriod = params.donchianPeriod ?? MOM_DONCHIAN_PERIOD;
  const atrPeriod = params.atrPeriod ?? MOM_ATR_PERIOD;
  const adxPeriod = params.adxPeriod ?? MOM_ADX_PERIOD;

  const atrValue = atr(candles, atrPeriod);
  const adxValue = adx(candles, adxPeriod);
  const channelHigh = donchianHigh(candles, donchianPeriod);
  const channelLow = donchianLow(candles, donchianPeriod);
  const last = candles[candles.length - 1];

  if (atrValue === null || adxValue === null || channelHigh === null || channelLow === null || !last) {
    return { signal: null, reason: 'insufficient_data' };
  }

  return evaluateEntrySignal(
    {
      close: last.close,
      high: last.high,
      low: last.low,
      channelHigh,
      channelLow,
      atrValue,
      adxValue,
    },
    fundingApr,
    params
  );
}

/**
 * Chandelier trailing stop: extremeFavorable − dir × trailMult × ATR,
 * ratcheted so it never retreats from currentStop.
 */
export function computeTrailStop(
  side: 'LONG' | 'SHORT',
  extremeFavorable: number,
  atrValue: number,
  trailMult: number,
  currentStop: number | null,
  tickSize: number
): number {
  const dir = side === 'LONG' ? 1 : -1;
  const candidate = roundStep(extremeFavorable - dir * trailMult * atrValue, tickSize);
  if (currentStop === null || currentStop <= 0) return candidate;
  return dir === 1 ? Math.max(candidate, currentStop) : Math.min(candidate, currentStop);
}

/** Update the favorable extreme with a closed candle (never retreats). */
export function updateExtreme(
  side: 'LONG' | 'SHORT',
  extreme: number,
  candle: { high: number; low: number }
): number {
  return side === 'LONG' ? Math.max(extreme, candle.high) : Math.min(extreme, candle.low);
}

export interface SizingResult {
  qty: number;
  valid: boolean;
  reason: string;
}

/** Fixed-fractional sizing: risk = balance × riskPct spread over the stop distance. */
export function computeQty(
  balance: number,
  riskPct: number,
  stopDistance: number,
  price: number,
  stepSize: number,
  minQty: number,
  minNotional: number
): SizingResult {
  if (stopDistance <= 0 || price <= 0 || balance <= 0) {
    return { qty: 0, valid: false, reason: 'invalid_inputs' };
  }
  const qty = floorStep((balance * riskPct) / stopDistance, stepSize);
  if (qty < minQty) return { qty, valid: false, reason: 'qty_below_min' };
  if (qty * price < minNotional) return { qty, valid: false, reason: 'notional_below_min' };
  return { qty, valid: true, reason: 'ok' };
}

/** True when the loss streak hit the circuit breaker. */
export function shouldPause(consecutiveLosses: number, maxLosses: number): boolean {
  return maxLosses > 0 && consecutiveLosses >= maxLosses;
}
