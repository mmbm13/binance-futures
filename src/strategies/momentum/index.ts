import { randomUUID } from 'crypto';
import { WebsocketClient } from 'binance';
import { client } from '../../bot/client';
import { SYMBOL, LEVERAGE, TAKER_FEE } from '../../bot/config';
import { fetchSymbolPrecision } from '../../bot/exchange';
import { roundStep, sleep } from '../../bot/math';
import { orderBookCollector } from '../../bot/orderbook';
import { stateManager } from '../../bot/state';
import { SymbolPrecision } from '../../bot/types';
import { LiveExecutor } from '../../execution/live';
import { PaperExecutor, PaperState } from '../../execution/paper';
import { Executor, FillEvent } from '../../execution/types';
import { logger } from '../../utils/logger';
import { recordSignal } from '../shared/signals';
import { ExecutionMode, Strategy } from '../types';
import {
  MOM_ATR_PERIOD,
  MOM_ATR_TRAIL_MULT,
  MOM_BUFFER_SIZE,
  MOM_INTERVAL,
  MOM_MAX_CONSECUTIVE_LOSSES,
  MOM_PAUSE_HOURS,
  MOM_RISK_PCT,
} from './config';
import { atr, Candle } from './indicators';
import {
  computeFundingApr,
  computeQty,
  computeTrailStop,
  evaluateEntryFromCandles,
  shouldPause,
  updateExtreme,
} from './rules';

const USE_TESTNET = process.env.USE_TESTNET === 'true';

interface MomentumState {
  side: 'LONG' | 'SHORT' | null;
  qty: number;
  entry: number;
  openedAt: number | null;
  stopPrice: number | null;
  slAlgoId: number | null;
  extremeFavorable: number;
  consecutiveLosses: number;
  pausedUntil: number | null;
  cycleId: string | null;
  feesPaid: number;
  paper?: PaperState;
}

const emptyState = (): MomentumState => ({
  side: null,
  qty: 0,
  entry: 0,
  openedAt: null,
  stopPrice: null,
  slAlgoId: null,
  extremeFavorable: 0,
  consecutiveLosses: 0,
  pausedUntil: null,
  cycleId: null,
  feesPaid: 0,
});

export class MomentumStrategy implements Strategy {
  readonly id = 'momentum' as const;

  private executor!: Executor;
  private precision: SymbolPrecision = { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 };
  private candles: Candle[] = [];
  private state: MomentumState = emptyState();
  private klineWs: WebsocketClient | null = null;
  private initialized = false;
  private lastAtr: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly mode: ExecutionMode) {}

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch((e) => logger.error('[Momentum] Error in exclusive task', { error: e }));
    return run;
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;

    this.precision = await fetchSymbolPrecision(SYMBOL);
    logger.info('[Momentum] Symbol precision', this.precision);

    const persisted = (await stateManager.getState()).orders?.momentum as
      | MomentumState
      | undefined;
    if (persisted?.side !== undefined) {
      this.state = { ...emptyState(), ...persisted };
      logger.info('[Momentum] Restored state from DB', {
        side: this.state.side,
        qty: this.state.qty,
        consecutiveLosses: this.state.consecutiveLosses,
      });
    }

    if (this.mode === 'paper') {
      const paper = new PaperExecutor({ symbol: SYMBOL });
      if (this.state.paper) paper.restore(this.state.paper);
      paper.setEventHandler((evt: FillEvent) => {
        void this.onOrderUpdate({ order: evt.order as unknown as Record<string, unknown> });
      });
      this.executor = paper;
      // Feed simulated fills from the live bookTicker
      orderBookCollector.onPrice = () => {
        const bid = orderBookCollector.currentBid;
        const ask = orderBookCollector.currentAsk;
        if (bid > 0 && ask > bid) paper.tick({ bid, ask });
      };
      orderBookCollector.startPriceStream(SYMBOL);
    } else {
      this.executor = new LiveExecutor(SYMBOL);
      try {
        await client.setMarginType({ symbol: SYMBOL, marginType: 'CROSSED' });
      } catch { /* already set is fine */ }
      try {
        await client.setLeverage({ symbol: SYMBOL, leverage: LEVERAGE });
      } catch (e) {
        logger.error('[Momentum] Error setting leverage', { error: e });
      }
    }

    await this.warmupCandles();
    this.subscribeKlines();
    await this.sync();
    this.initialized = true;
    logger.info(`[Momentum] Initialized (${this.mode}, interval ${MOM_INTERVAL})`);
  }

  async start(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    } else {
      await this.sync();
    }
    logger.info('[Momentum] Started — waiting for closed candles.');
  }

  async stop(): Promise<void> {
    if (this.klineWs) {
      try {
        this.klineWs.closeAll();
      } catch { /* ignore */ }
      this.klineWs = null;
    }
    await this.executor.cancelAllStops();
    const pos = await this.executor.getPosition().catch(() => ({ qty: 0, entry: 0, side: null }));
    if (pos.qty > 0) {
      logger.warn(`[Momentum] Stopped with OPEN POSITION (${pos.side} ${pos.qty}) — stops canceled, manage manually!`);
    }
    await this.persist();
  }

  async sync(): Promise<void> {
    return this.runExclusive(async () => {
      const pos = await this.executor.getPosition();

      if (pos.qty > 0 && pos.side && !this.state.side) {
        logger.warn(`[Momentum] Adopting untracked position: ${pos.side} ${pos.qty} @ ${pos.entry}`);
        this.state.side = pos.side;
        this.state.qty = pos.qty;
        this.state.entry = pos.entry;
        this.state.extremeFavorable = pos.entry;
        this.state.openedAt = Date.now();
        this.state.cycleId = this.state.cycleId ?? randomUUID();
        await this.ensureStop();
        await this.persist();
        return;
      }

      if (pos.qty === 0 && this.state.side) {
        logger.warn('[Momentum] Position gone from exchange — finalizing with last known data');
        const exitPrice = orderBookCollector.currentPrice || this.state.entry;
        await this.finalizeTrade(exitPrice, null, { orphaned: true });
        return;
      }

      if (pos.qty > 0 && this.state.side) {
        this.state.qty = pos.qty;
        this.state.entry = pos.entry;
        await this.ensureStop();
        await this.persist();
      }
    });
  }

  // ─── candles ──────────────────────────────────────────────────────────────

  private async warmupCandles(): Promise<void> {
    const raw = await client.getKlines({
      symbol: SYMBOL,
      interval: MOM_INTERVAL as Parameters<typeof client.getKlines>[0]['interval'],
      limit: MOM_BUFFER_SIZE,
    });
    const now = Date.now();
    this.candles = raw
      .map((k) => ({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: Number(k[6]),
      }))
      .filter((c) => c.closeTime <= now) // drop the still-open candle
      .map(({ closeTime: _closeTime, ...candle }) => candle);
    this.lastAtr = atr(this.candles, MOM_ATR_PERIOD);
    logger.info(`[Momentum] Warm-up loaded ${this.candles.length} closed candles (${MOM_INTERVAL})`);
  }

  private subscribeKlines(): void {
    if (this.klineWs) return;
    this.klineWs = new WebsocketClient({ beautify: false, demoTrading: USE_TESTNET });
    this.klineWs.on('message', (msg: unknown) => {
      const ev = ((msg as { data?: Record<string, unknown> })?.data ?? msg) as {
        e?: string;
        s?: string;
        k?: Record<string, unknown>;
      };
      if (ev?.e !== 'kline' || ev.s !== SYMBOL || !ev.k) return;
      if (ev.k.x !== true) return; // only closed candles

      const candle: Candle = {
        openTime: Number(ev.k.t),
        open: Number(ev.k.o),
        high: Number(ev.k.h),
        low: Number(ev.k.l),
        close: Number(ev.k.c),
        volume: Number(ev.k.v),
      };
      void this.runExclusive(() => this.onClosedCandle(candle)).catch((e) =>
        logger.error('[Momentum] Error handling closed candle', { error: e })
      );
    });
    this.klineWs.on('exception', (d: unknown) => logger.error('[Momentum] Kline WS exception', { data: d }));
    void this.klineWs.subscribeKlines(
      SYMBOL,
      MOM_INTERVAL as Parameters<WebsocketClient['subscribeKlines']>[1],
      'usdm'
    );
    logger.info(`[Momentum] Subscribed to ${SYMBOL}@kline_${MOM_INTERVAL}`);
  }

  private async onClosedCandle(candle: Candle): Promise<void> {
    // Ignore duplicates (WS reconnect can replay the last candle)
    const last = this.candles[this.candles.length - 1];
    if (last && candle.openTime <= last.openTime) return;

    this.candles.push(candle);
    if (this.candles.length > MOM_BUFFER_SIZE) this.candles.shift();
    this.lastAtr = atr(this.candles, MOM_ATR_PERIOD);

    if (this.state.side) {
      await this.updateTrailing(candle);
      return;
    }

    const botState = await stateManager.getState();
    if (botState.status !== 'RUNNING') return;

    if (this.state.pausedUntil && Date.now() < this.state.pausedUntil) return;

    await this.evaluateEntry();
  }

  // ─── entries ──────────────────────────────────────────────────────────────

  private async fetchFundingApr(): Promise<number> {
    try {
      const res = await client.getMarkPrice({ symbol: SYMBOL });
      const rate = parseFloat((res as { lastFundingRate?: string }).lastFundingRate || '0');
      return computeFundingApr(rate);
    } catch {
      return 0;
    }
  }

  private async evaluateEntry(): Promise<void> {
    const fundingApr = await this.fetchFundingApr();
    const evaluation = evaluateEntryFromCandles(this.candles, fundingApr);

    if (evaluation.reason === 'no_breakout' || evaluation.reason === 'insufficient_data') return;

    const ind = evaluation.indicators!;
    const payload = {
      close: ind.close,
      channelHigh: ind.channelHigh,
      channelLow: ind.channelLow,
      atr: ind.atrValue,
      adx: ind.adxValue,
      fundingApr,
      reason: evaluation.reason,
    };

    if (!evaluation.signal) {
      logger.info(`[Momentum] Breakout vetoed: ${evaluation.reason}`, payload);
      await recordSignal('momentum', SYMBOL, 'breakout_vetoed', payload, false);
      return;
    }

    const { side, stopDistance, close } = evaluation.signal;
    const balance = await this.executor.getBalance();
    const sizing = computeQty(
      balance,
      MOM_RISK_PCT,
      stopDistance,
      close,
      this.precision.stepSize,
      this.precision.minQty,
      this.precision.minNotional
    );

    const kind = side === 'LONG' ? 'breakout_long' : 'breakout_short';
    if (!sizing.valid) {
      logger.warn(`[Momentum] Signal ${kind} skipped — sizing ${sizing.reason}`, { balance, stopDistance });
      await recordSignal('momentum', SYMBOL, kind, { ...payload, sizing: sizing.reason }, false);
      return;
    }

    logger.info(`[Momentum] ${kind}: ${side} ${sizing.qty} @ ~${close} (stop dist ${stopDistance.toFixed(2)})`);
    await recordSignal('momentum', SYMBOL, kind, { ...payload, qty: sizing.qty }, true);

    try {
      await this.executor.submitOrder({
        side: side === 'LONG' ? 'BUY' : 'SELL',
        type: 'MARKET',
        quantity: sizing.qty,
      });
    } catch (e) {
      logger.error('[Momentum] Entry order failed', { error: e });
      return;
    }

    // Wait for the position to reflect the fill (paper is immediate)
    let pos = await this.executor.getPosition();
    for (let i = 0; i < 5 && pos.qty === 0; i++) {
      await sleep(200);
      pos = await this.executor.getPosition();
    }
    if (pos.qty === 0 || !pos.side) {
      logger.error('[Momentum] Entry submitted but no position found — aborting cycle');
      return;
    }

    this.state.side = pos.side;
    this.state.qty = pos.qty;
    this.state.entry = pos.entry;
    this.state.extremeFavorable = pos.entry;
    this.state.openedAt = Date.now();
    this.state.cycleId = randomUUID();
    this.state.feesPaid = pos.qty * pos.entry * TAKER_FEE;

    const dir = pos.side === 'LONG' ? 1 : -1;
    this.state.stopPrice = roundStep(pos.entry - dir * stopDistance, this.precision.tickSize);
    await this.placeStop();
    await this.persist();
  }

  // ─── stops / trailing ─────────────────────────────────────────────────────

  private async placeStop(): Promise<void> {
    if (!this.state.side || !this.state.stopPrice) return;
    const closeSide = this.state.side === 'LONG' ? 'SELL' : 'BUY';
    try {
      await this.executor.cancelAllStops();
      const ack = await this.executor.submitStopMarket({
        side: closeSide,
        triggerPrice: this.state.stopPrice,
        closePosition: true,
      });
      this.state.slAlgoId = ack.algoId;
      logger.info(`[Momentum] Stop placed: ${closeSide} STOP_MARKET @ ${this.state.stopPrice}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('immediately trigger') || msg.toLowerCase().includes('immediately')) {
        logger.warn('[Momentum] Stop would trigger now — closing at market');
        await this.closeAtMarket();
      } else {
        logger.error('[Momentum] FAILED to place stop — position unprotected', { error: msg });
        this.state.slAlgoId = null;
      }
    }
  }

  private async ensureStop(): Promise<void> {
    if (!this.state.side) return;
    if (this.state.slAlgoId) return;
    if (!this.state.stopPrice) {
      const dir = this.state.side === 'LONG' ? 1 : -1;
      const atrValue = this.lastAtr ?? this.state.entry * 0.01;
      this.state.stopPrice = roundStep(
        this.state.entry - dir * 2 * atrValue,
        this.precision.tickSize
      );
    }
    await this.placeStop();
  }

  private async updateTrailing(candle: Candle): Promise<void> {
    if (!this.state.side || this.lastAtr === null) return;

    this.state.extremeFavorable = updateExtreme(this.state.side, this.state.extremeFavorable, candle);
    const newStop = computeTrailStop(
      this.state.side,
      this.state.extremeFavorable,
      this.lastAtr,
      MOM_ATR_TRAIL_MULT,
      this.state.stopPrice,
      this.precision.tickSize
    );

    const dir = this.state.side === 'LONG' ? 1 : -1;
    const improved =
      this.state.stopPrice === null ||
      (newStop - this.state.stopPrice) * dir >= this.precision.tickSize;

    if (improved) {
      logger.info(
        `[Momentum] Trailing stop ${this.state.stopPrice ?? 'none'} → ${newStop} (extreme ${this.state.extremeFavorable})`
      );
      this.state.stopPrice = newStop;
      await this.placeStop();
    }
    await this.persist();
  }

  private async closeAtMarket(): Promise<void> {
    if (!this.state.side) return;
    try {
      await this.executor.submitOrder({
        side: this.state.side === 'LONG' ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity: this.state.qty,
        reduceOnly: true,
      });
    } catch (e) {
      logger.error('[Momentum] Market close failed', { error: e });
    }
  }

  // ─── fills / finalization ─────────────────────────────────────────────────

  async onOrderUpdate(data: { order: Record<string, unknown> }): Promise<unknown> {
    const order = data.order;
    if (order.symbol !== SYMBOL) return;
    if (order.orderStatus !== 'FILLED') return;

    return this.runExclusive(async () => {
      if (!this.state.side) return;

      const pos = await this.executor.getPosition();
      if (pos.qty > 0) {
        this.state.qty = pos.qty;
        await this.persist();
        return;
      }

      const exitPrice = parseFloat((order.averagePrice || order.price || '0') as string);
      const rp = parseFloat((order.realisedProfit || order.rp || '0') as string);
      await this.finalizeTrade(exitPrice || this.state.entry, rp !== 0 ? rp : null, {});
    });
  }

  async onAlgoUpdate(data: { algoOrder: Record<string, unknown> }): Promise<unknown> {
    const algo = data.algoOrder;
    if (algo.symbol !== SYMBOL) return;

    if (
      (algo.algoStatus === 'CANCELED' || algo.algoStatus === 'EXPIRED' || algo.algoStatus === 'REJECTED') &&
      this.state.slAlgoId === Number(algo.algoId)
    ) {
      return this.runExclusive(async () => {
        const pos = await this.executor.getPosition();
        if (pos.qty > 0) {
          logger.warn(`[Momentum] Active stop ${algo.algoId} was ${algo.algoStatus} — re-placing`);
          this.state.slAlgoId = null;
          await this.placeStop();
          await this.persist();
        }
      });
    }
  }

  private async finalizeTrade(
    exitPrice: number,
    realizedFromExchange: number | null,
    meta: Record<string, unknown>
  ): Promise<void> {
    const { side, qty, entry, openedAt, cycleId } = this.state;
    if (!side) return;

    const dir = side === 'LONG' ? 1 : -1;
    const exitFees = qty * exitPrice * TAKER_FEE;
    const fees = this.state.feesPaid + exitFees;
    const gross = (exitPrice - entry) * qty * dir;
    const realized = realizedFromExchange ?? gross - exitFees;

    this.state.consecutiveLosses = realized <= 0 ? this.state.consecutiveLosses + 1 : 0;
    if (shouldPause(this.state.consecutiveLosses, MOM_MAX_CONSECUTIVE_LOSSES)) {
      this.state.pausedUntil = Date.now() + MOM_PAUSE_HOURS * 3_600_000;
      logger.warn(
        `[Momentum] Circuit breaker: ${this.state.consecutiveLosses} consecutive losses — paused until ${new Date(this.state.pausedUntil).toISOString()}`
      );
    }

    await stateManager.saveTrade({
      cycle_id: cycleId ?? randomUUID(),
      symbol: SYMBOL,
      side,
      entry_price: entry,
      exit_price: exitPrice,
      pnl: realized,
      realized_pnl: realized,
      strategy: 'momentum',
      qty,
      fees,
      opened_at: openedAt ? new Date(openedAt) : null,
      meta: { ...meta, extremeFavorable: this.state.extremeFavorable, mode: this.mode },
    });
    logger.info(
      `[Momentum] Trade closed: ${side} ${qty} ${entry} → ${exitPrice} | PnL $${realized.toFixed(2)} (fees $${fees.toFixed(2)})`
    );

    await this.executor.cancelAllStops();
    const { consecutiveLosses, pausedUntil } = this.state;
    this.state = { ...emptyState(), consecutiveLosses, pausedUntil };
    await this.persist();
  }

  // ─── persistence / metrics ────────────────────────────────────────────────

  private async persist(): Promise<void> {
    if (this.mode === 'paper' && this.executor instanceof PaperExecutor) {
      this.state.paper = this.executor.toJSON();
    }
    await stateManager.saveStrategyState('momentum', this.state);
  }

  async getMetrics(): Promise<Record<string, unknown>> {
    const balance = await this.executor.getBalance().catch(() => null);
    return {
      strategy: this.id,
      mode: this.mode,
      candles: this.candles.length,
      atr: this.lastAtr,
      position: this.state.side
        ? {
            side: this.state.side,
            qty: this.state.qty,
            entry: this.state.entry,
            stopPrice: this.state.stopPrice,
            extremeFavorable: this.state.extremeFavorable,
            openedAt: this.state.openedAt,
          }
        : null,
      consecutiveLosses: this.state.consecutiveLosses,
      pausedUntil: this.state.pausedUntil,
      balance,
    };
  }
}
