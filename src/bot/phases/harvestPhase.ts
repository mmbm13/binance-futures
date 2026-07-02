import { SYMBOL, TAKER_FEE } from '../config';
import { client } from '../client';
import { cancelByClientOrderId, getPosition, syncLadderSideFromPosition } from '../exchange';
import { formatError } from '../errors';
import { sleep } from '../math';
import { stateManager } from '../state';
import { LadderState, SymbolPrecision } from '../types';
import { evaluatePartialClose } from './partialClose';
import { persistLadderState } from './buildPhase';
import { logger } from '../../utils/logger';

export interface HarvestPhaseHost {
  ladder: LadderState | null;
  precision: SymbolPrecision;
  refreshExits(): Promise<void>;
  isPartialCloseInFlight(): boolean;
  setPartialCloseInFlight(v: boolean): void;
}

export function canEvaluatePartialClose(ladder: LadderState | null): boolean {
  return Boolean(
    ladder?.side &&
      !ladder.windingDown &&
      ladder.fills >= 2 &&
      ladder.partialCloses < ladder.fills - 1
  );
}

export async function executePartialClose(
  host: HarvestPhaseHost,
  price: number
): Promise<boolean> {
  const l = host.ladder;
  if (!l || host.isPartialCloseInFlight()) return false;

  const pos = await getPosition();
  if (pos.qty <= 0 || !pos.side) return false;
  syncLadderSideFromPosition(l, pos, 'Harvest');
  l.posQty = pos.qty;
  l.entryPrice = pos.entry;

  const evaluation = evaluatePartialClose({
    ladder: l,
    price,
    stepSize: host.precision.stepSize,
    minQty: host.precision.minQty,
    takerFee: TAKER_FEE,
  });

  if (!evaluation.shouldClose || evaluation.closeQty === undefined) {
    return false;
  }

  const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
  logger.info(
    `[Harvest] Partial close (${pos.side}): ${closeSide} reduceOnly ${evaluation.closeQty} → keep ${evaluation.keepQty} ` +
      `(PnL $${evaluation.unrealized!.toFixed(2)} > threshold $${evaluation.profitThreshold!.toFixed(2)} ` +
      `fees $${evaluation.feeThreshold!.toFixed(2)} + min $${evaluation.minPartialProfit!.toFixed(2)} ` +
      `from risk $${l.riskAmount.toFixed(2)})`
  );

  host.setPartialCloseInFlight(true);
  try {
    await client.submitNewOrder({
      symbol: SYMBOL,
      side: closeSide,
      type: 'MARKET',
      quantity: evaluation.closeQty,
      reduceOnly: 'true',
    });
  } catch (e: unknown) {
    logger.error('[Harvest] Partial close failed', { error: formatError(e) });
    return false;
  } finally {
    host.setPartialCloseInFlight(false);
  }

  l.partialCloses++;
  l.feesPaid += evaluation.closeQty * price * TAKER_FEE;
  l.ladderStep = 1;

  await sleep(300);
  const posAfter = await getPosition();
  if (posAfter.side) syncLadderSideFromPosition(l, posAfter, 'Harvest');
  l.posQty = posAfter.qty;
  l.entryPrice = posAfter.entry;

  if (posAfter.qty > 0 && posAfter.side) {
    l.windingDown = true;
    // Trailing starts from the price that triggered the harvest (favorable by definition).
    l.harvestPeakPrice = price;
    await stateManager.updatePhase('HARVESTING', undefined, undefined, undefined, posAfter.entry, posAfter.side);
    await persistLadderState(l, 'HARVESTING');

    for (const o of l.entryOrders.filter((eo) => eo.status === 'OPEN')) {
      try {
        await cancelByClientOrderId(o.clientOrderId);
        o.status = 'CANCELED';
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`[Harvest] Could not cancel entry ${o.clientOrderId}`, { error: msg });
      }
    }
    logger.info('[Harvest] Ladder entries canceled; placing harvest TP/SL (symmetric % exits)');
    await host.refreshExits();
  }

  return true;
}
