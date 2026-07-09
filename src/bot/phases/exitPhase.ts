import { SYMBOL, CATASTROPHIC_SL_MULT, TP_REWARD_RATIO } from '../config';
import { client } from '../client';
import { cancelAllOrders, cancelByClientOrderId, getPosition, syncLadderWithExchange, syncLadderSideFromPosition } from '../exchange';
import { formatError } from '../errors';
import { orderBookCollector } from '../orderbook';
import { stateManager } from '../state';
import { LadderState, PositionSnapshot, SymbolPrecision } from '../types';
import { countFilledOnSide, countOpenOnSide, effectiveLadderLevels } from '../ladder/coverage';
import { activeEntrySide } from '../ladder/spacing';
import { buildExitPriceOptions } from './exitPricingContext';
import { computeCatastrophicSlPrice, computeExitPrices, wouldSlTriggerNow } from './exitPricing';
import { isHarvestMode, repairHarvestState } from './harvestMode';
import { botPhaseForLadder } from './types';
import { logger } from '../../utils/logger';

export interface ExitPhaseHost {
  ladder: LadderState | null;
  precision: SymbolPrecision;
  refreshingExits: boolean;
  setRefreshingExits(v: boolean): void;
  startNextCycle: () => Promise<void>;
}

/**
 * Backstop STOP_MARKET so the position is never left without an exchange-side stop
 * when the normal SL is skipped (deferred ladder SL, infeasible geometry, harvest near-SL).
 * Max loss at current qty = riskAmount × CATASTROPHIC_SL_MULT.
 */
async function placeCatastrophicSl(
  l: LadderState,
  pos: PositionSnapshot,
  closeSide: 'BUY' | 'SELL',
  currentPrice: number,
  tickSize: number,
  reason: string
): Promise<void> {
  l.slAlgoId = null;
  l.slPrice = null;
  l.slIsCatastrophic = false;

  const slPrice = computeCatastrophicSlPrice(pos.side!, pos.entry, pos.qty, l.riskAmount, tickSize);
  if (slPrice <= 0) {
    logger.error('[Exit] Cannot compute catastrophic SL — position UNPROTECTED', { reason, pos });
    return;
  }

  if (currentPrice > 0 && wouldSlTriggerNow(pos.side!, slPrice, currentPrice, tickSize)) {
    logger.error(
      `[Exit] Catastrophic SL @ ${slPrice} would trigger now (price ${currentPrice}) — closing at market (${reason})`
    );
    try {
      await client.submitNewOrder({
        symbol: SYMBOL,
        side: closeSide,
        type: 'MARKET',
        quantity: pos.qty,
        reduceOnly: 'true',
      });
    } catch (e: unknown) {
      logger.error('[Exit] Emergency market close failed', { error: formatError(e) });
    }
    return;
  }

  try {
    const res = await client.submitNewAlgoOrder({
      algoType: 'CONDITIONAL',
      symbol: SYMBOL,
      side: closeSide,
      type: 'STOP_MARKET',
      triggerPrice: slPrice,
      closePosition: 'true',
    });
    l.slAlgoId = Number(res.algoId);
    l.slPrice = slPrice;
    l.slIsCatastrophic = true;
    logger.warn(
      `[Exit] Catastrophic backstop SL placed: ${closeSide} STOP_MARKET @ ${slPrice} ` +
        `(max loss $${(l.riskAmount * CATASTROPHIC_SL_MULT).toFixed(2)} = ${CATASTROPHIC_SL_MULT}× risk — ${reason})`
    );
  } catch (e: unknown) {
    logger.error('[Exit] FAILED to place catastrophic SL — position UNPROTECTED', {
      error: formatError(e),
      slPrice,
      reason,
    });
  }
}

export async function refreshExits(host: ExitPhaseHost): Promise<void> {
  const l = host.ladder;
  if (!l || !l.side) return;

  host.setRefreshingExits(true);
  try {
    const pos = await getPosition();
    if (pos.qty === 0 || !pos.side) return;

    syncLadderSideFromPosition(l, pos, 'Exit');
    l.posQty = pos.qty;
    l.entryPrice = pos.entry;

    const tradeSide = pos.side;

    const { exchangeEntryCount } = await syncLadderWithExchange(l);
    const repaired = repairHarvestState(l, pos.qty, exchangeEntryCount, host.precision.stepSize);
    if (repaired) {
      logger.warn(
        `[Exit] Repaired harvest state (pos ${pos.qty}, exchange entries ${exchangeEntryCount})`
      );
    }

    const harvestMode = isHarvestMode(l, undefined, pos.qty, exchangeEntryCount, host.precision.stepSize);
    await stateManager.updatePhase(
      harvestMode ? 'HARVESTING' : botPhaseForLadder(l),
      undefined,
      undefined,
      undefined,
      pos.entry,
      tradeSide
    );
    let currentPrice = orderBookCollector.currentPrice;
    if (currentPrice <= 0) {
      try {
        const priceRes = await client.getMarkPrice({ symbol: SYMBOL });
        currentPrice = parseFloat((priceRes as { markPrice: string }).markPrice);
      } catch { /* bookTicker will catch up */ }
    }

    if (harvestMode) {
      const dir = tradeSide === 'LONG' ? 1 : -1;
      const base = l.harvestPeakPrice && l.harvestPeakPrice > 0 ? l.harvestPeakPrice : pos.entry;
      l.harvestPeakPrice =
        currentPrice > 0
          ? dir === 1
            ? Math.max(base, currentPrice)
            : Math.min(base, currentPrice)
          : base;
    } else if (l.buildingTrailActive) {
      const dir = tradeSide === 'LONG' ? 1 : -1;
      const base = l.buildingPeakPrice && l.buildingPeakPrice > 0 ? l.buildingPeakPrice : pos.entry;
      l.buildingPeakPrice =
        currentPrice > 0
          ? dir === 1
            ? Math.max(base, currentPrice)
            : Math.min(base, currentPrice)
          : base;
    }

    const exitOptions = buildExitPriceOptions(
      l,
      host.precision,
      harvestMode,
      currentPrice,
      exchangeEntryCount
    );
    const exits = computeExitPrices(
      tradeSide,
      pos.entry,
      pos.qty,
      l.riskAmount,
      host.precision.tickSize,
      TP_REWARD_RATIO,
      exitOptions
    );
    const { slPrice, tpPrice, tpTargetUsd, closeSide, mode, skipSl, skipTp } = exits;
    const slFromFullLadder = Boolean(exitOptions.buildingSlProjection);
    const deferSl = Boolean(exitOptions.deferBuildingSl);

    try {
      await client.cancelAllAlgoOpenOrders({ symbol: SYMBOL });
    } catch { /* none open is fine */ }

    if (l.tpClientOrderId) {
      try {
        await cancelByClientOrderId(l.tpClientOrderId);
      } catch { /* already gone is fine */ }
      l.tpClientOrderId = null;
    }

    if (!skipSl) {
      try {
        const slLabel = harvestMode
          ? `harvest SL ${((exits.slDistance / pos.entry) * 100).toFixed(2)}% ` +
            `(breakeven/trail, peak ${l.harvestPeakPrice ?? '?'})`
          : l.buildingTrailActive
            ? `building trail SL ${((exits.slDistance / pos.entry) * 100).toFixed(2)}% ` +
              `(floor/trail, peak ${l.buildingPeakPrice ?? '?'})`
            : slFromFullLadder
            ? `full ladder max loss $${l.riskAmount.toFixed(2)} beyond deepest rung`
            : `max loss $${l.riskAmount.toFixed(2)} (${((exits.slDistance / pos.entry) * 100).toFixed(2)}%)`;
        logger.info(
          `[Exit] Placing SL: ${tradeSide} pos → ${closeSide} STOP_MARKET @ ${slPrice} (${slLabel})`
        );
        const slRes = await client.submitNewAlgoOrder({
          algoType: 'CONDITIONAL',
          symbol: SYMBOL,
          side: closeSide,
          type: 'STOP_MARKET',
          triggerPrice: slPrice,
          closePosition: 'true',
        });
        l.slAlgoId = Number(slRes.algoId);
        l.slPrice = slPrice;
        l.slIsCatastrophic = false;
        logger.info(`[Exit] SL updated: ${closeSide} STOP_MARKET @ ${slPrice}`);
      } catch (e: unknown) {
        const msg = formatError(e);
        logger.error('[Exit] FAILED to place SL', { error: msg, slPrice });
        if (msg.toLowerCase().includes('immediately trigger')) {
          if (harvestMode) {
            logger.warn('[Exit] Harvest SL rejected (immediate trigger) — placing catastrophic backstop.');
            await placeCatastrophicSl(l, pos, closeSide, currentPrice, host.precision.tickSize, 'harvest SL rejected');
          } else {
            logger.warn('[Exit] SL would trigger immediately — closing at market.');
            try {
              await client.submitNewOrder({
                symbol: SYMBOL,
                side: closeSide,
                type: 'MARKET',
                quantity: pos.qty,
                reduceOnly: 'true',
              });
            } catch (closeErr: unknown) {
              logger.error('[Exit] Emergency market close failed', { error: formatError(closeErr) });
            }
            return;
          }
        } else {
          l.slAlgoId = null;
          l.slPrice = null;
        }
      }
    } else if (deferSl) {
      const entrySide = l.side ? activeEntrySide(l.side) : null;
      const placed = entrySide ? countFilledOnSide(l, entrySide) + countOpenOnSide(l, entrySide) : 0;
      const deepest = exitOptions.buildingSlProjection?.deepestPrice;
      const levels = effectiveLadderLevels(l);
      logger.info(
        `[Exit] SL deferred: ${placed}/${levels} ladder orders placed ` +
          `(SL @ ${slPrice}${deepest != null ? ` beyond deepest ${deepest}` : ''} — max loss $${l.riskAmount.toFixed(2)} when full ladder fills)`
      );
      await placeCatastrophicSl(l, pos, closeSide, currentPrice, host.precision.tickSize, 'building SL deferred');
    } else if (skipSl && !harvestMode) {
      logger.error(
        `[Exit] Normal SL skipped: ladder geometry infeasible — cannot place SL beyond deepest rung ` +
          `(deepest ${exitOptions.buildingSlProjection?.deepestPrice ?? '?'}, risk $${l.riskAmount.toFixed(2)})`
      );
      await placeCatastrophicSl(l, pos, closeSide, currentPrice, host.precision.tickSize, 'ladder geometry infeasible');
    } else {
      logger.warn(
        `[Exit] Harvest SL near current price ${currentPrice} — placing catastrophic backstop, TP @ ${tpPrice}`
      );
      await placeCatastrophicSl(l, pos, closeSide, currentPrice, host.precision.tickSize, 'harvest SL would trigger');
    }

    if (!skipTp) {
      try {
        const tpRes = await client.submitNewOrder({
          symbol: SYMBOL,
          side: closeSide,
          type: 'LIMIT',
          price: tpPrice,
          quantity: pos.qty,
          timeInForce: 'GTC',
          reduceOnly: 'true',
        });
        l.tpClientOrderId = tpRes.clientOrderId;
        logger.info(
          `[Exit] TP updated (${mode}): ${tradeSide} pos → ${closeSide} LIMIT ${pos.qty} @ ${tpPrice} ` +
            `(target $${tpTargetUsd.toFixed(2)}, ${((exits.tpDistance / pos.entry) * 100).toFixed(2)}% from entry)`
        );
      } catch (e: unknown) {
        logger.error('[Exit] FAILED to place TP', { error: formatError(e), tpPrice });
      }
    } else {
      l.tpClientOrderId = null;
      logger.info(
        `[Exit] Fixed TP omitted (${mode} trail): trailing SL @ ${slPrice}, peak ${l.buildingPeakPrice ?? '?'}`
      );
    }
  } finally {
    host.setRefreshingExits(false);
  }
}

export async function finalizeCycle(host: ExitPhaseHost, exitPrice: number): Promise<void> {
  logger.info('[Exit] Position fully closed. Finalizing cycle.');
  const state = await stateManager.getState();
  const finalPnl = state.current_pnl || 0;

  if (state.cycle_id) {
    await stateManager.saveTrade({
      cycle_id: state.cycle_id,
      symbol: SYMBOL,
      side: host.ladder?.side || state.active_side || 'UNKNOWN',
      entry_price: host.ladder?.entryPrice || state.entry_price || 0,
      exit_price: exitPrice,
      pnl: finalPnl,
      realized_pnl: finalPnl,
      strategy: 'ladder',
      qty: host.ladder?.posQty,
      fees: host.ladder?.feesPaid ?? 0,
      meta: {
        fills: host.ladder?.fills ?? 0,
        partialCloses: host.ladder?.partialCloses ?? 0,
      },
    });
    logger.info(`[Exit] Cycle complete. Realized PnL: $${finalPnl.toFixed(2)}`);
  }

  await cancelAllOrders();
  host.ladder = null;
  orderBookCollector.stopDepth();
  await stateManager.updatePhase('IDLE');

  setTimeout(() => {
    host.startNextCycle().catch((e) => logger.error('[Exit] Error starting next cycle', { error: e }));
  }, 3_000);
}
