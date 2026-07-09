import { randomUUID } from 'crypto';
import { client } from '../../bot/client';
import { SYMBOL, TAKER_FEE } from '../../bot/config';
import { fetchSymbolPrecision, getAccountBalance } from '../../bot/exchange';
import { floorStep } from '../../bot/math';
import { orderBookCollector } from '../../bot/orderbook';
import {
  fetchSpotSymbolPrecision,
  getSpotAssetBalance,
  spotClient,
} from '../../bot/spotClient';
import { stateManager } from '../../bot/state';
import { SymbolPrecision } from '../../bot/types';
import { LiveExecutor } from '../../execution/live';
import { PaperExecutor, PaperState } from '../../execution/paper';
import { computeCombinedPaperBalance, SpotPaperState, SpotPaperWallet } from '../../execution/spotPaper';
import { Executor } from '../../execution/types';
import { logger } from '../../utils/logger';
import { recordSignal } from '../shared/signals';
import { ExecutionMode, Strategy } from '../types';
import {
  FUNDING_ENTRY_APR,
  FUNDING_ENTRY_WINDOWS,
  FUNDING_EVAL_MINUTES,
  FUNDING_EXIT_APR,
  FUNDING_EXIT_WINDOWS,
  FUNDING_HOURLY_MINUTES,
  FUNDING_MARGIN_REDUCE_RATIO,
  FUNDING_MARGIN_WARN_RATIO,
  FUNDING_MAX_LEVERAGE,
  FUNDING_MIN_HOLD_DAYS,
  FUNDING_NOTIONAL_PCT,
  FUNDING_REBALANCE_DRIFT,
  FUNDING_SYMBOL,
} from './config';
import {
  baseAssetFromSymbol,
  computeApr,
  computeBasisPnl,
  computeMarginRatio,
  computeNotionalQty,
  needsRebalance,
  passesPreEntryFeeGate,
  rebalancePerpDelta,
  reduceQty,
  resolveOpenLegAction,
  shouldClose,
  shouldOpen,
  shouldReduceMargin,
} from './rules';

const USE_TESTNET = process.env.USE_TESTNET === 'true';

export type FundingPhase = 'IDLE' | 'OPENING' | 'NEUTRAL' | 'CLOSING';

export interface FundingState {
  phase: FundingPhase;
  spotQty: number;
  perpQty: number;
  entryBasis: number;
  entrySpotPrice: number;
  entryPerpPrice: number;
  openedAt: number | null;
  fundingAccrued: number;
  feesPaid: number;
  cycleId: string | null;
  lastEvalAt: number | null;
  lastFundingTime: number | null;
  paper?: { perp: PaperState; spot: SpotPaperState };
}

const emptyState = (): FundingState => ({
  phase: 'IDLE',
  spotQty: 0,
  perpQty: 0,
  entryBasis: 0,
  entrySpotPrice: 0,
  entryPerpPrice: 0,
  openedAt: null,
  fundingAccrued: 0,
  feesPaid: 0,
  cycleId: null,
  lastEvalAt: null,
  lastFundingTime: null,
});

export class FundingStrategy implements Strategy {
  readonly id = 'funding' as const;

  private perpExecutor!: Executor;
  private spotPaper: SpotPaperWallet | null = null;
  private perpPrecision: SymbolPrecision = { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 };
  private spotPrecision = { stepSize: 0.001, minQty: 0.001, minNotional: 5 };
  private baseAsset = baseAssetFromSymbol(FUNDING_SYMBOL);
  private state: FundingState = emptyState();
  private evalTimer: NodeJS.Timeout | null = null;
  private hourlyTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly mode: ExecutionMode) {}

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch((e) => logger.error('[Funding] Error in exclusive task', { error: e }));
    return run;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    this.perpPrecision = await fetchSymbolPrecision(FUNDING_SYMBOL);
    this.spotPrecision = await fetchSpotSymbolPrecision(FUNDING_SYMBOL);

    const persisted = (await stateManager.getState()).orders?.funding as FundingState | undefined;
    if (persisted?.phase) {
      this.state = { ...emptyState(), ...persisted };
      if (persisted.paper?.spot && this.mode === 'paper') {
        this.spotPaper = new SpotPaperWallet();
        this.spotPaper.restore(persisted.paper.spot);
      }
      logger.info('[Funding] Restored state', { phase: this.state.phase });
    }

    if (this.mode === 'paper') {
      const paper = new PaperExecutor({ symbol: FUNDING_SYMBOL });
      if (this.state.paper?.perp) paper.restore(this.state.paper.perp);
      this.perpExecutor = paper;
      if (!this.spotPaper) this.spotPaper = new SpotPaperWallet();
      orderBookCollector.onPrice = () => {
        const bid = orderBookCollector.currentBid;
        const ask = orderBookCollector.currentAsk;
        if (bid > 0 && ask > bid) paper.tick({ bid, ask });
      };
      orderBookCollector.startPriceStream(FUNDING_SYMBOL);
    } else {
      this.perpExecutor = new LiveExecutor(FUNDING_SYMBOL);
      try {
        await client.setMarginType({ symbol: FUNDING_SYMBOL, marginType: 'CROSSED' });
      } catch { /* ok */ }
      try {
        await client.setLeverage({ symbol: FUNDING_SYMBOL, leverage: FUNDING_MAX_LEVERAGE });
      } catch (e) {
        logger.error('[Funding] Error setting leverage', { error: e });
      }
    }

    await this.reconcileFromExchange();
    this.initialized = true;
    logger.info(`[Funding] Initialized (${this.mode}, symbol ${FUNDING_SYMBOL})`);
  }

  async start(): Promise<void> {
    if (!this.initialized) await this.init();
    this.startEvalTimer();
    if (this.state.phase === 'NEUTRAL') this.startHourlyTimer();
    await this.runExclusive(() => this.evaluateFunding());
  }

  async stop(): Promise<void> {
    this.clearTimers();
    await this.persist();
  }

  async sync(): Promise<void> {
    return this.runExclusive(async () => {
      await this.reconcileFromExchange();
      await this.persist();
    });
  }

  async onOrderUpdate(_data: { order: Record<string, unknown> }): Promise<unknown> {
    return this.runExclusive(async () => {
      await this.reconcileFromExchange();
    });
  }

  async onAlgoUpdate(_data: { algoOrder: Record<string, unknown> }): Promise<unknown> {
    /* No price SL — delta-neutral harvest. */
    return undefined;
  }

  async getMetrics(): Promise<Record<string, unknown>> {
    const mark = await this.fetchMark().catch(() => null);
    const markPrice = mark ? parseFloat(mark.markPrice as string) : orderBookCollector.currentPrice;
    const balance = await this.getCombinedBalance(markPrice);
    return {
      strategy: this.id,
      mode: this.mode,
      symbol: FUNDING_SYMBOL,
      phase: this.state.phase,
      spotQty: this.state.spotQty,
      perpQty: this.state.perpQty,
      entryBasis: this.state.entryBasis,
      fundingAccrued: this.state.fundingAccrued,
      currentApr: mark ? computeApr(parseFloat(mark.lastFundingRate as string)) : null,
      lastFundingRate: mark?.lastFundingRate ?? null,
      nextFundingTime: mark?.nextFundingTime ?? null,
      balance,
    };
  }

  // ─── timers ───────────────────────────────────────────────────────────────

  private startEvalTimer(): void {
    if (this.evalTimer) return;
    this.evalTimer = setInterval(
      () => void this.runExclusive(() => this.evaluateFunding()).catch((e) =>
        logger.error('[Funding] evaluateFunding failed', { error: e })
      ),
      FUNDING_EVAL_MINUTES * 60_000
    );
  }

  private startHourlyTimer(): void {
    if (this.hourlyTimer) return;
    this.hourlyTimer = setInterval(
      () => void this.runExclusive(() => this.hourlyMaintenance()).catch((e) =>
        logger.error('[Funding] hourlyMaintenance failed', { error: e })
      ),
      FUNDING_HOURLY_MINUTES * 60_000
    );
  }

  private clearTimers(): void {
    if (this.evalTimer) clearInterval(this.evalTimer);
    if (this.hourlyTimer) clearInterval(this.hourlyTimer);
    this.evalTimer = null;
    this.hourlyTimer = null;
  }

  // ─── evaluation ───────────────────────────────────────────────────────────

  private async evaluateFunding(): Promise<void> {
    const bot = await stateManager.getState();
    if (bot.status !== 'RUNNING') return;
    if (this.state.phase === 'OPENING' || this.state.phase === 'CLOSING') return;

    const mark = await this.fetchMark();
    const history = await this.fetchFundingHistory();
    const rates = history.map((h) => parseFloat(h.fundingRate as string));
    const currentApr = computeApr(parseFloat(mark.lastFundingRate as string));

    await recordSignal(this.id, FUNDING_SYMBOL, 'funding_eval', {
      phase: this.state.phase,
      currentApr,
      lastRate: parseFloat(mark.lastFundingRate as string),
      consecutiveAbove: rates.length,
    }, false);

    this.state.lastEvalAt = Date.now();

    if (this.state.phase === 'IDLE') {
      const openOk =
        shouldOpen(rates, FUNDING_ENTRY_APR, FUNDING_ENTRY_WINDOWS) &&
        passesPreEntryFeeGate(currentApr, FUNDING_MIN_HOLD_DAYS);
      if (openOk) {
        logger.info('[Funding] Entry conditions met', { currentApr });
        await this.openNeutral(parseFloat(mark.markPrice as string));
      }
      await this.persist();
      return;
    }

    if (this.state.phase === 'NEUTRAL') {
      if (shouldClose(rates, FUNDING_EXIT_APR, FUNDING_EXIT_WINDOWS)) {
        logger.info('[Funding] Exit conditions met', { currentApr });
        await this.closeNeutral(parseFloat(mark.markPrice as string));
      }
      await this.persist();
    }
  }

  private async hourlyMaintenance(): Promise<void> {
    if (this.state.phase !== 'NEUTRAL') return;

    await this.refreshFundingAccrued();
    await this.reconcileFromExchange();

    const mark = await this.fetchMark();
    const price = parseFloat(mark.markPrice as string);

    if (needsRebalance(this.state.spotQty, this.state.perpQty, FUNDING_REBALANCE_DRIFT)) {
      await this.rebalancePerp(price);
    }

    if (this.mode === 'live') {
      const acct = await client.getAccountInformationV3();
      const ratio = computeMarginRatio(
        parseFloat(acct.totalMaintMargin as string),
        parseFloat(acct.totalMarginBalance as string)
      );
      if (shouldReduceMargin(ratio, FUNDING_MARGIN_WARN_RATIO)) {
        logger.warn('[Funding] High margin ratio — reducing both legs 25%', { ratio });
        await this.reduceBothLegs(price, FUNDING_MARGIN_REDUCE_RATIO);
      }
    }

    await this.simulatePaperFunding(mark);
    await this.persist();
  }

  // ─── open / close ─────────────────────────────────────────────────────────

  private async openNeutral(markPrice: number): Promise<void> {
    this.state.phase = 'OPENING';
    await this.persist();

    const balance = await this.getCombinedBalance(markPrice);
    const sizing = computeNotionalQty(
      balance,
      FUNDING_NOTIONAL_PCT,
      markPrice,
      Math.min(this.perpPrecision.stepSize, this.spotPrecision.stepSize),
      Math.max(this.perpPrecision.minQty, this.spotPrecision.minQty),
      Math.max(this.perpPrecision.minNotional, this.spotPrecision.minNotional)
    );

    if (!sizing.valid) {
      logger.warn('[Funding] Open skipped — invalid sizing', { reason: sizing.reason });
      this.state.phase = 'IDLE';
      await recordSignal(this.id, FUNDING_SYMBOL, 'open_skipped', { reason: sizing.reason }, false);
      await this.persist();
      return;
    }

    const qty = sizing.qty;
    let spotQty = 0;
    let perpQty = 0;
    let spotPrice = markPrice;
    let perpPrice = markPrice;

    // 1) Buy spot
    if (this.mode === 'paper' && this.spotPaper) {
      const ask = orderBookCollector.currentAsk || markPrice;
      const res = this.spotPaper.buyMarket(qty, ask);
      if (!res.ok) {
        logger.error('[Funding] Spot buy failed (paper)', { reason: res.reason });
        this.state.phase = 'IDLE';
        await this.persist();
        return;
      }
      spotQty = qty;
      spotPrice = ask;
      this.state.feesPaid += qty * ask * TAKER_FEE;
    } else {
      try {
        const spotRes = await spotClient.submitNewOrder({
          symbol: FUNDING_SYMBOL,
          side: 'BUY',
          type: 'MARKET',
          quantity: qty,
        });
        spotQty = parseFloat(spotRes.executedQty as string) || qty;
        spotPrice =
          parseFloat(spotRes.cummulativeQuoteQty as string) / spotQty || markPrice;
      } catch (e) {
        logger.error('[Funding] Spot buy failed', { error: e });
        this.state.phase = 'IDLE';
        await this.persist();
        return;
      }
    }

    // 2) Short perp
    try {
      await this.perpExecutor.submitOrder({ side: 'SELL', type: 'MARKET', quantity: qty });
      await this.sleep(400);
      const pos = await this.perpExecutor.getPosition();
      perpQty = pos.qty;
      perpPrice = pos.entry || markPrice;
    } catch (e) {
      logger.error('[Funding] Perp short failed — rolling back spot', { error: e });
      const action = resolveOpenLegAction({ spotQty, perpQty: 0, perpFailed: true });
      if (action === 'rollback_spot') await this.sellSpot(spotQty, markPrice);
      this.state.phase = 'IDLE';
      await recordSignal(this.id, FUNDING_SYMBOL, 'open_rollback', { spotQty, reason: 'perp_failed' }, false);
      await this.persist();
      return;
    }

    if (perpQty <= 0) {
      logger.error('[Funding] Perp short empty — rolling back spot');
      await this.sellSpot(spotQty, markPrice);
      this.state.phase = 'IDLE';
      await this.persist();
      return;
    }

    this.state.phase = 'NEUTRAL';
    this.state.spotQty = spotQty;
    this.state.perpQty = perpQty;
    this.state.entrySpotPrice = spotPrice;
    this.state.entryPerpPrice = perpPrice;
    this.state.entryBasis = perpPrice - spotPrice;
    this.state.openedAt = Date.now();
    this.state.cycleId = randomUUID();
    this.state.feesPaid += perpQty * perpPrice * TAKER_FEE;

    await recordSignal(this.id, FUNDING_SYMBOL, 'funding_open', {
      spotQty,
      perpQty,
      entryBasis: this.state.entryBasis,
    }, true);

    this.startHourlyTimer();
    logger.info('[Funding] Neutral position opened', {
      spotQty,
      perpQty,
      entryBasis: this.state.entryBasis,
    });
    await this.persist();
  }

  private async closeNeutral(markPrice: number): Promise<void> {
    this.state.phase = 'CLOSING';
    await this.persist();

    const { spotQty, perpQty } = this.state;
    if (spotQty <= 0 && perpQty <= 0) {
      this.state.phase = 'IDLE';
      await this.persist();
      return;
    }

    if (perpQty > 0) {
      try {
        await this.perpExecutor.submitOrder({
          side: 'BUY',
          type: 'MARKET',
          quantity: perpQty,
          reduceOnly: true,
        });
      } catch (e) {
        logger.error('[Funding] Failed to close perp leg', { error: e });
      }
    }

    if (spotQty > 0) {
      await this.sellSpot(spotQty, markPrice);
    }

    await this.refreshFundingAccrued();
    const spotExit = orderBookCollector.currentBid || markPrice;
    const perpExit = orderBookCollector.currentPrice || markPrice;
    const basisPnl = computeBasisPnl(this.state.entryBasis, perpExit - spotExit, spotQty);
    const realized = this.state.fundingAccrued + basisPnl - this.state.feesPaid;

    await stateManager.saveTrade({
      cycle_id: this.state.cycleId ?? randomUUID(),
      symbol: FUNDING_SYMBOL,
      side: 'NEUTRAL',
      entry_price: this.state.entryPerpPrice,
      exit_price: perpExit,
      pnl: realized,
      realized_pnl: realized,
      strategy: 'funding',
      qty: spotQty,
      fees: this.state.feesPaid,
      funding: this.state.fundingAccrued,
      opened_at: this.state.openedAt ? new Date(this.state.openedAt) : null,
      meta: {
        mode: this.mode,
        entryBasis: this.state.entryBasis,
        basisPnl,
        spotExit,
        perpExit,
      },
    });

    logger.info(`[Funding] Neutral closed | funding $${this.state.fundingAccrued.toFixed(2)} basis $${basisPnl.toFixed(2)}`);

    if (this.hourlyTimer) clearInterval(this.hourlyTimer);
    this.hourlyTimer = null;
    this.state = emptyState();
    await this.persist();
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async sellSpot(qty: number, markPrice: number): Promise<void> {
    if (qty <= 0) return;
    if (this.mode === 'paper' && this.spotPaper) {
      const bid = orderBookCollector.currentBid || markPrice;
      this.spotPaper.sellMarket(qty, bid);
      return;
    }
    try {
      await spotClient.submitNewOrder({
        symbol: FUNDING_SYMBOL,
        side: 'SELL',
        type: 'MARKET',
        quantity: qty,
      });
    } catch (e) {
      logger.error('[Funding] Spot sell failed', { error: e });
    }
  }

  private async rebalancePerp(price: number): Promise<void> {
    const delta = rebalancePerpDelta(this.state.spotQty, this.state.perpQty);
    const adjust = floorStep(Math.abs(delta), this.perpPrecision.stepSize);
    if (adjust < this.perpPrecision.minQty) return;

    if (delta > 0) {
      await this.perpExecutor.submitOrder({ side: 'SELL', type: 'MARKET', quantity: adjust });
    } else {
      await this.perpExecutor.submitOrder({
        side: 'BUY',
        type: 'MARKET',
        quantity: adjust,
        reduceOnly: true,
      });
    }
    await this.reconcileFromExchange();
    logger.info('[Funding] Rebalanced perp leg', { delta, adjust, price });
  }

  private async reduceBothLegs(price: number, ratio: number): Promise<void> {
    const newSpot = reduceQty(this.state.spotQty, ratio, this.spotPrecision.stepSize);
    const newPerp = reduceQty(this.state.perpQty, ratio, this.perpPrecision.stepSize);
    const sellSpot = this.state.spotQty - newSpot;
    const coverPerp = this.state.perpQty - newPerp;

    if (coverPerp >= this.perpPrecision.minQty) {
      await this.perpExecutor.submitOrder({
        side: 'BUY',
        type: 'MARKET',
        quantity: coverPerp,
        reduceOnly: true,
      });
    }
    if (sellSpot >= this.spotPrecision.minQty) {
      await this.sellSpot(sellSpot, price);
    }
    await this.reconcileFromExchange();
  }

  private async refreshFundingAccrued(): Promise<void> {
    if (this.mode === 'paper') return;
    try {
      const since = this.state.openedAt ?? Date.now() - 86_400_000;
      const rows = await client.getIncomeHistory({
        symbol: FUNDING_SYMBOL,
        incomeType: 'FUNDING_FEE',
        startTime: since,
        limit: 1000,
      });
      this.state.fundingAccrued = rows.reduce((s, r) => s + parseFloat(r.income as string), 0);
    } catch (e) {
      logger.error('[Funding] Failed to fetch funding income', { error: e });
    }
  }

  private async simulatePaperFunding(mark: {
    lastFundingRate: string | number;
    nextFundingTime: number;
  }): Promise<void> {
    if (this.mode !== 'paper' || !this.spotPaper || this.state.phase !== 'NEUTRAL') return;
    const nft = mark.nextFundingTime;
    if (this.state.lastFundingTime && nft <= this.state.lastFundingTime) return;
    if (Date.now() < nft) return;

    const rate = parseFloat(mark.lastFundingRate as string);
    const notional = this.state.perpQty * (orderBookCollector.currentPrice || 0);
    this.spotPaper.accrueFunding(notional, rate);
    this.state.fundingAccrued += notional * rate;
    this.state.lastFundingTime = nft;
  }

  private async reconcileFromExchange(): Promise<void> {
    if (this.mode === 'paper') {
      this.state.spotQty = this.spotPaper?.assetQty ?? 0;
      const pos = await this.perpExecutor.getPosition();
      this.state.perpQty = pos.qty;
      if (this.state.spotQty > 0 && this.state.perpQty > 0 && this.state.phase === 'IDLE') {
        this.state.phase = 'NEUTRAL';
      }
      if (this.state.spotQty === 0 && this.state.perpQty === 0 && this.state.phase === 'NEUTRAL') {
        this.state.phase = 'IDLE';
      }
      return;
    }

    this.state.spotQty = await getSpotAssetBalance(this.baseAsset);
    const pos = await this.perpExecutor.getPosition();
    this.state.perpQty = pos.side === 'SHORT' ? pos.qty : 0;

    if (this.state.spotQty > 0 && this.state.perpQty > 0) {
      if (this.state.phase === 'IDLE' || this.state.phase === 'OPENING') this.state.phase = 'NEUTRAL';
    } else if (this.state.spotQty === 0 && this.state.perpQty === 0 && this.state.phase === 'NEUTRAL') {
      this.state.phase = 'IDLE';
    }
  }

  private async getCombinedBalance(markPrice: number): Promise<number> {
    if (this.mode === 'paper') {
      const perpBal = await this.perpExecutor.getBalance();
      const spotUsdt = this.spotPaper?.usdtBalance ?? 0;
      const assetQty = this.spotPaper?.assetQty ?? 0;
      return computeCombinedPaperBalance(perpBal, spotUsdt, assetQty, markPrice);
    }
    const futures = await getAccountBalance();
    const spotUsdt = await getSpotAssetBalance('USDT');
    const assetQty = await getSpotAssetBalance(this.baseAsset);
    return futures + spotUsdt + assetQty * markPrice;
  }

  private async fetchMark() {
    return client.getMarkPrice({ symbol: FUNDING_SYMBOL });
  }

  private async fetchFundingHistory() {
    const rows = await client.getFundingRateHistory({ symbol: FUNDING_SYMBOL, limit: 50 });
    return rows.sort((a, b) => a.fundingTime - b.fundingTime);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async persist(): Promise<void> {
    if (this.mode === 'paper') {
      this.state.paper = {
        perp: (this.perpExecutor as PaperExecutor).toJSON(),
        spot: this.spotPaper?.toJSON() ?? { usdtBalance: 0, assetQty: 0, feesPaid: 0 },
      };
    }
    await stateManager.saveStrategyState('funding', this.state);
  }
}
