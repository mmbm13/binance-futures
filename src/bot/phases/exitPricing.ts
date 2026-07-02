import { BUILDING_TP_MAX_PCT, HARVEST_SL_MAX_PCT, HARVEST_TP_MAX_PCT, TP_REWARD_RATIO } from '../config';
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
  buildingTpMaxPct?: number;
  /** SL from full-ladder projection: beyond deepest rung, max loss = riskAmount. */
  buildingSlProjection?: BuildingSlProjection;
  /** No SL until every ladder limit is placed (OPEN or FILLED). */
  deferBuildingSl?: boolean;
  currentPrice?: number;
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

  if (harvestMode) {
    tpDistance = tpEntry * harvestTpMaxPct;
    slDistance = slEntry * harvestSlMaxPct;
    slPrice = Math.max(tickSize, roundStep(slEntry - dir * slDistance, tickSize));
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

  if (slPrice <= 0 && !skipSl && harvestMode) {
    slPrice = Math.max(tickSize, roundStep(slEntry - dir * slDistance, tickSize));
  }

  const tpPrice = Math.max(tickSize, roundStep(tpEntry + dir * tpDistance, tickSize));
  const tpTargetUsd = tpDistance * tpQty;
  const slTargetUsd = harvestMode ? slDistance * tpQty : riskAmount;

  const currentPrice = options.currentPrice ?? 0;
  if (options.deferBuildingSl) {
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
  };
}
