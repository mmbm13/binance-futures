import { randomUUID } from 'crypto';
import { WebsocketClient } from 'binance';
import { client } from '../../bot/client';
import { SYMBOL, LEVERAGE, TAKER_FEE } from '../../bot/config';
import { fetchSymbolPrecision } from '../../bot/exchange';
import { sleep } from '../../bot/math';
import { orderBookCollector } from '../../bot/orderbook';
import { stateManager } from '../../bot/state';
import { SymbolPrecision } from '../../bot/types';
import { LiveExecutor } from '../../execution/live';
import { PaperExecutor, PaperState } from '../../execution/paper';
import { Executor, FillEvent } from '../../execution/types';
import { logger } from '../../utils/logger';
import { recordSignal } from '../shared/signals';
import { CvdAccumulator } from '../shared/cvd';
import { atr, Candle } from '../momentum/indicators';
import { ExecutionMode, Strategy } from '../types';
import {
  ArmedCascade,
  createArmedCascade,
  detectCascade,
  isCascadeExhausted,
  LiqEvent,
  LiqWindowHistory,
  PricePoint,
  priceChangeOverWindow,
  pruneEvents,
  refreshArmedOnLiq,
  TradeSide,
} from './cascadeDetector';
import {
  LIQREV_ARMED_TTL_MIN,
  LIQREV_ATR_PERIOD,
  LIQREV_COOLDOWN_MIN,
  LIQREV_EXHAUST_SEC,
  LIQREV_HISTORY_WINDOWS,
  LIQREV_MIN_NOTIONAL,
  LIQREV_PERCENTILE,
  LIQREV_PRICE_MOVE_ATR,
  LIQREV_RISK_PCT,
  LIQREV_SL_BUFFER_ATR,
  LIQREV_TICK_THROTTLE_MS,
  LIQREV_TIME_STOP_MIN,
  LIQREV_TP_RETRACE,
  LIQREV_WINDOW_SEC,
} from './config';
import {
  computeEntryQty,
  computeLiqRevStops,
  isArmedExpired,
  isCooldownActive,
  isTimeStopDue,
} from './rules';

const USE_TESTNET = process.env.USE_TESTNET === 'true';

export type LiqRevPhase = 'WATCHING' | 'IN_POSITION';

export interface LiqRevPersisted {
  phase: LiqRevPhase;
  side: TradeSide | null;
  qty: number;
  entry: number;
  slPrice: number | null;
  tpPrice: number | null;
  slAlgoId: number | null;
  tpClientOrderId: string | null;
  cascadeStart: number | null;
  cascadeExtreme: number | null;
  openedAt: number | null;
  timeStopAt: number | null;
  cooldownUntil: number | null;
  cycleId: string | null;
  feesPaid: number;
  paper?: PaperState;
  cvd?: ReturnType<CvdAccumulator['toJSON']>;
  liqHistory?: ReturnType<LiqWindowHistory['toJSON']>;
}

const emptyState = (): LiqRevPersisted => ({
  phase: 'WATCHING',
  side: null,
  qty: 0,
  entry: 0,
  slPrice: null,
  tpPrice: null,
  slAlgoId: null,
  tpClientOrderId: null,
  cascadeStart: null,
  cascadeExtreme: null,
  openedAt: null,
  timeStopAt: null,
  cooldownUntil: null,
  cycleId: null,
  feesPaid: 0,
});

export class LiqRevStrategy implements Strategy {
  readonly id = 'liqrev' as const;

  private executor!: Executor;
  private precision: SymbolPrecision = { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 };
  private state: LiqRevPersisted = emptyState();
  private armed: ArmedCascade | null = null;
  private liqEvents: LiqEvent[] = [];
  private priceHistory: PricePoint[] = [];
  private liqHistory = new LiqWindowHistory(LIQREV_HISTORY_WINDOWS);
  private cvd = new CvdAccumulator();
  private candles1m: Candle[] = [];
  private atr1m: number | null = null;
  private klineWs: WebsocketClient | null = null;
  private aggWs: WebsocketClient | null = null;
  private liqWs: WebsocketClient | null = null;
  private windowTimer: NodeJS.Timeout | null = null;
  private lastTickEval = 0;
  private initialized = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly mode: ExecutionMode) {}

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch((e) => logger.error('[LiqRev] Error in exclusive task', { error: e }));
    return run;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    this.precision = await fetchSymbolPrecision(SYMBOL);

    const persisted = (await stateManager.getState()).orders?.liqrev as LiqRevPersisted | undefined;
    if (persisted?.phase) {
      this.state = { ...emptyState(), ...persisted };
      if (persisted.cvd) this.cvd.restore(persisted.cvd);
      if (persisted.liqHistory) this.liqHistory.restore(persisted.liqHistory);
      // ARMED is never persisted — always resume WATCHING unless in position.
      if (this.state.phase !== 'IN_POSITION') this.state.phase = 'WATCHING';
      logger.info('[LiqRev] Restored state', { phase: this.state.phase, side: this.state.side });
    }

    if (this.mode === 'paper') {
      const paper = new PaperExecutor({ symbol: SYMBOL });
      if (this.state.paper) paper.restore(this.state.paper);
      paper.setEventHandler((evt: FillEvent) => {
        void this.onOrderUpdate({ order: evt.order as unknown as Record<string, unknown> });
      });
      this.executor = paper;
      orderBookCollector.onPrice = () => this.onPriceTick(orderBookCollector.currentPrice);
      orderBookCollector.startPriceStream(SYMBOL);
    } else {
      this.executor = new LiveExecutor(SYMBOL);
      try {
        await client.setMarginType({ symbol: SYMBOL, marginType: 'CROSSED' });
      } catch { /* ok */ }
      try {
        await client.setLeverage({ symbol: SYMBOL, leverage: LEVERAGE });
      } catch (e) {
        logger.error('[LiqRev] Error setting leverage', { error: e });
      }
    }

    await this.warmup1mCandles();
    this.subscribe1mKlines();
    this.subscribeAggTrades();
    this.subscribeLiquidations();
    this.startWindowSampler();
    orderBookCollector.onPrice = (p) => this.onPriceTick(p);
    if (this.mode === 'live') orderBookCollector.startPriceStream(SYMBOL);
    await this.sync();
    this.initialized = true;
    logger.info(`[LiqRev] Initialized (${this.mode})`);
  }

  async start(): Promise<void> {
    if (!this.initialized) await this.init();
    return this.runExclusive(async () => {
      if (this.state.phase === 'IN_POSITION') {
        await this.ensureExitOrders();
      }
    });
  }

  async stop(): Promise<void> {
    if (this.windowTimer) clearInterval(this.windowTimer);
    this.windowTimer = null;
    for (const ws of [this.klineWs, this.aggWs, this.liqWs]) {
      try {
        ws?.closeAll();
      } catch { /* ignore */ }
    }
    this.klineWs = null;
    this.aggWs = null;
    this.liqWs = null;
    await this.executor?.cancelAllStops();
    const pos = await this.executor?.getPosition().catch(() => ({ qty: 0, entry: 0, side: null }));
    if (pos && pos.qty > 0) {
      logger.warn(`[LiqRev] Stopped with OPEN POSITION (${pos.side} ${pos.qty}) — manage manually!`);
    }
    await this.persist();
  }

  async sync(): Promise<void> {
    return this.runExclusive(async () => {
      const pos = await this.executor.getPosition();
      if (pos.qty > 0 && pos.side && !this.state.side) {
        logger.warn(`[LiqRev] Adopting position ${pos.side} ${pos.qty} @ ${pos.entry}`);
        this.state.phase = 'IN_POSITION';
        this.state.side = pos.side;
        this.state.qty = pos.qty;
        this.state.entry = pos.entry;
        this.state.openedAt = Date.now();
        this.state.timeStopAt = Date.now() + LIQREV_TIME_STOP_MIN * 60_000;
        this.state.cycleId = this.state.cycleId ?? randomUUID();
        await this.ensureExitOrders();
        await this.persist();
        return;
      }
      if (pos.qty === 0 && this.state.side) {
        await this.finalizeTrade(orderBookCollector.currentPrice || this.state.entry, null, { orphaned: true });
        return;
      }
      if (pos.qty > 0 && this.state.side) {
        this.state.qty = pos.qty;
        this.state.entry = pos.entry;
        await this.ensureExitOrders();
        await this.persist();
      }
    });
  }

  async onOrderUpdate(data: { order: Record<string, unknown> }): Promise<unknown> {
    const order = data.order;
    if (order.symbol !== SYMBOL) return;
    if (order.orderStatus !== 'FILLED') return;

    return this.runExclusive(async () => {
      const pos = await this.executor.getPosition();
      if (pos.qty > 0 && this.state.side) {
        this.state.qty = pos.qty;
        this.state.entry = pos.entry;
        await this.persist();
        return;
      }
      if (!this.state.side) return;

      const exitPrice = parseFloat((order.averagePrice || order.price || '0') as string);
      const rp = parseFloat((order.realisedProfit || order.rp || '0') as string);
      await this.finalizeTrade(exitPrice || this.state.entry, rp !== 0 ? rp : null, {
        exitClientOrderId: order.clientOrderId,
      });
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
          this.state.slAlgoId = null;
          await this.placeStop();
          await this.persist();
        }
      });
    }
  }

  async getMetrics(): Promise<Record<string, unknown>> {
    const balance = await this.executor.getBalance().catch(() => null);
    return {
      strategy: this.id,
      mode: this.mode,
      phase: this.state.phase,
      armed: this.armed,
      atr1m: this.atr1m,
      cvd1m: this.cvd.deltaLastMinutes(1),
      liqEvents60s: {
        sell: this.notionalInWindow('SELL'),
        buy: this.notionalInWindow('BUY'),
      },
      cooldownUntil: this.state.cooldownUntil,
      position: this.state.side
        ? {
            side: this.state.side,
            qty: this.state.qty,
            entry: this.state.entry,
            slPrice: this.state.slPrice,
            tpPrice: this.state.tpPrice,
            timeStopAt: this.state.timeStopAt,
          }
        : null,
      balance,
    };
  }

  // ─── streams ──────────────────────────────────────────────────────────────

  private subscribeLiquidations(): void {
    if (this.liqWs) return;
    this.liqWs = new WebsocketClient({ beautify: true, demoTrading: USE_TESTNET });
    this.liqWs.on('message', (msg: unknown) => {
      const ev = ((msg as { data?: Record<string, unknown> })?.data ?? msg) as {
        eventType?: string;
        liquidationOrder?: {
          symbol: string;
          side: 'BUY' | 'SELL';
          price: number;
          averagePrice: number;
          quantity: number;
          lastFilledQuantity: number;
        };
      };
      if (ev?.eventType !== 'forceOrder') return;
      const lo = ev.liquidationOrder;
      if (!lo || lo.symbol !== SYMBOL) return;
      const px = lo.averagePrice || lo.price;
      const qty = lo.lastFilledQuantity || lo.quantity;
      if (px <= 0 || qty <= 0) return;
      void this.onLiquidation({
        ts: Date.now(),
        side: lo.side,
        notional: px * qty,
        price: px,
      });
    });
    void this.liqWs.subscribeSymbolLiquidationOrders(SYMBOL, 'usdm');
  }

  private subscribeAggTrades(): void {
    if (this.aggWs) return;
    this.aggWs = new WebsocketClient({ beautify: false, demoTrading: USE_TESTNET });
    this.aggWs.on('message', (msg: unknown) => {
      const ev = ((msg as { data?: Record<string, unknown> })?.data ?? msg) as {
        e?: string;
        s?: string;
        p?: string;
        q?: string;
        m?: boolean;
      };
      if (ev?.e !== 'aggTrade' || ev.s !== SYMBOL) return;
      this.cvd.onTrade(Number(ev.p), Number(ev.q), Boolean(ev.m));
    });
    void this.aggWs.subscribeAggregateTrades(SYMBOL, 'usdm');
  }

  private subscribe1mKlines(): void {
    if (this.klineWs) return;
    this.klineWs = new WebsocketClient({ beautify: false, demoTrading: USE_TESTNET });
    this.klineWs.on('message', (msg: unknown) => {
      const ev = ((msg as { data?: Record<string, unknown> })?.data ?? msg) as {
        e?: string;
        s?: string;
        k?: Record<string, unknown>;
      };
      if (ev?.e !== 'kline' || ev.s !== SYMBOL || ev.k?.x !== true) return;
      const candle: Candle = {
        openTime: Number(ev.k.t),
        open: Number(ev.k.o),
        high: Number(ev.k.h),
        low: Number(ev.k.l),
        close: Number(ev.k.c),
        volume: Number(ev.k.v),
      };
      this.candles1m.push(candle);
      if (this.candles1m.length > 120) this.candles1m.shift();
      this.atr1m = atr(this.candles1m, LIQREV_ATR_PERIOD);
    });
    void this.klineWs.subscribeKlines(SYMBOL, '1m', 'usdm');
  }

  private async warmup1mCandles(): Promise<void> {
    const raw = await client.getKlines({ symbol: SYMBOL, interval: '1m', limit: 120 });
    const now = Date.now();
    this.candles1m = raw
      .map((k) => ({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: Number(k[6]),
      }))
      .filter((c) => c.closeTime <= now)
      .map(({ closeTime: _c, ...c }) => c);
    this.atr1m = atr(this.candles1m, LIQREV_ATR_PERIOD);
  }

  private startWindowSampler(): void {
    if (this.windowTimer) return;
    this.windowTimer = setInterval(() => this.sampleLiqWindow(), LIQREV_WINDOW_SEC * 1000);
  }

  private sampleLiqWindow(): void {
    const now = Date.now();
    const sell = notionalInWindowLocal(this.liqEvents, 'SELL', now, LIQREV_WINDOW_SEC);
    const buy = notionalInWindowLocal(this.liqEvents, 'BUY', now, LIQREV_WINDOW_SEC);
    this.liqHistory.push(sell, buy);
    this.liqEvents = pruneEvents(this.liqEvents, now, LIQREV_WINDOW_SEC * 2);
    void this.persist();
  }

  // ─── signal logic ─────────────────────────────────────────────────────────

  private async onLiquidation(event: LiqEvent): Promise<void> {
    return this.runExclusive(async () => {
      const bot = await stateManager.getState();
      if (bot.status !== 'RUNNING') return;
      if (this.state.phase === 'IN_POSITION') return;
      if (isCooldownActive(this.state.cooldownUntil)) return;

      this.liqEvents.push(event);
      const now = event.ts;
      const price = orderBookCollector.currentPrice || event.price;
      this.recordPrice(now, price);

      if (this.armed) {
        if (event.side === this.armed.liqSide) {
          this.armed = refreshArmedOnLiq(this.armed, price, now);
          await recordSignal(this.id, SYMBOL, 'cascade_leg', {
            direction: this.armed.direction,
            price,
            cascadeExtreme: this.armed.cascadeExtreme,
          }, false);
        }
        return;
      }

      await this.tryDetectCascade(now, price);
    });
  }

  private async tryDetectCascade(now: number, price: number): Promise<void> {
    if (!this.atr1m || this.atr1m <= 0 || price <= 0) return;

    const change = priceChangeOverWindow(this.priceHistory, now, LIQREV_WINDOW_SEC);
    if (change === null) return;

    const sellN = notionalInWindowLocal(this.liqEvents, 'SELL', now, LIQREV_WINDOW_SEC);
    const buyN = notionalInWindowLocal(this.liqEvents, 'BUY', now, LIQREV_WINDOW_SEC);
    const sellTh = this.liqHistory.threshold('SELL', LIQREV_PERCENTILE, LIQREV_MIN_NOTIONAL);
    const buyTh = this.liqHistory.threshold('BUY', LIQREV_PERCENTILE, LIQREV_MIN_NOTIONAL);

    const detected = detectCascade({
      sellNotional60s: sellN,
      buyNotional60s: buyN,
      priceChange60s: change,
      atr1m: this.atr1m,
      sellThreshold: sellTh,
      buyThreshold: buyTh,
      priceMoveAtrMult: LIQREV_PRICE_MOVE_ATR,
    });
    if (!detected) return;

    const cvd1m = this.cvd.deltaLastMinutes(1, now);
    const startPrice = price - change;
    this.armed = createArmedCascade(detected, price, startPrice, cvd1m, now);

    logger.info('[LiqRev] Cascade detected — ARMED', {
      direction: detected.direction,
      tradeSide: detected.tradeSide,
      sellN,
      buyN,
      sellTh,
      buyTh,
      change,
      atr1m: this.atr1m,
    });

    await recordSignal(this.id, SYMBOL, 'cascade_detected', {
      direction: detected.direction,
      tradeSide: detected.tradeSide,
      sellNotional60s: sellN,
      buyNotional60s: buyN,
      priceChange60s: change,
      atr1m: this.atr1m,
      cascadeStart: startPrice,
      cascadeExtreme: this.armed.cascadeExtreme,
    }, false);
  }

  private onPriceTick(price: number): void {
    if (price <= 0) return;
    const now = Date.now();
    this.recordPrice(now, price);

    if (now - this.lastTickEval < LIQREV_TICK_THROTTLE_MS) return;
    this.lastTickEval = now;
    void this.runExclusive(() => this.evaluateTick(price, now)).catch((e) =>
      logger.error('[LiqRev] evaluateTick failed', { error: e })
    );
  }

  private async evaluateTick(price: number, now: number): Promise<void> {
    const bot = await stateManager.getState();
    if (bot.status !== 'RUNNING') return;

    if (this.state.phase === 'IN_POSITION' && this.state.side) {
      if (isTimeStopDue(this.state.openedAt, LIQREV_TIME_STOP_MIN, now)) {
        logger.info('[LiqRev] Time stop — closing at market');
        await this.closeAtMarket('time_stop');
      }
      return;
    }

    if (!this.armed) return;

    if (isArmedExpired(this.armed.armedAt, LIQREV_ARMED_TTL_MIN, now)) {
      logger.info('[LiqRev] Armed signal expired');
      await recordSignal(this.id, SYMBOL, 'armed_expired', {
        direction: this.armed.direction,
        armedMs: now - this.armed.armedAt,
        cascadeExtreme: this.armed.cascadeExtreme,
      }, false);
      this.armed = null;
      return;
    }

    const cvd1m = this.cvd.deltaLastMinutes(1, now);
    if (
      !isCascadeExhausted({
        armed: this.armed,
        now,
        price,
        cvd1m,
        exhaustSec: LIQREV_EXHAUST_SEC,
      })
    ) {
      return;
    }

    await this.enterFromArmed(price, now);
  }

  private async enterFromArmed(price: number, now: number): Promise<void> {
    if (!this.armed || !this.atr1m) return;
    const armed = this.armed;
    this.armed = null;

    const { sl, tp } = computeLiqRevStops(
      armed.tradeSide,
      price,
      armed.cascadeStartPrice,
      armed.cascadeExtreme,
      this.atr1m,
      LIQREV_SL_BUFFER_ATR,
      LIQREV_TP_RETRACE,
      this.precision.tickSize
    );

    const balance = await this.executor.getBalance();
    const sizing = computeEntryQty(
      balance,
      LIQREV_RISK_PCT,
      price,
      sl,
      armed.tradeSide,
      this.precision.stepSize,
      this.precision.minQty,
      this.precision.minNotional
    );

    if (!sizing.valid) {
      logger.warn('[LiqRev] Entry skipped — sizing invalid', { reason: sizing.reason, sl, tp });
      await recordSignal(this.id, SYMBOL, 'entry_skipped', {
        reason: sizing.reason,
        tradeSide: armed.tradeSide,
        sl,
        tp,
        cascadeExtreme: armed.cascadeExtreme,
      }, false);
      return;
    }

    const orderSide = armed.tradeSide === 'LONG' ? 'BUY' : 'SELL';
    logger.info(`[LiqRev] Entering ${armed.tradeSide} qty=${sizing.qty} sl=${sl} tp=${tp}`);

    await recordSignal(this.id, SYMBOL, 'entry', {
      tradeSide: armed.tradeSide,
      qty: sizing.qty,
      sl,
      tp,
      cascadeStart: armed.cascadeStartPrice,
      cascadeExtreme: armed.cascadeExtreme,
      cvd1m: this.cvd.deltaLastMinutes(1, now),
    }, true);

    try {
      await this.executor.submitOrder({
        side: orderSide,
        type: 'MARKET',
        quantity: sizing.qty,
      });
    } catch (e) {
      logger.error('[LiqRev] Market entry failed', { error: e });
      return;
    }

    await sleep(300);
    const pos = await this.executor.getPosition();
    if (pos.qty === 0 || !pos.side) {
      logger.error('[LiqRev] Entry submitted but no position');
      return;
    }

    this.state.phase = 'IN_POSITION';
    this.state.side = pos.side;
    this.state.qty = pos.qty;
    this.state.entry = pos.entry;
    this.state.slPrice = sl;
    this.state.tpPrice = tp;
    this.state.cascadeStart = armed.cascadeStartPrice;
    this.state.cascadeExtreme = armed.cascadeExtreme;
    this.state.openedAt = now;
    this.state.timeStopAt = now + LIQREV_TIME_STOP_MIN * 60_000;
    this.state.cycleId = randomUUID();
    this.state.feesPaid = pos.qty * pos.entry * TAKER_FEE;

    await this.placeStop();
    await this.placeTakeProfit();
    await this.persist();
  }

  // ─── exits ────────────────────────────────────────────────────────────────

  private async placeStop(): Promise<void> {
    if (!this.state.side || !this.state.slPrice) return;
    const closeSide = this.state.side === 'LONG' ? 'SELL' : 'BUY';
    try {
      await this.executor.cancelAllStops();
      const ack = await this.executor.submitStopMarket({
        side: closeSide,
        triggerPrice: this.state.slPrice,
        closePosition: true,
      });
      this.state.slAlgoId = ack.algoId;
    } catch (e) {
      logger.error('[LiqRev] Failed to place stop', { error: e });
      this.state.slAlgoId = null;
    }
  }

  private async placeTakeProfit(): Promise<void> {
    if (!this.state.side || !this.state.tpPrice || this.state.qty <= 0) return;
    const tpId = `liqrev_tp_${randomUUID().slice(0, 8)}`;
    const closeSide = this.state.side === 'LONG' ? 'SELL' : 'BUY';
    try {
      if (this.state.tpClientOrderId) {
        await this.executor.cancelOrder(this.state.tpClientOrderId).catch(() => undefined);
      }
      await this.executor.submitOrder({
        side: closeSide,
        type: 'LIMIT',
        quantity: this.state.qty,
        price: this.state.tpPrice,
        reduceOnly: true,
        clientOrderId: tpId,
      });
      this.state.tpClientOrderId = tpId;
    } catch (e) {
      logger.error('[LiqRev] Failed to place TP limit', { error: e });
      this.state.tpClientOrderId = null;
    }
  }

  private async ensureExitOrders(): Promise<void> {
    if (!this.state.side) return;
    if (!this.state.slAlgoId) await this.placeStop();
    if (!this.state.tpClientOrderId && this.state.tpPrice) await this.placeTakeProfit();
  }

  private async closeAtMarket(reason: string): Promise<void> {
    if (!this.state.side || this.state.qty <= 0) return;
    if (this.state.tpClientOrderId) {
      await this.executor.cancelOrder(this.state.tpClientOrderId).catch(() => undefined);
      this.state.tpClientOrderId = null;
    }
    await this.executor.cancelAllStops();
    try {
      await this.executor.submitOrder({
        side: this.state.side === 'LONG' ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity: this.state.qty,
        reduceOnly: true,
      });
    } catch (e) {
      logger.error('[LiqRev] Market close failed', { error: e, reason });
    }
  }

  private async finalizeTrade(
    exitPrice: number,
    realizedFromExchange: number | null,
    meta: Record<string, unknown>
  ): Promise<void> {
    const { side, qty, entry, openedAt, cycleId } = this.state;
    if (!side) return;

    if (this.state.tpClientOrderId) {
      await this.executor.cancelOrder(this.state.tpClientOrderId).catch(() => undefined);
    }
    await this.executor.cancelAllStops();

    const dir = side === 'LONG' ? 1 : -1;
    const exitFees = qty * exitPrice * TAKER_FEE;
    const fees = this.state.feesPaid + exitFees;
    const gross = (exitPrice - entry) * qty * dir;
    const realized = realizedFromExchange ?? gross - exitFees;

    await stateManager.saveTrade({
      cycle_id: cycleId ?? randomUUID(),
      symbol: SYMBOL,
      side,
      entry_price: entry,
      exit_price: exitPrice,
      pnl: realized,
      realized_pnl: realized,
      strategy: 'liqrev',
      qty,
      fees,
      opened_at: openedAt ? new Date(openedAt) : null,
      meta: { ...meta, mode: this.mode, tp: this.state.tpPrice, sl: this.state.slPrice },
    });

    logger.info(
      `[LiqRev] Trade closed: ${side} ${qty} ${entry} → ${exitPrice} | PnL $${realized.toFixed(2)}`
    );

    this.state.cooldownUntil = Date.now() + LIQREV_COOLDOWN_MIN * 60_000;
    this.state = { ...emptyState(), cooldownUntil: this.state.cooldownUntil };
    this.armed = null;
    await this.persist();
  }

  private recordPrice(ts: number, price: number): void {
    const last = this.priceHistory[this.priceHistory.length - 1];
    if (last && ts - last.ts < 1000 && Math.abs(last.price - price) < this.precision.tickSize) return;
    this.priceHistory.push({ ts, price });
    const cutoff = ts - (LIQREV_WINDOW_SEC + 30) * 1000;
    this.priceHistory = this.priceHistory.filter((p) => p.ts >= cutoff);
  }

  private notionalInWindow(side: 'BUY' | 'SELL'): number {
    return notionalInWindowLocal(this.liqEvents, side, Date.now(), LIQREV_WINDOW_SEC);
  }

  private async persist(): Promise<void> {
    if (this.mode === 'paper' && this.executor instanceof PaperExecutor) {
      this.state.paper = this.executor.toJSON();
    }
    this.state.cvd = this.cvd.toJSON();
    this.state.liqHistory = this.liqHistory.toJSON();
    await stateManager.saveStrategyState('liqrev', this.state);
  }
}

function notionalInWindowLocal(
  events: LiqEvent[],
  side: 'BUY' | 'SELL',
  now: number,
  windowSec: number
): number {
  const cutoff = now - windowSec * 1000;
  return events.filter((e) => e.side === side && e.ts >= cutoff).reduce((s, e) => s + e.notional, 0);
}
