import {
  BUILDING_TP_MAX_PCT,
  BUILDING_TRAIL_FLOOR_PCT,
  BUILDING_TRAIL_PCT,
  CATASTROPHIC_SL_MULT,
  HARVEST_BREAKEVEN_BUFFER_PCT,
  HARVEST_SL_MAX_PCT,
  HARVEST_TP_MAX_PCT,
  HARVEST_TRAIL_PCT,
  TP_REWARD_RATIO,
} from '../config';
import { buildingSlPrice } from '../ladder/sizing';
import { roundStep } from '../math';

export type ExitMode = 'building' | 'harvest';

export interface ExitPrices {
  slPrice: number;
  tpPrice: number;
  slDistance: number;
  tpDistance: number;
  tpTargetUsd: number;
  slTargetUsd: number;
  closeSide: 'BUY' | 'SELL';
  dir: 1 | -1;
  mode: ExitMode;
  skipSl?: boolean;
  skipTp?: boolean;
}

export interface BuildingSlProjection {
  avgEntry: number;
  qty: number;
  deepestPrice: number;
  prices: number[];
  quantities: number[];
}

export interface ExitPriceOptions {
  harvestMode?: boolean;
  harvestTpMaxPct?: number;
  harvestSlMaxPct?: number;
  /** Best favorable price since harvest began (drives the trailing SL). */
  harvestPeakPrice?: number;
  harvestBreakevenBufferPct?: number;
  harvestTrailPct?: number;
  buildingTpMaxPct?: number;
  /** SL from full-ladder projection: beyond deepest rung, max loss = riskAmount. */
  buildingSlProjection?: BuildingSlProjection;
  /** No SL until every ladder limit is placed (OPEN or FILLED). */
  deferBuildingSl?: boolean;
  /** Building trail armed after first fill hits activation — trailing SL, no fixed TP. */
  buildingTrailActive?: boolean;
  buildingTrailPeakPrice?: number;
  buildingTrailFloorPct?: number;
  buildingTrailPct?: number;
  currentPrice?: number;
}

/**
 * Trailing SL: never worse than entry ± floorPct, ratcheted from peak favorable price.
 */
export function computeTrailingSlPrice(
  side: 'LONG' | 'SHORT',
  entry: number,
  peakPrice: number,
  tickSize: number,
  floorPct: number,
  trailPct: number
): number {
  const dir = side === 'LONG' ? 1 : -1;
  const floor = entry * (1 + dir * floorPct);
  const peak = peakPrice > 0 ? peakPrice : entry;
  const trail = peak * (1 - dir * trailPct);
  const raw = side === 'LONG' ? Math.max(floor, trail) : Math.min(floor, trail);
  return Math.max(tickSize, roundStep(raw, tickSize));
}

/**
 * Harvest SL: never worse than breakeven ± buffer, ratcheted by a trailing stop
 * from the best favorable price since harvest began.
 */
export function computeHarvestSlPrice(
  side: 'LONG' | 'SHORT',
  entry: number,
  peakPrice: number,
  tickSize: number,
  breakevenBufferPct: number = HARVEST_BREAKEVEN_BUFFER_PCT,
  trailPct: number = HARVEST_TRAIL_PCT
): number {
  return computeTrailingSlPrice(side, entry, peakPrice, tickSize, breakevenBufferPct, trailPct);
}

/** Building trail SL with a profit floor (typically BUILDING_TP_MAX_PCT). */
export function computeBuildingTrailSlPrice(
  side: 'LONG' | 'SHORT',
  entry: number,
  peakPrice: number,
  tickSize: number,
  floorPct: number = BUILDING_TRAIL_FLOOR_PCT,
  trailPct: number = BUILDING_TRAIL_PCT
): number {
  return computeTrailingSlPrice(side, entry, peakPrice, tickSize, floorPct, trailPct);
}

/** Wide backstop SL (max loss = riskAmount × mult at current qty) for when the normal SL is skipped. */
export function computeCatastrophicSlPrice(
  side: 'LONG' | 'SHORT',
  entry: number,
  qty: number,
  riskAmount: number,
  tickSize: number,
  mult: number = CATASTROPHIC_SL_MULT
): number {
  if (entry <= 0 || qty <= 0 || riskAmount <= 0 || mult <= 0) return 0;
  const dir = side === 'LONG' ? 1 : -1;
  const distance = (riskAmount * mult) / qty;
  return Math.max(tickSize, roundStep(entry - dir * distance, tickSize));
}

/** True if market price has already reached the stop trigger level. */
export function wouldSlTriggerNow(
  side: 'LONG' | 'SHORT',
  slPrice: number,
  currentPrice: number,
  tickSize: number
): boolean {
  if (currentPrice <= 0 || slPrice <= 0) return false;
  if (side === 'SHORT') return currentPrice >= slPrice - tickSize;
  return currentPrice <= slPrice + tickSize;
}

export function computeExitPrices(
  side: 'LONG' | 'SHORT',
  entry: number,
  qty: number,
  riskAmount: number,
  tickSize: number,
  tpRewardRatio: number = TP_REWARD_RATIO,
  options: ExitPriceOptions = {}
): ExitPrices {
  const dir = side === 'LONG' ? 1 : -1;
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
  const harvestMode = options.harvestMode ?? false;
  const harvestTpMaxPct = options.harvestTpMaxPct ?? HARVEST_TP_MAX_PCT;
  const harvestSlMaxPct = options.harvestSlMaxPct ?? HARVEST_SL_MAX_PCT;
  const buildingTpMaxPct = options.buildingTpMaxPct ?? BUILDING_TP_MAX_PCT;
  const mode: ExitMode = harvestMode ? 'harvest' : 'building';

  const tpEntry = entry;
  const tpQty = qty;
  let slEntry = entry;
  let slQty = qty;

  let slDistance = riskAmount / slQty;
  let tpDistance = (riskAmount * tpRewardRatio) / tpQty;
  let skipSl = false;
  let slPrice = 0;
  const currentPrice = options.currentPrice ?? 0;

  if (harvestMode) {
    tpDistance = tpEntry * harvestTpMaxPct;
    slPrice = computeHarvestSlPrice(
      side,
      slEntry,
      options.harvestPeakPrice ?? 0,
      tickSize,
      options.harvestBreakevenBufferPct,
      options.harvestTrailPct
    );
    if (currentPrice > 0 && wouldSlTriggerNow(side, slPrice, currentPrice, tickSize)) {
      // Breakeven/trail level already breached — fall back to the wide symmetric harvest SL.
      slPrice = Math.max(tickSize, roundStep(slEntry - dir * slEntry * harvestSlMaxPct, tickSize));
    }
    slDistance = Math.abs(slPrice - slEntry);
  } else if (options.buildingTrailActive) {
    tpDistance = tpEntry * buildingTpMaxPct;
    slPrice = computeBuildingTrailSlPrice(
      side,
      slEntry,
      options.buildingTrailPeakPrice ?? 0,
      tickSize,
      options.buildingTrailFloorPct,
      options.buildingTrailPct
    );
    slDistance = Math.abs(slPrice - slEntry);
  } else {
    tpDistance = Math.min(tpDistance, tpEntry * buildingTpMaxPct);

    const slRef = options.buildingSlProjection;
    if (slRef && slRef.qty > 0 && slRef.prices.length > 0 && slRef.quantities.length > 0) {
      slEntry = slRef.avgEntry;
      slQty = slRef.qty;
      const computed = buildingSlPrice(slRef.quantities, slRef.prices, side, riskAmount, tickSize);
      if (computed === null) {
        skipSl = true;
        slPrice = 0;
      } else {
        slPrice = computed;
        slDistance = Math.abs(slPrice - slEntry);
      }
    } else {
      slPrice = Math.max(tickSize, roundStep(slEntry - dir * slDistance, tickSize));
    }
  }

  const tpPrice = Math.max(tickSize, roundStep(tpEntry + dir * tpDistance, tickSize));
  const tpTargetUsd = tpDistance * tpQty;
  const slTargetUsd = harvestMode ? slDistance * tpQty : riskAmount;

  if (options.deferBuildingSl && !options.buildingTrailActive) {
    skipSl = true;
  } else if (harvestMode && currentPrice > 0 && wouldSlTriggerNow(side, slPrice, currentPrice, tickSize)) {
    skipSl = true;
  }

  return {
    slPrice,
    tpPrice,
    slDistance,
    tpDistance,
    tpTargetUsd,
    slTargetUsd,
    closeSide,
    dir,
    mode,
    skipSl,
    skipTp: options.buildingTrailActive ?? false,
  };
}
