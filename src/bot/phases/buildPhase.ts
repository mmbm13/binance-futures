import {
  LADDER_LEVELS,
  LADDER_SIZE_MULT,
  MAX_LADDER_SPACING_PCT,
  MIN_LADDER_SPACING_PCT,
  SYMBOL,
  BUCKET_SIZE,
  WALLS_TO_KEEP,
} from '../config';
import { client } from '../client';
import { cancelByClientOrderId, getPosition, syncLadderWithExchange } from '../exchange';
import {
  computeSlotsRemaining,
  countFilledOnSide,
  countOpenOnSide,
  effectiveLadderLevels,
  getLadderCoverage,
  shouldTopUpLadder,
} from '../ladder/coverage';
import { formatLadderSizingError, validateLadderWithSlGeometry } from '../ladder/sizing';
import { ladderOrdersForSide, simulatePlannedLadderPrices } from '../ladder/projection';
import {
  activeEntrySide,
  getSpacingRefPrices,
  getUsedPricesOnSide,
} from '../ladder/spacing';
import { orderBookCollector } from '../orderbook';
import { stateManager, BotPhase } from '../state';
import { EntryOrder, LadderState, SymbolPrecision } from '../types';
import { isHarvestMode, isPostPartialPosition, repairHarvestState } from './harvestMode';
import { botPhaseForLadder } from './types';
import { logger } from '../../utils/logger';

export interface BuildPhaseHost {
  ladder: LadderState | null;
  precision: SymbolPrecision;
  refreshWalls(): boolean;
  refreshExits(): Promise<void>;
}

export async function handleFirstFill(
  ladder: LadderState,
  entry: EntryOrder,
  fillPrice: number,
  placeLadder: () => Promise<void>
): Promise<void> {
  ladder.side = entry.side === 'BUY' ? 'LONG' : 'SHORT';
  const opposite = ladder.entryOrders.find(
    (o) => o.clientOrderId !== entry.clientOrderId && o.status === 'OPEN'
  );
  if (opposite) {
    try {
      await cancelByClientOrderId(opposite.clientOrderId);
      logger.info(`[Build] Canceled opposite entry ${opposite.clientOrderId}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[Build] Could not cancel opposite entry ${opposite.clientOrderId}`, { error: msg });
    }
    opposite.status = 'CANCELED';
  }

  await stateManager.updatePhase(
    botPhaseForLadder(ladder),
    undefined,
    undefined,
    undefined,
    fillPrice,
    ladder.side
  );
  ladder.ladderStep = 1;
  await placeLadder();
}

export async function handleSubsequentFill(
  ladder: LadderState,
  entry: EntryOrder,
  placeLadder: () => Promise<void>
): Promise<void> {
  if (
    entry.side !== activeEntrySide(ladder.side!) ||
    ladder.windingDown ||
    isHarvestMode(ladder)
  ) {
    return;
  }

  const entrySide = activeEntrySide(ladder.side!);
  const filled = countFilledOnSide(ladder, entrySide);
  ladder.ladderStep = filled;
  const open = countOpenOnSide(ladder, entrySide);

  if (shouldTopUpLadder(ladder, filled, open, effectiveLadderLevels(ladder))) {
    await placeLadder();
  }
}

/** True when straddle/ladder filled but entry limits are missing on the exchange. */
export function needsLadderPlacement(
  ladder: LadderState,
  exchangeEntryCount: number,
  ladderLevels: number = LADDER_LEVELS
): boolean {
  if (!ladder.side || ladder.windingDown || ladder.partialCloses > 0) return false;
  const entrySide = activeEntrySide(ladder.side);
  const filled = countFilledOnSide(ladder, entrySide);
  const open = countOpenOnSide(ladder, entrySide);
  if (filled < 1 || exchangeEntryCount > 0) return false;
  if (isPostPartialPosition(ladder, ladder.posQty)) {
    return false;
  }
  return getLadderCoverage(ladder, filled, open) < ladderLevels;
}

export async function placeLadderOrders(host: BuildPhaseHost): Promise<void> {
  const l = host.ladder;
  if (!l || !l.side) return;

  const { tickSize, stepSize, minQty, minNotional } = host.precision;
  const pos = await getPosition();
  if (pos.qty > 0) {
    l.posQty = pos.qty;
    l.entryPrice = pos.entry;
  }

  const { exchangeEntryCount } = await syncLadderWithExchange(l);

  if (repairHarvestState(l, pos.qty, exchangeEntryCount, stepSize)) {
    logger.warn(
      `[Build] Harvest phase detected (pos ${pos.qty}, exchange entries ${exchangeEntryCount}) — skipping ladder`
    );
    await stateManager.updatePhase('HARVESTING', undefined, undefined, undefined, l.entryPrice, l.side);
    await persistLadderState(l, 'HARVESTING');
    await host.refreshExits();
    return;
  }
  if (l.windingDown || isHarvestMode(l, undefined, pos.qty, exchangeEntryCount, stepSize)) return;
  if (l.ladderSizingBlocked) {
    logger.info('[Build] Ladder sizing blocked — not placing more levels');
    return;
  }

  host.refreshWalls();

  const levels = effectiveLadderLevels(l);
  const entrySide = activeEntrySide(l.side);
  const filledOnSide = countFilledOnSide(l, entrySide);
  const openOnSide = countOpenOnSide(l, entrySide);
  const slotsRemaining = computeSlotsRemaining(l, filledOnSide, openOnSide, levels);

  if (slotsRemaining <= 0) return;

  const refs = getSpacingRefPrices(l);
  const usedPrices = getUsedPricesOnSide(l);

  const existingOrders = ladderOrdersForSide(l);
  const existingPrices = existingOrders.map((o) => o.price);
  const newPrices = simulatePlannedLadderPrices(l, slotsRemaining, tickSize);
  const allPrices = [...existingPrices, ...newPrices];

  const firstFilled = existingOrders.find((o) => o.status === 'FILLED');
  const fixedFirstQty = firstFilled?.qty ?? l.baseQty;

  const sizing = validateLadderWithSlGeometry(
    allPrices,
    l.side!,
    l.baseQty,
    l.riskAmount,
    stepSize,
    minQty,
    minNotional,
    tickSize,
    LADDER_SIZE_MULT,
    fixedFirstQty
  );

  if (!sizing.valid) {
    logger.error('[Build] Ladder sizing infeasible — skipping placement', {
      levels,
      error: formatLadderSizingError(sizing, levels),
      prices: allPrices,
      quantities: sizing.quantities,
      riskAmount: l.riskAmount.toFixed(2),
      posQty: pos.qty,
      exchangeEntryCount,
    });
    const { exchangeEntryCount: exchangeEntries } = await syncLadderWithExchange(l);
    if (repairHarvestState(l, pos.qty, exchangeEntries, stepSize)) {
      logger.warn('[Build] Sizing infeasible but post-partial — switching to HARVESTING');
      await stateManager.updatePhase('HARVESTING', undefined, undefined, undefined, l.entryPrice, l.side);
      await persistLadderState(l, 'HARVESTING');
      await host.refreshExits();
      return;
    }
    l.ladderSizingBlocked = true;
    logger.warn('[Build] Ladder cannot extend further at current account size — sizing blocked');
    await host.refreshExits();
    return;
  }

  const quantities = sizing.quantities!;

  logger.info('[Build] Risk-sized ladder quantities', {
    prices: allPrices,
    quantities,
    riskAmount: l.riskAmount.toFixed(2),
    slBeyondDeepest: true,
  });

  const startLevel = levels - slotsRemaining + 1;
  for (let i = 0; i < slotsRemaining; i++) {
    const level = startLevel + i;
    const orderPrice = newPrices[i];
    const qty = quantities[level - 1];

    try {
      const res = await client.submitNewOrder({
        symbol: SYMBOL,
        side: entrySide,
        type: 'LIMIT',
        price: orderPrice,
        quantity: qty,
        timeInForce: 'GTC',
      });
      l.entryOrders.push({
        clientOrderId: res.clientOrderId,
        side: entrySide,
        price: orderPrice,
        qty,
        status: 'OPEN',
      });
      l.usedWalls.push(orderPrice);
      refs.push(orderPrice);
      usedPrices.push(orderPrice);
      logger.info(
        `[Build] Ladder order ${level} placed: ${entrySide} ${qty} @ ${orderPrice} ` +
          `(SL beyond deepest, max loss $${l.riskAmount.toFixed(2)})`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[Build] Failed to place ladder order ${entrySide} ${qty} @ ${orderPrice}`, { error: msg });
    }
  }
}

export function refreshLadderWalls(ladder: LadderState | null): boolean {
  if (!ladder) return false;
  if (!orderBookCollector.isSynced) {
    logger.warn('[Build] Book not synced yet, skipping wall refresh');
    return false;
  }
  const snap = orderBookCollector.getWalls(BUCKET_SIZE, WALLS_TO_KEEP);
  ladder.buyWalls = snap.buyWalls;
  ladder.sellWalls = snap.sellWalls;
  logger.info('[Build] Walls refreshed', {
    buyWalls: ladder.buyWalls.length,
    sellWalls: ladder.sellWalls.length,
    price: snap.currentPrice,
  });
  return true;
}

export async function persistLadderState(
  ladder: LadderState | null,
  phase?: BotPhase
): Promise<void> {
  const currentPhase = phase ?? (await stateManager.getState()).phase;
  await stateManager.updatePhase(currentPhase, undefined, { ladder });
}
