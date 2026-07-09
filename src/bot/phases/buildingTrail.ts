import {
  BUILDING_TRAIL_ACTIVATION_PCT,
  BUILDING_TRAIL_ENABLED,
  BUILDING_TRAIL_MIN_STEP_PCT,
} from '../config';
import { cancelByClientOrderId } from '../exchange';
import { LadderState } from '../types';
import { computeBuildingTrailSlPrice, wouldSlTriggerNow } from './exitPricing';
import { logger } from '../../utils/logger';

/** True when building trail can be evaluated (first fill only, not harvest). */
export function canEvaluateBuildingTrail(ladder: LadderState | null): boolean {
  if (!BUILDING_TRAIL_ENABLED) return false;
  return Boolean(
    ladder?.side &&
      ladder.fills === 1 &&
      ladder.partialCloses === 0 &&
      !ladder.windingDown &&
      ladder.posQty > 0 &&
      ladder.entryPrice > 0
  );
}

/** True when price has reached the activation threshold from entry. */
export function buildingTrailActivationReached(
  side: 'LONG' | 'SHORT',
  entry: number,
  price: number,
  activationPct: number = BUILDING_TRAIL_ACTIVATION_PCT
): boolean {
  if (entry <= 0 || price <= 0) return false;
  const dir = side === 'LONG' ? 1 : -1;
  const threshold = entry * (1 + dir * activationPct);
  return dir === 1 ? price >= threshold : price <= threshold;
}

export function shouldActivateBuildingTrail(ladder: LadderState, price: number): boolean {
  return (
    canEvaluateBuildingTrail(ladder) &&
    !ladder.buildingTrailActive &&
    buildingTrailActivationReached(ladder.side!, ladder.entryPrice, price)
  );
}

export async function cancelOpenLadderEntries(ladder: LadderState): Promise<number> {
  let canceled = 0;
  for (const o of ladder.entryOrders.filter((eo) => eo.status === 'OPEN')) {
    try {
      await cancelByClientOrderId(o.clientOrderId);
      o.status = 'CANCELED';
      canceled++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[Build] Could not cancel ladder entry ${o.clientOrderId}`, { error: msg });
    }
  }
  return canceled;
}

/** Arm building trail: cancel pending ladder orders and record the activation peak. */
export async function activateBuildingTrail(ladder: LadderState, price: number): Promise<void> {
  const side = ladder.side!;
  const dir = side === 'LONG' ? 1 : -1;
  ladder.buildingTrailActive = true;
  ladder.buildingPeakPrice = dir === 1 ? Math.max(ladder.entryPrice, price) : Math.min(ladder.entryPrice, price);

  const canceled = await cancelOpenLadderEntries(ladder);
  logger.info(
    `[Build] Building trail activated at ${price} (peak ${ladder.buildingPeakPrice}, canceled ${canceled} ladder orders)`
  );
}

/**
 * Ratchet building peak and decide whether the exchange SL should be re-placed.
 * Mutates ladder.buildingPeakPrice.
 */
export function evaluateBuildingTrail(
  ladder: LadderState,
  price: number,
  tickSize: number,
  minStepPct: number = BUILDING_TRAIL_MIN_STEP_PCT
): boolean {
  if (!ladder.buildingTrailActive || !canEvaluateBuildingTrail(ladder) || price <= 0) {
    return false;
  }

  const side = ladder.side!;
  const dir = side === 'LONG' ? 1 : -1;
  const base =
    ladder.buildingPeakPrice && ladder.buildingPeakPrice > 0
      ? ladder.buildingPeakPrice
      : ladder.entryPrice;
  ladder.buildingPeakPrice = dir === 1 ? Math.max(base, price) : Math.min(base, price);

  const desiredSl = computeBuildingTrailSlPrice(
    side,
    ladder.entryPrice,
    ladder.buildingPeakPrice,
    tickSize
  );

  if (wouldSlTriggerNow(side, desiredSl, price, tickSize)) return false;

  const currentSl = ladder.slPrice ?? 0;
  if (currentSl <= 0 || ladder.slIsCatastrophic) return true;

  const improvement = (desiredSl - currentSl) * dir;
  return improvement >= ladder.entryPrice * minStepPct;
}
