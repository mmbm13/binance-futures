import { client } from './client';
import { stateManager, BotState, BotPhase } from './state';
import { orderBookCollector } from './orderbook';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

export { SYMBOL } from './config';
import {
  SYMBOL,
  LEVERAGE,
  LADDER_LEVELS,
  LADDER_SIZE_MULT,
  ACCOUNT_RISK_PERCENT,
  TP_REWARD_RATIO,
  MIN_LADDER_SPACING_PCT,
  MAX_LADDER_SPACING_PCT,
  MAKER_FEE,
} from './config';
import { LadderState, SymbolPrecision } from './types';
import { sleep } from './math';
import {
  getAccountBalance,
  getPosition,
  cancelAllOrders,
  isOpenOnExchange,
  syncLadderWithExchange,
  countExchangeEntryOrders,
  syncLadderSideFromPosition,
} from './exchange';
import { enterCollectPhase, stopCollectTimer } from './phases/collectPhase';
import { placeStraddleOrders } from './phases/straddlePhase';
import {
  handleFirstFill,
  handleSubsequentFill,
  placeLadderOrders as runPlaceLadderOrders,
  needsLadderPlacement,
  refreshLadderWalls,
  persistLadderState,
  BuildPhaseHost,
} from './phases/buildPhase';
import {
  canEvaluatePartialClose,
  executePartialClose,
  HarvestPhaseHost,
} from './phases/harvestPhase';
import {
  refreshExits as runRefreshExits,
  finalizeCycle as runFinalizeCycle,
  ExitPhaseHost,
} from './phases/exitPhase';
import { isInTradePhase, resolveCyclePhase, botPhaseForLadder } from './phases/types';
import { isHarvestMode, repairHarvestState } from './phases/harvestMode';
import { evaluateHarvestTrail } from './phases/harvestTrail';
import {
  activateBuildingTrail,
  buildingTrailFloorBreached,
  canEvaluateBuildingTrail,
  evaluateBuildingTrail,
  executeBuildingTrailFloorClose,
  shouldActivateBuildingTrail,
} from './phases/buildingTrail';

// ─── Bot Engine (orchestrator) ───────────────────────────────────────────────
export const botEngine = {
  state: null as BotState | null,
  ladder: null as LadderState | null,
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
  initialized: false,
  _collectTimer: null as NodeJS.Timeout | null,
  _lastTickEval: 0,
  _refreshingExits: false,
  _partialCloseInFlight: false,
  _chain: Promise.resolve() as Promise<unknown>,

  get precision(): SymbolPrecision {
    return {
      tickSize: this.tickSize,
      stepSize: this.stepSize,
      minQty: this.minQty,
      minNotional: this.minNotional,
    };
  },

  get cyclePhase() {
    return resolveCyclePhase(this.state?.phase ?? 'IDLE', this.ladder);
  },

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch((e) => logger.error('Error in exclusive task', { error: e }));
    return run;
  },

  buildHost(): BuildPhaseHost & HarvestPhaseHost & ExitPhaseHost {
    const engine = this;
    return {
      get ladder() {
        return engine.ladder;
      },
      set ladder(v: LadderState | null) {
        engine.ladder = v;
      },
      precision: engine.precision,
      refreshingExits: engine._refreshingExits,
      setRefreshingExits(v: boolean) {
        engine._refreshingExits = v;
      },
      isPartialCloseInFlight: () => engine._partialCloseInFlight,
      setPartialCloseInFlight(v: boolean) {
        engine._partialCloseInFlight = v;
      },
      refreshWalls: () => refreshLadderWalls(engine.ladder),
      refreshExits: () => runRefreshExits(engine.buildHost()),
      startNextCycle: () => engine.startCycle(),
    };
  },

  async init() {
    if (this.initialized) {
      logger.info('Bot already initialized, skipping.');
      return;
    }

    this.state = await stateManager.getState();
    logger.info('Bot initializing', {
      state: this.state,
      symbol: SYMBOL,
      leverage: LEVERAGE,
      cyclePhase: this.cyclePhase,
      ladderLevels: LADDER_LEVELS,
      ladderSizeMult: LADDER_SIZE_MULT,
      accountRiskPercent: ACCOUNT_RISK_PERCENT,
      tpRewardRatio: TP_REWARD_RATIO,
      minLadderSpacingPct: MIN_LADDER_SPACING_PCT,
      maxLadderSpacingPct: MAX_LADDER_SPACING_PCT,
    });

    try {
      const exchangeInfo = await client.getExchangeInfo();
      const symbolInfo = exchangeInfo.symbols.find((s) => s.symbol === SYMBOL);
      if (symbolInfo) {
        const lotSizeFilter = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE') as {
          stepSize: string;
          minQty: string;
        } | undefined;
        if (lotSizeFilter) {
          this.stepSize = parseFloat(lotSizeFilter.stepSize);
          this.minQty = parseFloat(lotSizeFilter.minQty);
        }
        const priceFilter = symbolInfo.filters.find((f) => f.filterType === 'PRICE_FILTER') as {
          tickSize: string;
        } | undefined;
        if (priceFilter) this.tickSize = parseFloat(priceFilter.tickSize);
        const minNotionalFilter = symbolInfo.filters.find((f) => f.filterType === 'MIN_NOTIONAL') as {
          notional?: string;
          minNotional?: string;
        } | undefined;
        if (minNotionalFilter) {
          this.minNotional = parseFloat(minNotionalFilter.notional || minNotionalFilter.minNotional || '5');
        }
        logger.info('Symbol Info', this.precision);
      } else {
        logger.error(`Symbol ${SYMBOL} not found in exchange info!`);
      }
    } catch (e) {
      logger.error('Failed to fetch exchange info', { error: e });
    }

    try {
      await client.setMarginType({ symbol: SYMBOL, marginType: 'CROSSED' });
      logger.info(`Margin type set to CROSSED for ${SYMBOL}`);
    } catch (e: unknown) {
      const err = e as { code?: number; message?: string; body?: { msg?: string } };
      const msg = err?.message || err?.body?.msg || '';
      if (err?.code === -4046 || msg.includes('No need to change margin type')) {
        logger.info(`Margin type already CROSSED for ${SYMBOL}`);
      } else {
        logger.error('Error setting margin type', { error: e });
      }
    }

    try {
      await client.setLeverage({ symbol: SYMBOL, leverage: LEVERAGE });
      logger.info(`Leverage set to ${LEVERAGE}x for ${SYMBOL}`);
    } catch (e) {
      logger.error('Error setting leverage', { error: e });
    }

    await this.syncStateWithBinance();
    this.initialized = true;
    logger.info('Bot initialization complete.');
  },

  // ─── Phase: COLLECTING ─────────────────────────────────────────────────────
  async startCycle() {
    this.state = await stateManager.getState();
    this.ladder = null;

    await enterCollectPhase(
      {
        onPriceTick: (p) => this.onPriceTick(p),
        onCollectComplete: () =>
          this.runExclusive(async () => {
            const result = await placeStraddleOrders(this.precision);
            if (!result) {
              await stateManager.updatePhase('IDLE');
              setTimeout(
                () => this.startCycle().catch((e) => logger.error('Error restarting cycle', { error: e })),
                5_000
              );
              return;
            }
            this.ladder = result.ladder;
            await persistLadderState(this.ladder, 'WAITING_ENTRY');
          }),
      },
      this
    );
  },

  async persistLadder(phase?: BotPhase) {
    await persistLadderState(this.ladder, phase);
  },

  refreshWalls(): boolean {
    return refreshLadderWalls(this.ladder);
  },

  // ─── WS handlers ───────────────────────────────────────────────────────────
  async handleOrderUpdate(data: { order: Record<string, unknown> }) {
    const order = data.order;
    if (order.symbol !== SYMBOL) return;

    return this.runExclusive(async () => {
      this.state = await stateManager.getState();
      if (!this.state || this.state.status === 'STOPPED') return;

      const ladder = this.ladder;
      const clientOrderId = order.clientOrderId as string;

      const entry = ladder?.entryOrders.find((o) => o.clientOrderId === clientOrderId);
      if (entry && ladder) {
        if (order.orderStatus === 'FILLED') {
          entry.status = 'FILLED';
          ladder.fills++;

          const fillPrice = parseFloat((order.averagePrice || order.price || '0') as string);
          const fillQty = parseFloat(
            (order.orderFilledAccumulatedQuantity || order.originalQuantity || '0') as string
          );
          ladder.feesPaid += fillPrice * fillQty * MAKER_FEE;

          logger.info(`[WS] Entry #${ladder.fills} filled: ${entry.side} ${fillQty} @ ${fillPrice} (phase: ${this.cyclePhase})`);

          const host = this.buildHost();

          for (let attempt = 0; attempt < 5; attempt++) {
            const pos = await getPosition();
            if (pos.qty > 0) {
              ladder.posQty = pos.qty;
              ladder.entryPrice = pos.entry;
            }
            if (attempt === 4 || pos.qty > 0) break;
            await sleep(200);
          }

          const { exchangeEntryCount } = await syncLadderWithExchange(ladder);

          const tickPrice = orderBookCollector.currentPrice || fillPrice;
          const partialDone =
            ladder.fills >= 2 ? await executePartialClose(host, tickPrice) : false;
          const isFirstFill = !ladder.side;

          if (!isHarvestMode(ladder, undefined, ladder.posQty, exchangeEntryCount, this.stepSize) && !partialDone) {
            const placeLadder = () => runPlaceLadderOrders(host);
            if (isFirstFill) {
              await handleFirstFill(ladder, entry, fillPrice, placeLadder);
            } else {
              await handleSubsequentFill(ladder, entry, placeLadder);
            }
            await runRefreshExits(host);
          } else if (!partialDone) {
            await runRefreshExits(host);
          }

          const posFinal = await getPosition();
          if (posFinal.qty > 0 && posFinal.side) {
            syncLadderSideFromPosition(ladder, posFinal, 'WS fill');
          }

          await persistLadderState(ladder, botPhaseForLadder(ladder));
        } else if (order.orderStatus === 'CANCELED' || order.orderStatus === 'EXPIRED') {
          entry.status = 'CANCELED';
          await persistLadderState(ladder);
        }
        return;
      }

      const rp = parseFloat((order.realisedProfit || order.rp || '0') as string);
      if (rp !== 0 && order.orderStatus === 'FILLED') {
        logger.info(`[WS] Realized PnL: ${rp}`);
        await stateManager.updatePhase(this.state.phase, undefined, undefined, rp);
      }

      if (isInTradePhase(this.state.phase) && order.orderStatus === 'FILLED') {
        const isExitOrder =
          order.reduceOnly === true ||
          order.reduceOnly === 'true' ||
          order.orderType === 'MARKET' ||
          order.type === 'MARKET';
        if (!isExitOrder && rp === 0) return;

        await sleep(300);
        const pos = await getPosition();

        if (pos.qty === 0) {
          await runFinalizeCycle(this.buildHost(), parseFloat((order.averagePrice || order.price || '0') as string));
        } else if (ladder) {
          ladder.posQty = pos.qty;
          ladder.entryPrice = pos.entry;
          await persistLadderState(ladder);
        }
      }
    });
  },

  async handleAlgoUpdate(data: { algoOrder: Record<string, unknown> }) {
    const algo = data.algoOrder;
    if (algo.symbol !== SYMBOL) return;

    logger.info('[WS] Algo Update', {
      type: algo.orderType,
      status: algo.algoStatus,
      algoId: algo.algoId,
    });

    if (
      (algo.algoStatus === 'CANCELED' ||
        algo.algoStatus === 'REJECTED' ||
        algo.algoStatus === 'EXPIRED') &&
      !this._refreshingExits &&
      this.ladder?.slAlgoId === Number(algo.algoId)
    ) {
      logger.warn(`[WS] Active SL algo ${algo.algoId} was ${algo.algoStatus}! Re-placing exits...`);
      this.runExclusive(async () => {
        const pos = await getPosition();
        if (pos.qty > 0) await runRefreshExits(this.buildHost());
        else logger.info('[WS] Position already flat — skip SL re-place after algo cancel');
      }).catch((e) => logger.error('[WS] Error re-placing exits', { error: e }));
    }

    if (algo.algoStatus === 'TRIGGERED' || algo.algoStatus === 'FINISHED') {
      logger.info(`[WS] SL algo ${algo.algoStatus}, waiting for MARKET fill...`);
    }
  },

  // ─── Phase: BUILDING trail + HARVESTING (partial close + trailing SL on ticks) ─
  onPriceTick(price: number) {
    const now = Date.now();
    if (now - this._lastTickEval < 5_000) return;
    this._lastTickEval = now;

    if (canEvaluatePartialClose(this.ladder)) {
      this.runExclusive(async () => {
        const changed = await executePartialClose(this.buildHost(), price);
        if (changed) await persistLadderState(this.ladder);
      }).catch((e) => logger.error('Error in price tick evaluation', { error: e }));
      return;
    }

    if (
      this.ladder &&
      !this._refreshingExits &&
      this.ladder.buildingTrailActive &&
      buildingTrailFloorBreached(this.ladder, price, this.tickSize)
    ) {
      this.runExclusive(async () => {
        await executeBuildingTrailFloorClose(this.ladder!, price, this.tickSize);
      }).catch((e) => logger.error('Error on building trail floor close', { error: e }));
      return;
    }

    if (
      this.ladder &&
      !this._refreshingExits &&
      canEvaluateBuildingTrail(this.ladder) &&
      shouldActivateBuildingTrail(this.ladder, price)
    ) {
      this.runExclusive(async () => {
        await activateBuildingTrail(this.ladder!, price);
        await runRefreshExits(this.buildHost());
        await persistLadderState(this.ladder);
      }).catch((e) => logger.error('Error activating building trail', { error: e }));
      return;
    }

    if (
      this.ladder &&
      !this._refreshingExits &&
      this.ladder.buildingTrailActive &&
      evaluateBuildingTrail(this.ladder, price, this.tickSize)
    ) {
      logger.info(
        `[Build] Trailing SL update: peak ${this.ladder.buildingPeakPrice}, current SL ${this.ladder.slPrice ?? 'none'}`
      );
      this.runExclusive(async () => {
        await runRefreshExits(this.buildHost());
        await persistLadderState(this.ladder);
      }).catch((e) => logger.error('Error updating building trailing SL', { error: e }));
      return;
    }

    if (
      this.ladder &&
      !this._refreshingExits &&
      evaluateHarvestTrail(this.ladder, price, this.tickSize)
    ) {
      logger.info(
        `[Harvest] Trailing SL update: peak ${this.ladder.harvestPeakPrice}, current SL ${this.ladder.slPrice ?? 'none'}`
      );
      this.runExclusive(async () => {
        await runRefreshExits(this.buildHost());
        await persistLadderState(this.ladder);
      }).catch((e) => logger.error('Error updating trailing SL', { error: e }));
    }
  },

  // ─── Phase: BUILDING ───────────────────────────────────────────────────────
  async placeLadderOrders() {
    await runPlaceLadderOrders(this.buildHost());
  },

  async refreshExits() {
    await runRefreshExits(this.buildHost());
  },

  async maybePartialClose(price: number): Promise<boolean> {
    return executePartialClose(this.buildHost(), price);
  },

  async finalizeCycle(exitPrice: number) {
    await runFinalizeCycle(this.buildHost(), exitPrice);
  },

  // ─── Sync ──────────────────────────────────────────────────────────────────
  async syncStateWithBinance() {
    logger.info('Syncing state with Binance...');
    try {
      this.state = await stateManager.getState();

      if (!this.ladder && this.state.orders?.ladder?.baseQty) {
        this.ladder = this.state.orders.ladder as LadderState;
        logger.info('Restored ladder state from DB', {
          fills: this.ladder.fills,
          side: this.ladder.side,
          phase: resolveCyclePhase(this.state.phase, this.ladder),
        });
      }

      let openOrders: { clientOrderId?: string; reduceOnly?: boolean; type?: string }[] = [];
      try {
        openOrders = await client.getAllOpenOrders({ symbol: SYMBOL });
      } catch { /* none is fine */ }

      const pos = await getPosition();

      if (pos.qty > 0) {
        logger.info(`[Sync] In position: ${pos.side} ${pos.qty} @ ${pos.entry}`);
        orderBookCollector.onPrice = (p) => this.onPriceTick(p);
        await orderBookCollector.ensureDepthCollection(SYMBOL);

        const openEntryCount = countExchangeEntryOrders(openOrders);
        const { exchangeEntryCount } = this.ladder
          ? await syncLadderWithExchange(this.ladder)
          : { exchangeEntryCount: openEntryCount };

        let repairedHarvest = false;
        if (!this.ladder) {
          const balance = await getAccountBalance();
          this.ladder = {
            baseQty: pos.qty,
            riskAmount: balance * ACCOUNT_RISK_PERCENT,
            buyWalls: [],
            sellWalls: [],
            usedWalls: [],
            side: pos.side,
            entryOrders: [],
            fills: 1,
            partialCloses: 0,
            feesPaid: pos.qty * pos.entry * MAKER_FEE,
            entryPrice: pos.entry,
            posQty: pos.qty,
            slAlgoId: null,
            tpClientOrderId: null,
            windingDown: true,
            ladderStep: 1,
          };
          logger.warn('[Sync] Position without ladder state — minimal HARVESTING ladder reconstructed.');
        } else {
          this.ladder.posQty = pos.qty;
          this.ladder.entryPrice = pos.entry;
          this.ladder.side = pos.side;
          repairedHarvest = repairHarvestState(this.ladder, pos.qty, exchangeEntryCount, this.stepSize);
          if (repairedHarvest) {
            logger.warn(
              `[Sync] Repaired harvest state (pos ${pos.qty}, open entries ${openEntryCount}, was ${this.state.phase})`
            );
          }
        }

        const syncPhase: BotPhase = isHarvestMode(
          this.ladder,
          this.state.phase,
          pos.qty,
          exchangeEntryCount,
          this.stepSize
        )
          ? 'HARVESTING'
          : 'BUILDING';
        if (this.state.phase !== syncPhase) {
          await stateManager.updatePhase(
            syncPhase,
            this.state.cycle_id || randomUUID(),
            undefined,
            undefined,
            pos.entry,
            pos.side
          );
        }

        let hasSL = false;
        try {
          const algoOrders = await client.getOpenAlgoOrders({ symbol: SYMBOL });
          hasSL = algoOrders.some(
            (o: { orderType: string; algoStatus: string }) =>
              o.orderType === 'STOP_MARKET' &&
              (o.algoStatus === 'NEW' || o.algoStatus === 'PENDING' || o.algoStatus === 'TRIGGERING')
          );
        } catch { /* none is fine */ }

        const hasTP = openOrders.some((o) => o.reduceOnly && o.type === 'LIMIT');

        // Stale TP id in memory if user canceled manually on exchange
        if (this.ladder.tpClientOrderId && !hasTP) {
          this.ladder.tpClientOrderId = null;
        }

        if (
          syncPhase === 'BUILDING' &&
          needsLadderPlacement(this.ladder, exchangeEntryCount)
        ) {
          if (this.ladder.ladderSizingBlocked) {
            logger.warn('[Sync] Clearing ladderSizingBlocked — retrying with geometric sizing');
            this.ladder.ladderSizingBlocked = false;
          }
          for (let i = 0; i < 30 && !orderBookCollector.isSynced; i++) {
            await sleep(200);
          }
          logger.warn('[Sync] No ladder entry orders on exchange — attempting placement');
          await this.runExclusive(() => runPlaceLadderOrders(this.buildHost()));
        }

        if (!hasSL || !hasTP || repairedHarvest || this.state.phase !== syncPhase) {
          if (repairedHarvest && hasSL && hasTP) {
            logger.warn('[Sync] Harvest state repaired — re-placing exits at harvest % (was building SL)');
          } else if (this.state.phase !== syncPhase) {
            logger.warn(`[Sync] Phase mismatch (${this.state.phase} → ${syncPhase}). Re-placing exits...`);
          } else {
            logger.warn(`[Sync] Missing exits (SL: ${hasSL}, TP: ${hasTP}). Re-placing...`);
          }
          await this.runExclusive(() => runRefreshExits(this.buildHost()));
        }
        await persistLadderState(this.ladder, botPhaseForLadder(this.ladder));
      } else {
        const entryOrdersOpen = this.ladder?.entryOrders.some(
          (o) => o.status === 'OPEN' && o.clientOrderId && isOpenOnExchange(o, openOrders)
        );

        if (this.state.phase === 'WAITING_ENTRY' && entryOrdersOpen) {
          logger.info('[Sync] STRADDLE phase — waiting for first entry fill.');
          orderBookCollector.onPrice = (p) => this.onPriceTick(p);
          await orderBookCollector.ensureDepthCollection(SYMBOL);
        } else if (this.state.status === 'RUNNING') {
          logger.info('[Sync] No position. Starting fresh COLLECTING phase.');
          await this.startCycle();
        } else {
          if (this.state.phase !== 'IDLE') await stateManager.updatePhase('IDLE');
          logger.info('[Sync] IDLE (stopped).');
        }
      }

      this.state = await stateManager.getState();
    } catch (e) {
      logger.error('Failed to sync state', { error: e });
    }
  },

  async stop() {
    stopCollectTimer(this);
    orderBookCollector.stopAll();
    const pos = await getPosition().catch(() => ({ qty: 0, entry: 0, side: null }));
    if (pos.qty > 0) {
      logger.warn(
        `Bot stopped with OPEN POSITION (${pos.side} ${pos.qty}). Orders canceled — manage manually!`
      );
    }
  },
};
