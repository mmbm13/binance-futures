import {
  BUILDING_TRAIL_ACTIVATION_PCT,
  BUILDING_TRAIL_ENABLED,
  BUILDING_TRAIL_FLOOR_PCT,
  BUILDING_TRAIL_KLINE_LOOKBACK,
  BUILDING_TRAIL_MIN_STEP_PCT,
  SYMBOL,
} from '../config';
import { client } from '../client';
import { cancelByClientOrderId } from '../exchange';
import { LadderState } from '../types';
import { roundStep } from '../math';
import { computeBuildingTrailSlPrice, wouldSlTriggerNow } from './exitPricing';
import { logger } from '../../utils/logger';

/** First fill with trail enabled — fixed TP omitted until activation. */
export function isAwaitingBuildingTrail(ladder: LadderState | null): boolean {
  return canEvaluateBuildingTrail(ladder) && !ladder!.buildingTrailActive;
}

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

/** True when building trail is armed and the position should be managed by trail logic. */
export function canManageBuildingTrail(ladder: LadderState | null): boolean {
  if (!BUILDING_TRAIL_ENABLED) return false;
  return Boolean(
    ladder?.buildingTrailActive &&
      ladder.side &&
      ladder.partialCloses === 0 &&
      !ladder.windingDown &&
      ladder.posQty > 0 &&
      ladder.entryPrice > 0
  );
}

/** Ratchet the best favorable price seen while awaiting trail activation. */
export function ratchetAwaitingTrailPeak(ladder: LadderState, price: number): void {
  if (!isAwaitingBuildingTrail(ladder) || !ladder.side || price <= 0) return;
  const dir = ladder.side === 'LONG' ? 1 : -1;
  const base =
    ladder.buildingPeakPrice && ladder.buildingPeakPrice > 0
      ? ladder.buildingPeakPrice
      : ladder.entryPrice;
  ladder.buildingPeakPrice = dir === 1 ? Math.max(base, price) : Math.min(base, price);
}

export function shouldActivateBuildingTrail(ladder: LadderState, price: number): boolean {
  if (!canEvaluateBuildingTrail(ladder) || ladder.buildingTrailActive) return false;
  ratchetAwaitingTrailPeak(ladder, price);
  const peak = ladder.buildingPeakPrice ?? price;
  return buildingTrailActivationReached(ladder.side!, ladder.entryPrice, peak);
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

/**
 * When price sits on the profit floor, the raw floor SL would be rejected as
 * "immediately triggering". Nudge it one tick beyond the floor so it arms.
 */
export function armBuildingTrailSlAtFloor(
  side: 'LONG' | 'SHORT',
  floorSl: number,
  tickSize: number
): number {
  if (floorSl <= 0) return 0;
  const dir = side === 'LONG' ? 1 : -1;
  return Math.max(tickSize, roundStep(floorSl - dir * tickSize * 2, tickSize));
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

/** Activate building trail when price has reached the threshold. Returns true if armed. */
export async function tryActivateBuildingTrailIfNeeded(
  ladder: LadderState | null,
  price: number
): Promise<boolean> {
  if (!ladder || !shouldActivateBuildingTrail(ladder, price)) return false;
  const activationPrice = ladder.buildingPeakPrice ?? price;
  await activateBuildingTrail(ladder, activationPrice);
  return true;
}

/**
 * Backfill the awaiting-trail peak from recent 1m klines so a fast spike is not
 * lost when bookTicker ticks were missed or the process restarted.
 */
export async function recoverAwaitingTrailPeakFromKlines(
  ladder: LadderState,
  lookback: number = BUILDING_TRAIL_KLINE_LOOKBACK
): Promise<number | null> {
  if (!isAwaitingBuildingTrail(ladder) || !ladder.side || lookback <= 0) return null;

  try {
    const raw = await client.getKlines({ symbol: SYMBOL, interval: '1m', limit: lookback });
    const before = ladder.buildingPeakPrice ?? ladder.entryPrice;
    for (const k of raw) {
      const extreme = ladder.side === 'LONG' ? Number(k[2]) : Number(k[3]);
      if (Number.isFinite(extreme) && extreme > 0) {
        ratchetAwaitingTrailPeak(ladder, extreme);
      }
    }
    const after = ladder.buildingPeakPrice ?? before;
    if (after !== before) {
      logger.info(
        `[Build] Recovered awaiting-trail peak from klines: ${before.toFixed(2)} → ${after.toFixed(2)} (${lookback}×1m)`
      );
    }
    return after;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('[Build] Could not recover awaiting-trail peak from klines', { error: msg });
    return null;
  }
}

export function logAwaitingTrailStatus(ladder: LadderState, price: number): void {
  if (!isAwaitingBuildingTrail(ladder) || !ladder.side || price <= 0) return;
  const dir = ladder.side === 'LONG' ? 1 : -1;
  const threshold = ladder.entryPrice * (1 + dir * BUILDING_TRAIL_ACTIVATION_PCT);
  const peak = ladder.buildingPeakPrice ?? ladder.entryPrice;
  logger.info(
    `[Build] Awaiting trail: ${ladder.side} entry ${ladder.entryPrice.toFixed(2)}, ` +
      `mark ${price.toFixed(2)}, peak ${peak.toFixed(2)}, activate @ ${threshold.toFixed(2)}`
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
  if (!ladder.buildingTrailActive || !canManageBuildingTrail(ladder) || price <= 0) {
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

export function buildingTrailFloorPrice(
  side: 'LONG' | 'SHORT',
  entry: number,
  floorPct: number = BUILDING_TRAIL_FLOOR_PCT
): number {
  const dir = side === 'LONG' ? 1 : -1;
  return entry * (1 + dir * floorPct);
}

/** True when price retraces through the profit floor while trail SL is not yet armed. */
export function buildingTrailFloorBreached(
  ladder: LadderState,
  price: number,
  tickSize: number,
  floorPct: number = BUILDING_TRAIL_FLOOR_PCT
): boolean {
  if (!ladder.buildingTrailActive || !ladder.side || price <= 0) return false;
  if (!ladder.slIsCatastrophic && ladder.slPrice && ladder.slPrice > 0) return false;
  const floor = buildingTrailFloorPrice(ladder.side, ladder.entryPrice, floorPct);
  return wouldSlTriggerNow(ladder.side, floor, price, tickSize);
}

/**
 * Spike protection while awaiting trail: peak once reached activation but SL never
 * armed (missed tick, refresh failure) — close at market if price gives back the floor.
 */
export function awaitingTrailGivebackBreached(
  ladder: LadderState,
  price: number,
  tickSize: number,
  floorPct: number = BUILDING_TRAIL_FLOOR_PCT
): boolean {
  if (!isAwaitingBuildingTrail(ladder) || !ladder.side || price <= 0) return false;
  const peak = ladder.buildingPeakPrice ?? 0;
  if (peak <= 0) return false;
  if (!buildingTrailActivationReached(ladder.side, ladder.entryPrice, peak)) return false;
  const floor = buildingTrailFloorPrice(ladder.side, ladder.entryPrice, floorPct);
  return wouldSlTriggerNow(ladder.side, floor, price, tickSize);
}

/** Market close when awaiting trail after a missed activation and floor giveback. */
export async function executeAwaitingTrailGivebackClose(
  ladder: LadderState,
  price: number,
  tickSize: number = 0.01
): Promise<boolean> {
  if (!awaitingTrailGivebackBreached(ladder, price, tickSize)) return false;

  const closeSide = ladder.side === 'LONG' ? 'SELL' : 'BUY';
  const peak = ladder.buildingPeakPrice ?? price;
  logger.warn(
    `[Build] Awaiting-trail giveback @ ${price} (peak ${peak}, floor ${buildingTrailFloorPrice(ladder.side!, ladder.entryPrice).toFixed(4)}) — closing at market`
  );

  try {
    await client.submitNewOrder({
      symbol: SYMBOL,
      side: closeSide,
      type: 'MARKET',
      quantity: ladder.posQty,
      reduceOnly: 'true',
    });
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('[Build] Awaiting-trail giveback close failed', { error: msg });
    return false;
  }
}

/** Market close when floor is breached before the trailing SL could be placed. */
export async function executeBuildingTrailFloorClose(
  ladder: LadderState,
  price: number,
  tickSize: number = 0.01
): Promise<boolean> {
  if (!buildingTrailFloorBreached(ladder, price, tickSize)) return false;

  const closeSide = ladder.side === 'LONG' ? 'SELL' : 'BUY';
  logger.info(
    `[Build] Building trail floor breached @ ${price} (floor ${buildingTrailFloorPrice(ladder.side!, ladder.entryPrice).toFixed(4)}) — closing at market`
  );

  try {
    await client.submitNewOrder({
      symbol: SYMBOL,
      side: closeSide,
      type: 'MARKET',
      quantity: ladder.posQty,
      reduceOnly: 'true',
    });
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('[Build] Building trail floor close failed', { error: msg });
    return false;
  }
}
