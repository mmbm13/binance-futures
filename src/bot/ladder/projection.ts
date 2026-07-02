import { LADDER_LEVELS, LADDER_SIZE_MULT } from '../config';
import { Wall } from '../orderbook';
import { roundStep } from '../math';
import { computeGeometricLadderQuantities, validateLadderWithSlGeometry } from './sizing';
import {
  activeEntrySide,
  dedupeLadderPrice,
  getLastLadderRefPrice,
  getSpacingRefPrices,
  getUsedPricesOnSide,
  resolveNextLadderPrice,
} from './spacing';
import { EntryOrder, LadderState } from '../types';

/** Plan all N ladder rung prices from entry (same logic as build phase after first fill). */
export function planLadderPricesFromWalls(
  walls: Wall[],
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  ladderLevels: number,
  tickSize: number
): number[] {
  const entry = roundStep(entryPrice, tickSize);
  const prices: number[] = [entry];
  if (ladderLevels <= 1) return prices;

  let localRefs = [entry];
  let localUsed = [entry];
  let lastRef = entry;

  for (let i = 1; i < ladderLevels; i++) {
    let { price: orderPrice } = resolveNextLadderPrice(
      walls,
      side,
      localRefs,
      lastRef,
      localUsed,
      tickSize
    );
    orderPrice = dedupeLadderPrice(orderPrice, lastRef, side, localUsed, tickSize);
    prices.push(orderPrice);
    localRefs.push(orderPrice);
    localUsed.push(orderPrice);
    lastRef = orderPrice;
  }

  return prices;
}

export interface LadderLevelProjection {
  price: number;
  qty: number;
}

export interface FullLadderProjection {
  totalQty: number;
  avgEntry: number;
  /** Adverse extreme: highest sell (SHORT) or lowest buy (LONG). */
  deepestPrice: number;
  levels: LadderLevelProjection[];
}

/** Project qty/avg entry if every rung on the active side fills (stable SL anchor). */
export function projectFullLadder(
  ladder: LadderState,
  ladderLevels: number = LADDER_LEVELS,
  stepSize: number,
  sizeMult: number = LADDER_SIZE_MULT
): FullLadderProjection | null {
  if (!ladder.side) return null;

  const entrySide = activeEntrySide(ladder.side);
  const ladderOrders = ladder.entryOrders
    .filter((o) => o.side === entrySide && (o.status === 'FILLED' || o.status === 'OPEN'))
    .sort((a, b) => (ladder.side === 'LONG' ? b.price - a.price : a.price - b.price));

  if (ladderOrders.length === 0) return null;

  const levels: LadderLevelProjection[] = [];
  let cost = 0;
  let totalQty = 0;

  for (let level = 1; level <= ladderLevels; level++) {
    const order = ladderOrders[level - 1];
    if (!order) break;

    const qty =
      order.qty > 0
        ? order.qty
        : computeGeometricLadderQuantities(level, ladder.baseQty, stepSize, sizeMult)[level - 1];
    levels.push({ price: order.price, qty });
    cost += order.price * qty;
    totalQty += qty;
  }

  if (totalQty <= 0 || levels.length === 0) return null;

  const deepestPrice =
    ladder.side === 'SHORT'
      ? Math.max(...levels.map((l) => l.price))
      : Math.min(...levels.map((l) => l.price));

  return {
    totalQty,
    avgEntry: cost / totalQty,
    deepestPrice,
    levels,
  };
}

/** SL anchor from filled rungs only — use while ladder is still building (open limits remain). */
export function projectFilledLadder(
  ladder: LadderState,
  stepSize: number
): FullLadderProjection | null {
  if (!ladder.side) return null;

  const entrySide = activeEntrySide(ladder.side);
  const filledOrders = ladder.entryOrders
    .filter((o) => o.side === entrySide && o.status === 'FILLED')
    .sort((a, b) => (ladder.side === 'LONG' ? b.price - a.price : a.price - b.price));

  if (filledOrders.length === 0) return null;

  const levels: LadderLevelProjection[] = filledOrders.map((o) => ({
    price: o.price,
    qty: o.qty,
  }));

  let cost = 0;
  let totalQty = 0;
  for (const level of levels) {
    cost += level.price * level.qty;
    totalQty += level.qty;
  }

  const deepestPrice =
    ladder.side === 'SHORT'
      ? Math.max(...levels.map((l) => l.price))
      : Math.min(...levels.map((l) => l.price));

  return {
    totalQty,
    avgEntry: cost / totalQty,
    deepestPrice,
    levels,
  };
}

/** True when enough ladder rungs are known for SL projection. */
export function hasFullLadderProjection(
  ladder: LadderState,
  ladderLevels: number = LADDER_LEVELS
): boolean {
  if (!ladder.side) return false;
  const entrySide = activeEntrySide(ladder.side);
  const known = ladder.entryOrders.filter(
    (o) => o.side === entrySide && (o.status === 'FILLED' || o.status === 'OPEN')
  ).length;
  const minKnown = ladder.ladderSizingBlocked ? Math.min(2, ladderLevels) : ladderLevels;
  return known >= minKnown;
}

export function ladderOrdersForSide(ladder: LadderState): EntryOrder[] {
  if (!ladder.side) return [];
  const entrySide = activeEntrySide(ladder.side);
  return ladder.entryOrders
    .filter((o) => o.side === entrySide && (o.status === 'FILLED' || o.status === 'OPEN'))
    .sort((a, b) => (ladder.side === 'LONG' ? b.price - a.price : a.price - b.price));
}

/** Simulate prices for rungs not yet placed (same logic as build phase). */
export function simulatePlannedLadderPrices(
  ladder: LadderState,
  count: number,
  tickSize: number
): number[] {
  if (!ladder.side || count <= 0) return [];

  const wallList = ladder.side === 'LONG' ? ladder.buyWalls : ladder.sellWalls;
  const refs = getSpacingRefPrices(ladder);
  const usedPrices = getUsedPricesOnSide(ladder);
  const prices: number[] = [];
  let localRefs = [...refs];
  let localUsed = [...usedPrices];
  let lastRef = getLastLadderRefPrice(ladder);

  for (let i = 0; i < count; i++) {
    let { price: orderPrice } = resolveNextLadderPrice(
      wallList,
      ladder.side,
      localRefs,
      lastRef,
      localUsed,
      tickSize
    );
    orderPrice = dedupeLadderPrice(orderPrice, lastRef, ladder.side, localUsed, tickSize);
    prices.push(orderPrice);
    localRefs.push(orderPrice);
    localUsed.push(orderPrice);
    lastRef = orderPrice;
  }
  return prices;
}

/**
 * Project SL anchor from filled rungs + simulated planned prices when ladder
 * orders were not placed yet (e.g. sizing failed or bot restarted).
 */
export function projectPlannedLadder(
  ladder: LadderState,
  stepSize: number,
  tickSize: number,
  minQty: number,
  minNotional: number,
  ladderLevels: number = LADDER_LEVELS,
  sizeMult: number = LADDER_SIZE_MULT
): FullLadderProjection | null {
  if (!ladder.side) return null;

  const existingOrders = ladderOrdersForSide(ladder);
  if (existingOrders.length === 0) return null;

  const existingPrices = existingOrders.map((o) => o.price);
  const slotsRemaining = Math.max(0, ladderLevels - existingOrders.length);
  const newPrices =
    slotsRemaining > 0 && (ladder.buyWalls.length > 0 || ladder.sellWalls.length > 0)
      ? simulatePlannedLadderPrices(ladder, slotsRemaining, tickSize)
      : [];
  const allPrices = [...existingPrices, ...newPrices];
  if (allPrices.length === 0) return null;

  const firstFilled = existingOrders.find((o) => o.status === 'FILLED');
  const fixedFirstQty = firstFilled?.qty ?? ladder.baseQty;

  const sizing = validateLadderWithSlGeometry(
    allPrices,
    ladder.side,
    ladder.baseQty,
    ladder.riskAmount,
    stepSize,
    minQty,
    minNotional,
    tickSize,
    sizeMult,
    fixedFirstQty
  );

  const quantities =
    sizing.quantities ??
    computeGeometricLadderQuantities(
      allPrices.length,
      ladder.baseQty,
      stepSize,
      sizeMult,
      fixedFirstQty
    );

  const levels: LadderLevelProjection[] = allPrices.map((price, i) => ({
    price,
    qty: quantities[i] ?? ladder.baseQty,
  }));

  let cost = 0;
  let totalQty = 0;
  for (const level of levels) {
    cost += level.price * level.qty;
    totalQty += level.qty;
  }
  if (totalQty <= 0) return null;

  const deepestPrice =
    ladder.side === 'SHORT'
      ? Math.max(...levels.map((l) => l.price))
      : Math.min(...levels.map((l) => l.price));

  return {
    totalQty,
    avgEntry: cost / totalQty,
    deepestPrice,
    levels,
  };
}
