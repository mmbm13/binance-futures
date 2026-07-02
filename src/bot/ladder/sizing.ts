import { MIN_SL_GAP_TICKS, LADDER_LEVELS, LADDER_SIZE_MULT, NOTIONAL_MULTIPLIER, SIZE_MULT_SUM } from '../config';
import { ceilStep, floorStep } from '../math';

export function computeBaseQty(
  balance: number,
  price: number,
  stepSize: number,
  notionalMultiplier: number = NOTIONAL_MULTIPLIER,
  sizeMultSum: number = SIZE_MULT_SUM
): number {
  return floorStep((balance * notionalMultiplier) / price / sizeMultSum, stepSize);
}

/** @deprecated Prefer computeRiskSizedLadderQuantities when ladder prices are known. */
export function computeLadderQty(
  baseQty: number,
  level: number,
  stepSize: number,
  sizeMult: number = LADDER_SIZE_MULT
): number {
  return floorStep(baseQty * Math.pow(sizeMult, level - 1), stepSize);
}

export function computeRiskAmount(
  balance: number,
  accountRiskPercent: number
): number {
  return balance * accountRiskPercent;
}

/** Ladder prices ordered by fill sequence (nearest → deepest adverse). */
export function orderLadderPrices(
  prices: number[],
  side: 'LONG' | 'SHORT'
): number[] {
  return side === 'SHORT'
    ? [...prices].sort((a, b) => a - b)
    : [...prices].sort((a, b) => b - a);
}

export function projectedSlPrice(
  quantities: number[],
  prices: number[],
  side: 'LONG' | 'SHORT',
  riskAmount: number
): number {
  const Q = quantities.reduce((a, b) => a + b, 0);
  if (Q <= 0) return 0;
  const avg = quantities.reduce((s, q, i) => s + q * prices[i], 0) / Q;
  const dist = riskAmount / Q;
  return side === 'SHORT' ? avg + dist : avg - dist;
}

/** Min price gap between deepest rung and risk-based SL. */
export function minSlGapPrice(tickSize: number, gapTicks: number = MIN_SL_GAP_TICKS): number {
  return tickSize * Math.max(1, gapTicks);
}

/** True when risk-based SL (avg ± risk/Q) sits beyond the deepest rung before rounding. */
export function slBeyondDeepestRung(
  quantities: number[],
  prices: number[],
  side: 'LONG' | 'SHORT',
  riskAmount: number,
  tickSize: number,
  gapTicks: number = MIN_SL_GAP_TICKS
): boolean {
  if (quantities.length === 0 || prices.length === 0) return false;
  const deepest = side === 'SHORT' ? Math.max(...prices) : Math.min(...prices);
  const sl = projectedSlPrice(quantities, prices, side, riskAmount);
  const gap = minSlGapPrice(tickSize, gapTicks);
  return side === 'SHORT' ? sl >= deepest + gap - 1e-9 : sl <= deepest - gap + 1e-9;
}

/**
 * Building SL from full-ladder projection. Returns null when geometry is infeasible
 * (never snap SL to the same tick as the deepest rung).
 */
export function buildingSlPrice(
  quantities: number[],
  prices: number[],
  side: 'LONG' | 'SHORT',
  riskAmount: number,
  tickSize: number,
  gapTicks: number = MIN_SL_GAP_TICKS
): number | null {
  if (!slBeyondDeepestRung(quantities, prices, side, riskAmount, tickSize, gapTicks)) {
    return null;
  }

  const sl = projectedSlPrice(quantities, prices, side, riskAmount);
  if (side === 'SHORT') {
    return ceilStep(sl, tickSize);
  }
  return floorStep(sl, tickSize);
}

/** Fixed geometric ladder: level i = base × mult^i (each rung ≥ previous). */
export function computeGeometricLadderQuantities(
  levels: number,
  baseQty: number,
  stepSize: number,
  sizeMult: number = LADDER_SIZE_MULT,
  fixedFirstQty?: number
): number[] {
  const first = fixedFirstQty ?? baseQty;
  return Array.from({ length: levels }, (_, i) =>
    floorStep(first * Math.pow(sizeMult, i), stepSize)
  );
}

/** Validate geometric ladder (minQty / minNotional only — order sizes stay monotonic). */
export function validateGeometricLadder(
  prices: number[],
  baseQty: number,
  stepSize: number,
  minQty: number,
  minNotional: number,
  sizeMult: number = LADDER_SIZE_MULT,
  fixedFirstQty?: number
): LadderSizingValidation {
  const quantities = computeGeometricLadderQuantities(
    prices.length,
    baseQty,
    stepSize,
    sizeMult,
    fixedFirstQty
  );
  const qtyCheck = validateLadderQuantities(quantities, prices, minQty, minNotional);
  return { ...qtyCheck, quantities };
}

/** Validate geometric ladder + exchange limits + SL beyond deepest rung. */
export function validateLadderWithSlGeometry(
  prices: number[],
  side: 'LONG' | 'SHORT',
  baseQty: number,
  riskAmount: number,
  stepSize: number,
  minQty: number,
  minNotional: number,
  tickSize: number,
  sizeMult: number = LADDER_SIZE_MULT,
  fixedFirstQty?: number
): LadderSizingValidation {
  const quantities = computeGeometricLadderQuantities(
    prices.length,
    baseQty,
    stepSize,
    sizeMult,
    fixedFirstQty
  );
  const qtyCheck = validateLadderQuantities(quantities, prices, minQty, minNotional);
  if (!qtyCheck.valid) {
    return { ...qtyCheck, quantities };
  }

  const ordered = orderLadderPrices(prices, side);
  if (!slBeyondDeepestRung(quantities, ordered, side, riskAmount, tickSize)) {
    return { valid: false, reason: 'sl_geometry_infeasible', quantities };
  }

  return { valid: true, reason: 'ok', quantities };
}

/**
 * Scale ladder qty (keeping rung 1 fixed) so SL lands beyond the deepest rung at max loss = risk.
 * Prefer validateLadderWithSlGeometry + smaller baseQty for monotonic geometric ladders.
 */
export function computeRiskSizedLadderQuantities(
  prices: number[],
  side: 'LONG' | 'SHORT',
  riskAmount: number,
  stepSize: number,
  minQty: number,
  tickSize: number,
  sizeMult: number = LADDER_SIZE_MULT,
  fixedFirstQty?: number
): number[] {
  const n = prices.length;
  if (n === 0) return [];

  const ordered = orderLadderPrices(prices, side);
  const weights = Array.from({ length: n }, (_, i) => Math.pow(sizeMult, i));

  const build = (scale: number): number[] => {
    let qs: number[];
    if (fixedFirstQty !== undefined) {
      qs = [fixedFirstQty];
      for (let i = 1; i < n; i++) {
        qs.push(floorStep(scale * fixedFirstQty * Math.pow(sizeMult, i), stepSize));
      }
    } else {
      qs = weights.map((w) => floorStep(scale * w, stepSize));
    }
    for (let i = 1; i < qs.length; i++) {
      qs[i] = Math.max(qs[i], qs[i - 1]);
    }
    return qs;
  };

  const meetsMinQty = (qs: number[]) => qs.every((q) => q >= minQty);

  const isValid = (scale: number): boolean => {
    const qs = build(scale);
    if (!meetsMinQty(qs)) return false;
    return slBeyondDeepestRung(qs, ordered, side, riskAmount, tickSize);
  };

  let minScale = 0;
  let hiProbe = 1;
  while (!meetsMinQty(build(hiProbe)) && hiProbe < 1e6) {
    hiProbe *= 2;
  }
  if (!meetsMinQty(build(hiProbe))) {
    return build(0).map((q) => Math.max(q, minQty));
  }

  let lo = 0;
  let hi = hiProbe;
  while (lo + 1e-12 < hi) {
    const mid = (lo + hi) / 2;
    if (meetsMinQty(build(mid))) hi = mid;
    else lo = mid;
  }
  minScale = hi;

  if (!isValid(minScale)) {
    return build(minScale);
  }

  lo = minScale;
  hi = minScale + 1;
  while (isValid(hi)) {
    lo = hi;
    hi *= 2;
    if (hi > 1e6) break;
  }

  for (let i = 0; i < 64; i++) {
    if (hi - lo < 1e-12) break;
    const mid = (lo + hi) / 2;
    if (isValid(mid)) lo = mid;
    else hi = mid;
  }

  return build(lo);
}

export type LadderSizingFailureReason =
  | 'ok'
  | 'empty'
  | 'qty_below_min'
  | 'notional_below_min'
  | 'sl_geometry_infeasible';

export interface LadderSizingValidation {
  valid: boolean;
  reason: LadderSizingFailureReason;
  level?: number;
  qty?: number;
  notional?: number;
  minQty?: number;
  minNotional?: number;
  quantities?: number[];
}

/** Per-level min qty and notional checks (exchange limits). */
export function validateLadderQuantities(
  quantities: number[],
  prices: number[],
  minQty: number,
  minNotional: number
): LadderSizingValidation {
  if (quantities.length === 0 || prices.length === 0) {
    return { valid: false, reason: 'empty' };
  }

  const n = Math.min(quantities.length, prices.length);
  for (let i = 0; i < n; i++) {
    const qty = quantities[i];
    const price = prices[i];
    if (qty < minQty) {
      return {
        valid: false,
        reason: 'qty_below_min',
        level: i + 1,
        qty,
        minQty,
      };
    }
    const notional = qty * price;
    if (notional < minNotional) {
      return {
        valid: false,
        reason: 'notional_below_min',
        level: i + 1,
        qty,
        notional,
        minNotional,
      };
    }
  }

  return { valid: true, reason: 'ok' };
}

/** Compute risk-sized qty and verify exchange + SL geometry constraints. */
export function validateRiskSizedLadder(
  prices: number[],
  side: 'LONG' | 'SHORT',
  riskAmount: number,
  stepSize: number,
  minQty: number,
  minNotional: number,
  tickSize: number,
  sizeMult: number = LADDER_SIZE_MULT,
  fixedFirstQty?: number
): LadderSizingValidation {
  const quantities = computeRiskSizedLadderQuantities(
    prices,
    side,
    riskAmount,
    stepSize,
    minQty,
    tickSize,
    sizeMult,
    fixedFirstQty
  );

  const qtyCheck = validateLadderQuantities(quantities, prices, minQty, minNotional);
  if (!qtyCheck.valid) {
    return { ...qtyCheck, quantities };
  }

  const ordered = orderLadderPrices(prices, side);
  if (!slBeyondDeepestRung(quantities, ordered, side, riskAmount, tickSize)) {
    return { valid: false, reason: 'sl_geometry_infeasible', quantities };
  }

  return { valid: true, reason: 'ok', quantities };
}

/** Shrink baseQty (and optionally levels) until SL geometry fits on both sides. */
export function resolveBaseQtyForLadder(
  shortPrices: number[],
  longPrices: number[],
  riskAmount: number,
  stepSize: number,
  minQty: number,
  minNotional: number,
  tickSize: number,
  sizeMult: number = LADDER_SIZE_MULT,
  capQty: number,
  ladderLevels: number = LADDER_LEVELS
): { baseQty: number; shortQtys: number[]; longQtys: number[]; ladderLevels: number } | null {
  if (shortPrices.length < ladderLevels || longPrices.length < ladderLevels) {
    return null;
  }

  const shortSlice = shortPrices.slice(0, ladderLevels);
  const longSlice = longPrices.slice(0, ladderLevels);
  let baseQty = capQty;

  while (baseQty >= minQty) {
    const shortV = validateLadderWithSlGeometry(
      shortSlice,
      'SHORT',
      baseQty,
      riskAmount,
      stepSize,
      minQty,
      minNotional,
      tickSize,
      sizeMult
    );
    const longV = validateLadderWithSlGeometry(
      longSlice,
      'LONG',
      baseQty,
      riskAmount,
      stepSize,
      minQty,
      minNotional,
      tickSize,
      sizeMult
    );

    if (shortV.valid && longV.valid) {
      return {
        baseQty,
        shortQtys: shortV.quantities!,
        longQtys: longV.quantities!,
        ladderLevels,
      };
    }

    if (
      shortV.reason === 'qty_below_min' ||
      longV.reason === 'qty_below_min' ||
      shortV.reason === 'notional_below_min' ||
      longV.reason === 'notional_below_min'
    ) {
      return null;
    }

    baseQty = floorStep(baseQty - stepSize, stepSize);
  }

  return null;
}

export function formatLadderSizingError(
  validation: LadderSizingValidation,
  ladderLevels: number
): string {
  switch (validation.reason) {
    case 'qty_below_min':
      return (
        `level ${validation.level}/${ladderLevels}: qty ${validation.qty} < minQty ${validation.minQty} ` +
        `(too many levels or account too small — reduce LADDER_LEVELS or increase capital)`
      );
    case 'notional_below_min':
      return (
        `level ${validation.level}/${ladderLevels}: notional $${validation.notional!.toFixed(2)} ` +
        `< min $${validation.minNotional} (qty ${validation.qty})`
      );
    case 'sl_geometry_infeasible':
      return (
        `ladder span exceeds risk budget at ${ladderLevels} levels ` +
        `(cannot place SL beyond deepest rung with max loss intact)`
      );
    case 'empty':
      return 'no ladder prices to size';
    default:
      return 'unknown sizing error';
  }
}
