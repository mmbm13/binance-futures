import { MAKER_FEE, TAKER_FEE } from '../bot/config';
import { PositionSnapshot } from '../bot/types';
import { logger } from '../utils/logger';
import {
  Executor,
  FillEvent,
  NewOrderParams,
  OrderAck,
  StopAck,
  StopMarketParams,
} from './types';

export interface PaperQuote {
  bid: number;
  ask: number;
}

interface RestingOrder {
  clientOrderId: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  reduceOnly: boolean;
}

interface RestingStop {
  algoId: number;
  side: 'BUY' | 'SELL';
  triggerPrice: number;
  closePosition: boolean;
  quantity?: number;
}

export interface PaperState {
  balance: number;
  positionQty: number; // signed: >0 long, <0 short
  entryPrice: number;
  feesPaid: number;
  realizedPnl: number;
  restingOrders: RestingOrder[];
  restingStops: RestingStop[];
  seq: number;
}

export interface PaperExecutorOptions {
  symbol: string;
  initialBalance?: number;
  makerFee?: number;
  takerFee?: number;
  /** Extra adverse fill on market orders, as a fraction of price. */
  slippagePct?: number;
  onEvent?: (event: FillEvent) => void;
}

/**
 * Simulates fills against best bid/ask. Whoever owns the price stream must call
 * tick(quote) on every update so resting limits and stops get evaluated.
 * All state is serializable (toJSON/restore) for persistence in bot_state.orders.
 */
export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const;

  private readonly symbol: string;
  private readonly makerFee: number;
  private readonly takerFee: number;
  private readonly slippagePct: number;
  private onEvent: (event: FillEvent) => void;

  private s: PaperState;
  private lastQuote: PaperQuote | null = null;

  constructor(opts: PaperExecutorOptions) {
    this.symbol = opts.symbol;
    this.makerFee = opts.makerFee ?? MAKER_FEE;
    this.takerFee = opts.takerFee ?? TAKER_FEE;
    this.slippagePct = opts.slippagePct ?? Number(process.env.PAPER_SLIPPAGE_PCT || 0.0002);
    this.onEvent = opts.onEvent ?? (() => undefined);
    this.s = {
      balance: opts.initialBalance ?? Number(process.env.PAPER_INITIAL_BALANCE || 1000),
      positionQty: 0,
      entryPrice: 0,
      feesPaid: 0,
      realizedPnl: 0,
      restingOrders: [],
      restingStops: [],
      seq: 0,
    };
  }

  setEventHandler(handler: (event: FillEvent) => void): void {
    this.onEvent = handler;
  }

  toJSON(): PaperState {
    return { ...this.s, restingOrders: [...this.s.restingOrders], restingStops: [...this.s.restingStops] };
  }

  restore(state: PaperState): void {
    this.s = { ...state, restingOrders: [...state.restingOrders], restingStops: [...state.restingStops] };
  }

  /** Feed a quote; evaluates resting limits and stops. Call on every price update. */
  tick(quote: PaperQuote): void {
    if (quote.bid <= 0 || quote.ask <= 0 || quote.bid >= quote.ask) return;
    this.lastQuote = quote;

    for (const stop of [...this.s.restingStops]) {
      const triggered =
        stop.side === 'BUY' ? quote.ask >= stop.triggerPrice : quote.bid <= stop.triggerPrice;
      if (!triggered) continue;
      this.s.restingStops = this.s.restingStops.filter((x) => x.algoId !== stop.algoId);
      const qty = stop.closePosition ? Math.abs(this.s.positionQty) : stop.quantity ?? 0;
      if (qty > 0) {
        this.fill(stop.side, qty, this.marketFillPrice(stop.side, quote), this.takerFee, true, 'MARKET', `paper-stop-${stop.algoId}`);
      }
    }

    for (const order of [...this.s.restingOrders]) {
      const crossed =
        order.side === 'BUY' ? quote.ask <= order.price : quote.bid >= order.price;
      if (!crossed) continue;
      this.s.restingOrders = this.s.restingOrders.filter(
        (x) => x.clientOrderId !== order.clientOrderId
      );
      this.fill(order.side, order.quantity, order.price, this.makerFee, order.reduceOnly, 'LIMIT', order.clientOrderId);
    }
  }

  async submitOrder(params: NewOrderParams): Promise<OrderAck> {
    const quote = this.requireQuote();
    const clientOrderId = params.clientOrderId ?? `paper-${++this.s.seq}`;

    if (params.type === 'MARKET') {
      this.fill(
        params.side,
        params.quantity,
        this.marketFillPrice(params.side, quote),
        this.takerFee,
        params.reduceOnly ?? false,
        'MARKET',
        clientOrderId
      );
      return { orderId: this.s.seq, clientOrderId };
    }

    if (params.price === undefined) {
      throw new Error('[Paper] LIMIT order requires price');
    }

    const marketable =
      params.side === 'BUY' ? quote.ask <= params.price : quote.bid >= params.price;

    if (marketable) {
      if (params.timeInForce === 'GTX') {
        throw new Error('[Paper] Post-only order would immediately match (GTX rejected)');
      }
      this.fill(
        params.side,
        params.quantity,
        params.price,
        this.takerFee,
        params.reduceOnly ?? false,
        'LIMIT',
        clientOrderId
      );
      return { orderId: this.s.seq, clientOrderId };
    }

    this.s.restingOrders.push({
      clientOrderId,
      side: params.side,
      price: params.price,
      quantity: params.quantity,
      reduceOnly: params.reduceOnly ?? false,
    });
    return { orderId: this.s.seq, clientOrderId };
  }

  async submitStopMarket(params: StopMarketParams): Promise<StopAck> {
    const quote = this.requireQuote();
    const wouldTrigger =
      params.side === 'BUY'
        ? quote.ask >= params.triggerPrice
        : quote.bid <= params.triggerPrice;
    if (wouldTrigger) {
      throw new Error('[Paper] Stop would immediately trigger');
    }
    const algoId = ++this.s.seq;
    this.s.restingStops.push({
      algoId,
      side: params.side,
      triggerPrice: params.triggerPrice,
      closePosition: params.closePosition ?? false,
      quantity: params.quantity,
    });
    return { algoId };
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    const before = this.s.restingOrders.length;
    this.s.restingOrders = this.s.restingOrders.filter(
      (o) => o.clientOrderId !== clientOrderId
    );
    if (this.s.restingOrders.length === before) {
      throw new Error(`[Paper] Unknown order ${clientOrderId}`);
    }
  }

  async cancelAllStops(): Promise<void> {
    this.s.restingStops = [];
  }

  async getPosition(): Promise<PositionSnapshot> {
    const qty = this.s.positionQty;
    if (qty === 0) return { qty: 0, entry: 0, side: null };
    return { qty: Math.abs(qty), entry: this.s.entryPrice, side: qty > 0 ? 'LONG' : 'SHORT' };
  }

  async getBalance(): Promise<number> {
    return this.s.balance;
  }

  get feesPaid(): number {
    return this.s.feesPaid;
  }

  get realizedPnl(): number {
    return this.s.realizedPnl;
  }

  // ─── internals ───────────────────────────────────────────────────────────────

  private requireQuote(): PaperQuote {
    if (!this.lastQuote) {
      throw new Error('[Paper] No quote yet — feed tick() before submitting orders');
    }
    return this.lastQuote;
  }

  private marketFillPrice(side: 'BUY' | 'SELL', quote: PaperQuote): number {
    return side === 'BUY'
      ? quote.ask * (1 + this.slippagePct)
      : quote.bid * (1 - this.slippagePct);
  }

  private fill(
    side: 'BUY' | 'SELL',
    quantity: number,
    price: number,
    feeRate: number,
    reduceOnly: boolean,
    orderType: 'MARKET' | 'LIMIT',
    clientOrderId: string
  ): void {
    const signed = side === 'BUY' ? quantity : -quantity;
    const pos = this.s.positionQty;
    let qty = signed;

    // reduceOnly can never flip or open a position
    if (reduceOnly) {
      if (pos === 0 || Math.sign(pos) === Math.sign(signed)) {
        logger.warn(`[Paper] reduceOnly ${side} ${quantity} ignored (position ${pos})`);
        return;
      }
      qty = Math.sign(signed) * Math.min(Math.abs(signed), Math.abs(pos));
    }

    let realized = 0;
    const closingQty =
      pos !== 0 && Math.sign(pos) !== Math.sign(qty) ? Math.min(Math.abs(pos), Math.abs(qty)) : 0;

    if (closingQty > 0) {
      const dir = Math.sign(pos); // +1 long, -1 short
      realized = (price - this.s.entryPrice) * closingQty * dir;
      this.s.realizedPnl += realized;
      this.s.balance += realized;
    }

    const newPos = pos + qty;
    if (pos === 0 || Math.sign(pos) === Math.sign(qty)) {
      // opening or increasing: weighted average entry
      this.s.entryPrice =
        pos === 0
          ? price
          : (this.s.entryPrice * Math.abs(pos) + price * Math.abs(qty)) / Math.abs(newPos);
    } else if (newPos !== 0 && Math.sign(newPos) !== Math.sign(pos)) {
      // flipped: remainder opens at fill price
      this.s.entryPrice = price;
    } else if (newPos === 0) {
      this.s.entryPrice = 0;
    }
    this.s.positionQty = Number(newPos.toFixed(10));
    if (this.s.positionQty === 0) this.s.entryPrice = 0;

    const fee = Math.abs(qty) * price * feeRate;
    this.s.feesPaid += fee;
    this.s.balance -= fee;

    this.onEvent({
      order: {
        symbol: this.symbol,
        clientOrderId,
        side,
        orderStatus: 'FILLED',
        orderType,
        averagePrice: String(price),
        orderFilledAccumulatedQuantity: String(Math.abs(qty)),
        reduceOnly,
        realisedProfit: String(realized),
        paper: true,
      },
    });
  }
}
