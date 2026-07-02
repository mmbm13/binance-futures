import { HARVEST_TRAIL_MIN_STEP_PCT } from '../config';
import { LadderState } from '../types';
import { computeHarvestSlPrice, wouldSlTriggerNow } from './exitPricing';

/** True when the ladder is in harvest and holds a position worth trailing. */
export function canTrailHarvest(ladder: LadderState | null): boolean {
  return Boolean(
    ladder?.side &&
      (ladder.windingDown || ladder.partialCloses > 0) &&
      ladder.posQty > 0 &&
      ladder.entryPrice > 0
  );
}

/**
 * Ratchet the harvest peak with the latest price and decide whether the
 * exchange SL should be re-placed (trailing improved by at least the min step,
 * or no SL is currently on the exchange). Mutates ladder.harvestPeakPrice.
 */
export function evaluateHarvestTrail(
  ladder: LadderState,
  price: number,
  tickSize: number,
  minStepPct: number = HARVEST_TRAIL_MIN_STEP_PCT
): boolean {
  if (!canTrailHarvest(ladder) || price <= 0) return false;

  const side = ladder.side!;
  const dir = side === 'LONG' ? 1 : -1;
  const base =
    ladder.harvestPeakPrice && ladder.harvestPeakPrice > 0
      ? ladder.harvestPeakPrice
      : ladder.entryPrice;
  ladder.harvestPeakPrice = dir === 1 ? Math.max(base, price) : Math.min(base, price);

  const desiredSl = computeHarvestSlPrice(side, ladder.entryPrice, ladder.harvestPeakPrice, tickSize);

  // Re-placing an SL that would trigger instantly is pointless; keep the current one.
  if (wouldSlTriggerNow(side, desiredSl, price, tickSize)) return false;

  const currentSl = ladder.slPrice ?? 0;
  if (currentSl <= 0 || ladder.slIsCatastrophic) return true;

  const improvement = (desiredSl - currentSl) * dir;
  return improvement >= ladder.entryPrice * minStepPct;
}
