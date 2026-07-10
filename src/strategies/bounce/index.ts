import { randomUUID } from 'crypto';
import { WebsocketClient } from 'binance';
import { client } from '../../bot/client';
import { SYMBOL, LEVERAGE, TAKER_FEE, CATASTROPHIC_SL_MULT } from '../../bot/config';
import { fetchSymbolPrecision } from '../../bot/exchange';
import { computeCatastrophicSlPrice, wouldSlTriggerNow } from '../../bot/phases/exitPricing';
import { floorStep, roundStep, sleep } from '../../bot/math';
import { orderBookCollector } from '../../bot/orderbook';
import { stateManager } from '../../bot/state';
import { SymbolPrecision } from '../../bot/types';
import { LiveExecutor } from '../../execution/live';
import { PaperExecutor, PaperState } from '../../execution/paper';
import { Executor, FillEvent } from '../../execution/types';
import { logger } from '../../utils/logger';
import { recordSignal } from '../shared/signals';
import { CvdAccumulator } from '../shared/cvd';
import { evaluatePositionTrailing } from '../shared/trailing';
import { ExecutionMode, Strategy } from '../types';
import { atr, Candle } from '../momentum/indicators';
import {
  BOUNCE_ATR_PERIOD,
  BOUNCE_BREAKEVEN_TRIGGER_PCT,
  BOUNCE_BUCKET_SIZE,
  BOUNCE_COLLECT_MINUTES,
  BOUNCE_LIMIT_FILL_SEC,
  BOUNCE_MAX_ADDS,
  BOUNCE_ADD_SIZE_RATIO,
  BOUNCE_ADD_TRIGGER_R,
  BOUNCE_RISK_PCT,
  BOUNCE_SAMPLE_INTERVAL_SEC,
  BOUNCE_SETUP_TTL_MIN,
  BOUNCE_SL_ATR_BUFFER,
  BOUNCE_TICK_THROTTLE_MS,
  BOUNCE_WALLS_TO_KEEP,
  BOUNCE_WALL_PRESENCE,
  BOUNCE_WALL_MIN_RATIO,
  BOUNCE_MAX_ZONES_PER_SIDE,
  BOUNCE_ZONE_RETENTION,
} from './config';
import {
  canAntiMartingaleAdd,
  computeEntryQty,
  computeZoneSlPrice,
  detectZoneTouch,
  isReboundConfirmed,
  ratchetStop,
  shouldAbortOnZoneWithdrawal,
  shouldMoveToBreakeven,
  TradeSide,
  unrealizedPnl,
  updateTouchExtreme,
} from './rules';
import {
  buildScoredZones,
  liveVolumeAtZone,
  ScoredZone,
  WallSnapshot,
  ZoneBuildDiagnostics,
  zoneVolumeRetained,
} from './wallPersistence';

const USE_TESTNET = process.env.USE_TESTNET === 'true';

export type BouncePhase = 'IDLE' | 'COLLECTING' | 'ZONES_READY' | 'SETUP' | 'IN_POSITION';

export interface BounceSetup {
  zone: ScoredZone;
  tradeSide: TradeSide;
  touchStartedAt: number;
  touchExtreme: number;
}

export interface BounceState {
  phase: BouncePhase;
  bidZones: ScoredZone[];
  askZones: ScoredZone[];
  setup: BounceSetup | null;
  side: TradeSide | null;
  qty: number;
  initialQty: number;
  entry: number;
  addsCount: number;
  riskAmount: number;
  originZone: ScoredZone | null;
  stopPrice: number | null;
  slAlgoId: number | null;
  slIsCatastrophic: boolean;
  harvestPeakPrice: number;
  breakevenActive: boolean;
  openedAt: number | null;
  cycleId: string | null;
  feesPaid: number;
  paper?: PaperState;
  cvd?: ReturnType<CvdAccumulator['toJSON']>;
}

const emptyState = (): BounceState => ({
  phase: 'IDLE',
  bidZones: [],
  askZones: [],
  setup: null,
  side: null,
  qty: 0,
  initialQty: 0,
  entry: 0,
  addsCount: 0,
  riskAmount: 0,
  originZone: null,
  stopPrice: null,
  slAlgoId: null,
  slIsCatastrophic: false,
  harvestPeakPrice: 0,
  breakevenActive: false,
  openedAt: null,
  cycleId: null,
  feesPaid: 0,
});

export class BounceStrategy implements Strategy {
  readonly id = 'bounce' as const;

  private executor!: Executor;
  private precision: SymbolPrecision = { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 };
  private state: BounceState = emptyState();
  private snapshots: WallSnapshot[] = [];
  private cvd = new CvdAccumulator();
  private candles1m: Candle[] = [];
  private atr1m: number | null = null;
  private klineWs: WebsocketClient | null = null;
  private aggWs: WebsocketClient | null = null;
  private sampleTimer: NodeJS.Timeout | null = null;
  private collectTimer: NodeJS.Timeout | null = null;
  private lastTickEval = 0;
  private initialized = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly mode: ExecutionMode) {}

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch((e) => logger.error('[Bounce] Error in exclusive task', { error: e }));
    return run;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    this.precision = await fetchSymbolPrecision(SYMBOL);

    const persisted = (await stateManager.getState()).orders?.bounce as BounceState | undefined;
    if (persisted?.phase) {
      this.state = { ...emptyState(), ...persisted, setup: persisted.setup ?? null };
      if (persisted.cvd) this.cvd.restore(persisted.cvd);
      logger.info('[Bounce] Restored state', { phase: this.state.phase, side: this.state.side });
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
        logger.error('[Bounce] Error setting leverage', { error: e });
      }
    }

    await this.warmup1mCandles();
    this.subscribe1mKlines();
    this.subscribeAggTrades();
    await orderBookCollector.ensureDepthCollection(SYMBOL);
    orderBookCollector.onPrice = (p) => this.onPriceTick(p);
    await this.sync();
    this.initialized = true;
    logger.info(`[Bounce] Initialized (${this.mode})`);
  }

  async start(): Promise<void> {
    if (!this.initialized) await this.init();
    return this.runExclusive(async () => {
      const bot = await stateManager.getState();
      if (bot.status !== 'RUNNING') return;

      if (this.state.phase === 'IN_POSITION') {
        await this.ensureStop();
        return;
      }
      if (this.state.phase === 'SETUP') return;
      if (this.state.phase === 'ZONES_READY' && this.hasTradeableZones()) return;
      if (this.state.phase === 'ZONES_READY') {
        logger.warn('[Bounce] ZONES_READY with empty zones — restarting collection');
      }
      await this.startCollectCycle();
    });
  }

  async stop(): Promise<void> {
    this.clearCollectTimers();
    await this.executor?.cancelAllStops();
    const pos = await this.executor?.getPosition().catch(() => ({ qty: 0, entry: 0, side: null }));
    if (pos && pos.qty > 0) {
      logger.warn(`[Bounce] Stopped with OPEN POSITION (${pos.side} ${pos.qty}) — manage manually!`);
    }
    await this.persist();
  }

  async sync(): Promise<void> {
    return this.runExclusive(async () => {
      const pos = await this.executor.getPosition();
      if (pos.qty > 0 && pos.side && !this.state.side) {
        logger.warn(`[Bounce] Adopting position ${pos.side} ${pos.qty} @ ${pos.entry}`);
        this.state.phase = 'IN_POSITION';
        this.state.side = pos.side;
        this.state.qty = pos.qty;
        this.state.entry = pos.entry;
        this.state.harvestPeakPrice = pos.entry;
        this.state.openedAt = Date.now();
        this.state.cycleId = this.state.cycleId ?? randomUUID();
        await this.ensureStop();
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
        await this.ensureStop();
        await this.persist();
      }
    });
  }

  async onOrderUpdate(data: { order: Record<string, unknown> }): Promise<unknown> {
    const order = data.order;
    if (order.symbol !== SYMBOL) return;
    if (order.orderStatus !== 'FILLED') return;

    return this.runExclusive(async () => {
      if (!this.state.side) return;
      const pos = await this.executor.getPosition();
      if (pos.qty > 0) {
        this.state.qty = pos.qty;
        this.state.entry = pos.entry;
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
      bidZones: this.state.bidZones.length,
      askZones: this.state.askZones.length,
      setup: this.state.setup,
      atr1m: this.atr1m,
      cvd1m: this.cvd.deltaLastMinutes(1),
      position: this.state.side
        ? {
            side: this.state.side,
            qty: this.state.qty,
            entry: this.state.entry,
            stopPrice: this.state.stopPrice,
            addsCount: this.state.addsCount,
            breakevenActive: this.state.breakevenActive,
          }
        : null,
      balance,
    };
  }

  // ─── collection ───────────────────────────────────────────────────────────

  private async startCollectCycle(): Promise<void> {
    this.clearCollectTimers();
    this.snapshots = [];
    this.state.phase = 'COLLECTING';
    this.state.setup = null;
    this.state.bidZones = [];
    this.state.askZones = [];
    await this.persist();

    logger.info(`[Bounce] Collecting order book ${BOUNCE_COLLECT_MINUTES} min (sample every ${BOUNCE_SAMPLE_INTERVAL_SEC}s)`);
    await orderBookCollector.ensureDepthCollection(SYMBOL);
    this.takeSnapshot();

    this.sampleTimer = setInterval(() => this.takeSnapshot(), BOUNCE_SAMPLE_INTERVAL_SEC * 1000);
    this.collectTimer = setTimeout(() => {
      void this.runExclusive(() => this.finishCollect()).catch((e) =>
        logger.error('[Bounce] finishCollect failed', { error: e })
      );
    }, BOUNCE_COLLECT_MINUTES * 60_000);
  }

  private takeSnapshot(): void {
    if (!orderBookCollector.isSynced) return;
    const snap = orderBookCollector.getWalls(BOUNCE_BUCKET_SIZE, BOUNCE_WALLS_TO_KEEP);
    if (snap.currentPrice <= 0) return;
    this.snapshots.push({
      ts: Date.now(),
      currentPrice: snap.currentPrice,
      buyWalls: snap.buyWalls.map((w) => ({ price: w.price, volume: w.volume })),
      sellWalls: snap.sellWalls.map((w) => ({ price: w.price, volume: w.volume })),
    });
  }

  private hasTradeableZones(): boolean {
    return this.state.bidZones.length > 0 || this.state.askZones.length > 0;
  }

  private async finishCollect(): Promise<void> {
    this.clearCollectTimers();
    if (this.snapshots.length < 3) {
      logger.warn('[Bounce] Too few wall samples — restarting collect');
      await this.startCollectCycle();
      return;
    }

    const bidDiag: ZoneBuildDiagnostics = {
      samples: 0,
      side: 'bid',
      sideMedianVolume: 0,
      minVolume: 0,
      candidates: 0,
      passed: 0,
    };
    const askDiag: ZoneBuildDiagnostics = {
      samples: 0,
      side: 'ask',
      sideMedianVolume: 0,
      minVolume: 0,
      candidates: 0,
      passed: 0,
    };

    this.state.bidZones = buildScoredZones(
      this.snapshots,
      'bid',
      BOUNCE_WALL_PRESENCE,
      BOUNCE_WALL_MIN_RATIO,
      BOUNCE_MAX_ZONES_PER_SIDE,
      bidDiag
    );
    this.state.askZones = buildScoredZones(
      this.snapshots,
      'ask',
      BOUNCE_WALL_PRESENCE,
      BOUNCE_WALL_MIN_RATIO,
      BOUNCE_MAX_ZONES_PER_SIDE,
      askDiag
    );

    if (!this.hasTradeableZones()) {
      logger.warn('[Bounce] No zones passed filters — restarting collect', {
        samples: this.snapshots.length,
        presenceMin: BOUNCE_WALL_PRESENCE,
        volumeRatioMin: BOUNCE_WALL_MIN_RATIO,
        bid: bidDiag,
        ask: askDiag,
      });
      await this.startCollectCycle();
      return;
    }

    this.state.phase = 'ZONES_READY';
    this.snapshots = [];

    logger.info('[Bounce] Zones ready', {
      bid: this.state.bidZones.map((z) => z.price),
      ask: this.state.askZones.map((z) => z.price),
      bidDiag,
      askDiag,
    });
    await recordSignal('bounce', SYMBOL, 'zones_ready', {
      bid: this.state.bidZones,
      ask: this.state.askZones,
    }, false);
    await this.persist();
  }

  private clearCollectTimers(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.collectTimer) {
      clearTimeout(this.collectTimer);
      this.collectTimer = null;
    }
  }

  // ─── price ticks ──────────────────────────────────────────────────────────

  private onPriceTick(price: number): void {
    if (price <= 0) return;
    const now = Date.now();
    if (now - this.lastTickEval < BOUNCE_TICK_THROTTLE_MS) return;
    this.lastTickEval = now;

    if (this.mode === 'paper' && this.executor instanceof PaperExecutor) {
      const bid = orderBookCollector.currentBid;
      const ask = orderBookCollector.currentAsk;
      if (bid > 0 && ask > bid) this.executor.tick({ bid, ask });
    }

    void this.runExclusive(() => this.handleTick(price)).catch((e) =>
      logger.error('[Bounce] Tick error', { error: e })
    );
  }

  private async handleTick(price: number): Promise<void> {
    const bot = await stateManager.getState();
    if (bot.status !== 'RUNNING') return;

    switch (this.state.phase) {
      case 'ZONES_READY':
        await this.handleZonesReady(price);
        break;
      case 'SETUP':
        await this.handleSetup(price);
        break;
      case 'IN_POSITION':
        await this.handleInPosition(price);
        break;
      default:
        break;
    }
  }

  private liveWalls(): { buy: { price: number; volume: number }[]; sell: { price: number; volume: number }[] } {
    const snap = orderBookCollector.getWalls(BOUNCE_BUCKET_SIZE, BOUNCE_WALLS_TO_KEEP);
    return {
      buy: snap.buyWalls.map((w) => ({ price: w.price, volume: w.volume })),
      sell: snap.sellWalls.map((w) => ({ price: w.price, volume: w.volume })),
    };
  }

  private async handleZonesReady(price: number): Promise<void> {
    const touch = detectZoneTouch(price, this.state.bidZones, this.state.askZones);
    if (!touch) return;

    const walls = touch.tradeSide === 'LONG' ? this.liveWalls().buy : this.liveWalls().sell;
    if (!zoneVolumeRetained(touch.zone, walls, BOUNCE_ZONE_RETENTION)) {
      await recordSignal('bounce', SYMBOL, 'touch_rejected', { reason: 'zone_withdrawn', zone: touch.zone.price }, false);
      return;
    }

    this.state.phase = 'SETUP';
    this.state.setup = {
      zone: touch.zone,
      tradeSide: touch.tradeSide,
      touchStartedAt: Date.now(),
      touchExtreme: price,
    };
    logger.info(`[Bounce] Setup ${touch.tradeSide} at zone ${touch.zone.price} (price ${price})`);
    await this.persist();
  }

  private async handleSetup(price: number): Promise<void> {
    const setup = this.state.setup;
    if (!setup) {
      this.state.phase = 'ZONES_READY';
      return;
    }

    if (Date.now() - setup.touchStartedAt > BOUNCE_SETUP_TTL_MIN * 60_000) {
      logger.info('[Bounce] Setup expired');
      this.state.setup = null;
      this.state.phase = 'ZONES_READY';
      await recordSignal('bounce', SYMBOL, 'setup_expired', { zone: setup.zone.price }, false);
      await this.persist();
      return;
    }

    setup.touchExtreme = updateTouchExtreme(setup.tradeSide, setup.touchExtreme, price);
    const walls = setup.tradeSide === 'LONG' ? this.liveWalls().buy : this.liveWalls().sell;
    if (!zoneVolumeRetained(setup.zone, walls, BOUNCE_ZONE_RETENTION)) {
      logger.info('[Bounce] Setup aborted — zone withdrawn');
      this.state.setup = null;
      this.state.phase = 'ZONES_READY';
      await this.persist();
      return;
    }

    const cvd1m = this.cvd.deltaLastMinutes(1);
    if (
      !isReboundConfirmed({
        tradeSide: setup.tradeSide,
        price,
        touchExtreme: setup.touchExtreme,
        cvd1m,
      })
    ) {
      return;
    }

    await this.enterPosition(setup.tradeSide, setup.zone, price, cvd1m);
  }

  private async enterPosition(
    tradeSide: TradeSide,
    zone: ScoredZone,
    price: number,
    cvd1m: number,
    isAdd = false
  ): Promise<void> {
    const atrValue = this.atr1m ?? price * 0.005;
    const slPrice = computeZoneSlPrice(
      tradeSide,
      zone.price,
      atrValue,
      BOUNCE_SL_ATR_BUFFER,
      this.precision.tickSize
    );
    const balance = await this.executor.getBalance();
    const riskPct = isAdd ? BOUNCE_RISK_PCT * BOUNCE_ADD_SIZE_RATIO : BOUNCE_RISK_PCT;
    const sizing = computeEntryQty(
      balance,
      riskPct,
      price,
      slPrice,
      tradeSide,
      this.precision.stepSize,
      this.precision.minQty,
      this.precision.minNotional
    );

    const kind = isAdd ? 'bounce_add' : tradeSide === 'LONG' ? 'bounce_long' : 'bounce_short';
    if (!sizing.valid) {
      logger.warn(`[Bounce] ${kind} skipped — ${sizing.reason}`);
      await recordSignal('bounce', SYMBOL, kind, { zone: zone.price, reason: sizing.reason }, false);
      if (!isAdd) {
        this.state.setup = null;
        this.state.phase = 'ZONES_READY';
      }
      await this.persist();
      return;
    }

    await recordSignal('bounce', SYMBOL, kind, { zone: zone.price, qty: sizing.qty, cvd1m }, true);

    const entrySide = tradeSide === 'LONG' ? 'BUY' : 'SELL';
    const limitPrice =
      tradeSide === 'LONG'
        ? orderBookCollector.currentBid || zone.price
        : orderBookCollector.currentAsk || zone.price;

    try {
      await this.executor.submitOrder({
        side: entrySide,
        type: 'LIMIT',
        price: roundStep(limitPrice, this.precision.tickSize),
        quantity: sizing.qty,
        timeInForce: 'GTX',
      });
    } catch {
      await this.executor.submitOrder({ side: entrySide, type: 'MARKET', quantity: sizing.qty });
    }

    const deadline = Date.now() + BOUNCE_LIMIT_FILL_SEC * 1000;
    let pos = await this.executor.getPosition();
    while (pos.qty === 0 && Date.now() < deadline) {
      await sleep(500);
      if (this.mode === 'paper' && this.executor instanceof PaperExecutor) {
        const bid = orderBookCollector.currentBid;
        const ask = orderBookCollector.currentAsk;
        if (bid > 0 && ask > bid) this.executor.tick({ bid, ask });
      }
      pos = await this.executor.getPosition();
    }
    if (pos.qty === 0) {
      try {
        await this.executor.submitOrder({ side: entrySide, type: 'MARKET', quantity: sizing.qty });
      } catch (e) {
        logger.error('[Bounce] Market entry failed', { error: e });
        return;
      }
      await sleep(300);
      pos = await this.executor.getPosition();
    }
    if (pos.qty === 0 || !pos.side) return;

    if (isAdd) {
      this.state.qty = pos.qty;
      this.state.entry = pos.entry;
      this.state.addsCount += 1;
      this.state.feesPaid += sizing.qty * price * TAKER_FEE;
      const newSl = computeZoneSlPrice(tradeSide, zone.price, atrValue, BOUNCE_SL_ATR_BUFFER, this.precision.tickSize);
      this.state.stopPrice = ratchetStop(tradeSide, newSl, this.state.stopPrice);
      await this.placeStop();
      await this.persist();
      return;
    }

    this.state.phase = 'IN_POSITION';
    this.state.setup = null;
    this.state.side = pos.side;
    this.state.qty = pos.qty;
    this.state.initialQty = pos.qty;
    this.state.entry = pos.entry;
    this.state.addsCount = 0;
    this.state.originZone = zone;
    this.state.riskAmount = balance * BOUNCE_RISK_PCT;
    this.state.harvestPeakPrice = pos.entry;
    this.state.breakevenActive = false;
    this.state.openedAt = Date.now();
    this.state.cycleId = randomUUID();
    this.state.feesPaid = pos.qty * pos.entry * TAKER_FEE;
    this.state.stopPrice = slPrice;
    this.state.slIsCatastrophic = false;
    await this.placeStop();
    await this.persist();
    logger.info(`[Bounce] Entered ${pos.side} ${pos.qty} @ ${pos.entry} SL ${slPrice}`);
  }

  private async handleInPosition(price: number): Promise<void> {
    if (!this.state.side || !this.state.originZone) return;

    const walls =
      this.state.side === 'LONG' ? this.liveWalls().buy : this.liveWalls().sell;
    const retained = zoneVolumeRetained(this.state.originZone, walls, BOUNCE_ZONE_RETENTION);
    if (shouldAbortOnZoneWithdrawal(this.state.breakevenActive, retained)) {
      logger.warn('[Bounce] Origin zone collapsed — closing at market');
      await this.closeAtMarket();
      return;
    }

    if (
      !this.state.breakevenActive &&
      shouldMoveToBreakeven(this.state.side, this.state.entry, price, BOUNCE_BREAKEVEN_TRIGGER_PCT)
    ) {
      this.state.breakevenActive = true;
      logger.info('[Bounce] Breakeven lock engaged');
    }

    const trail = evaluatePositionTrailing(
      {
        side: this.state.side,
        entryPrice: this.state.entry,
        peakPrice: this.state.harvestPeakPrice,
        stopPrice: this.state.stopPrice,
        slIsCatastrophic: this.state.slIsCatastrophic,
      },
      price,
      this.precision.tickSize
    );
    this.state.harvestPeakPrice = trail.newPeak;
    if (trail.shouldUpdate) {
      this.state.stopPrice = ratchetStop(this.state.side, trail.newStop, this.state.stopPrice);
      await this.placeStop();
    }

    const pnl = unrealizedPnl(this.state.side, this.state.entry, this.state.qty, price);
    if (
      canAntiMartingaleAdd(
        pnl,
        this.state.riskAmount,
        this.state.addsCount,
        BOUNCE_MAX_ADDS,
        BOUNCE_ADD_TRIGGER_R
      )
    ) {
      const addZone = this.findAddZone(price);
      if (addZone) {
        const bidList = this.state.side === 'LONG' ? [addZone] : [];
        const askList = this.state.side === 'SHORT' ? [addZone] : [];
        const touch = detectZoneTouch(price, bidList, askList);
        if (
          touch &&
          isReboundConfirmed({
            tradeSide: this.state.side,
            price,
            touchExtreme: price,
            cvd1m: this.cvd.deltaLastMinutes(1),
          })
        ) {
          await this.enterPosition(this.state.side, addZone, price, this.cvd.deltaLastMinutes(1), true);
        }
      }
    }

    await this.persist();
  }

  /** Next bid zone above origin (long adds) or ask zone below origin (short adds). */
  private findAddZone(price: number): ScoredZone | null {
    if (!this.state.originZone || !this.state.side) return null;
    if (this.state.side === 'LONG') {
      return (
        this.state.bidZones
          .filter((z) => z.price > this.state.originZone!.price && z.price <= price)
          .sort((a, b) => b.price - a.price)[0] ?? null
      );
    }
    return (
      this.state.askZones
        .filter((z) => z.price < this.state.originZone!.price && z.price >= price)
        .sort((a, b) => a.price - b.price)[0] ?? null
    );
  }

  // ─── stops ────────────────────────────────────────────────────────────────

  private async placeStop(): Promise<void> {
    if (!this.state.side || !this.state.stopPrice) return;
    const closeSide = this.state.side === 'LONG' ? 'SELL' : 'BUY';
    const price = orderBookCollector.currentPrice;

    try {
      await this.executor.cancelAllStops();
      const ack = await this.executor.submitStopMarket({
        side: closeSide,
        triggerPrice: this.state.stopPrice,
        closePosition: true,
      });
      this.state.slAlgoId = ack.algoId;
      this.state.slIsCatastrophic = false;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('immediately')) {
        await this.placeCatastrophicStop(closeSide, price);
      } else {
        logger.error('[Bounce] Stop placement failed', { error: msg });
      }
    }
  }

  private async placeCatastrophicStop(closeSide: 'BUY' | 'SELL', price: number): Promise<void> {
    if (!this.state.side) return;
    const sl = computeCatastrophicSlPrice(
      this.state.side,
      this.state.entry,
      this.state.qty,
      this.state.riskAmount || this.state.entry * this.state.qty * BOUNCE_RISK_PCT,
      this.precision.tickSize,
      CATASTROPHIC_SL_MULT
    );
    if (sl <= 0 || (price > 0 && wouldSlTriggerNow(this.state.side, sl, price, this.precision.tickSize))) {
      await this.closeAtMarket();
      return;
    }
    try {
      const ack = await this.executor.submitStopMarket({
        side: closeSide,
        triggerPrice: sl,
        closePosition: true,
      });
      this.state.slAlgoId = ack.algoId;
      this.state.stopPrice = sl;
      this.state.slIsCatastrophic = true;
      logger.warn(`[Bounce] Catastrophic stop @ ${sl}`);
    } catch (e) {
      logger.error('[Bounce] Catastrophic stop failed — closing at market', { error: e });
      await this.closeAtMarket();
    }
  }

  private async ensureStop(): Promise<void> {
    if (!this.state.side || this.state.slAlgoId) return;
    if (!this.state.stopPrice && this.state.originZone) {
      const atrValue = this.atr1m ?? this.state.entry * 0.005;
      this.state.stopPrice = computeZoneSlPrice(
        this.state.side,
        this.state.originZone.price,
        atrValue,
        BOUNCE_SL_ATR_BUFFER,
        this.precision.tickSize
      );
    }
    await this.placeStop();
  }

  private async closeAtMarket(): Promise<void> {
    if (!this.state.side) return;
    await this.executor.submitOrder({
      side: this.state.side === 'LONG' ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: this.state.qty,
      reduceOnly: true,
    });
  }

  private async finalizeTrade(
    exitPrice: number,
    realizedFromExchange: number | null,
    meta: Record<string, unknown>
  ): Promise<void> {
    const { side, qty, entry, cycleId, openedAt } = this.state;
    if (!side) return;

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
      strategy: 'bounce',
      qty,
      fees,
      opened_at: openedAt ? new Date(openedAt) : null,
      meta: {
        ...meta,
        addsCount: this.state.addsCount,
        originZone: this.state.originZone?.price,
        mode: this.mode,
      },
    });
    logger.info(`[Bounce] Closed ${side} PnL $${realized.toFixed(2)}`);

    await this.executor.cancelAllStops();
    this.state = emptyState();
    await this.persist();
    await this.startCollectCycle();
  }

  // ─── market data ──────────────────────────────────────────────────────────

  private async warmup1mCandles(): Promise<void> {
    const raw = await client.getKlines({
      symbol: SYMBOL,
      interval: '1m',
      limit: 120,
    });
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
    this.atr1m = atr(this.candles1m, BOUNCE_ATR_PERIOD);
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
      this.atr1m = atr(this.candles1m, BOUNCE_ATR_PERIOD);
    });
    void this.klineWs.subscribeKlines(SYMBOL, '1m', 'usdm');
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

  private async persist(): Promise<void> {
    if (this.mode === 'paper' && this.executor instanceof PaperExecutor) {
      this.state.paper = this.executor.toJSON();
    }
    this.state.cvd = this.cvd.toJSON();
    await stateManager.saveStrategyState('bounce', this.state);
  }
}
