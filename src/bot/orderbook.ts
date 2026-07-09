import { WebsocketClient } from 'binance';
import { client } from './client';
import { logger } from '../utils/logger';
import * as dotenv from 'dotenv';

dotenv.config();

const USE_TESTNET = process.env.USE_TESTNET === 'true';
/** If bookTicker is silent this long, fall back to markPrice. */
const BOOK_TICKER_STALE_MS = Number(process.env.BOOK_TICKER_STALE_MS || 10_000);

export type PriceSource = 'bookTicker' | 'markPrice' | 'none';

/** Mid price from best bid/ask; null if quotes are invalid. */
export function computeBookMidPrice(bid: number, ask: number): number | null {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (bid <= 0 || ask <= 0 || bid >= ask) return null;
  return (bid + ask) / 2;
}

export function shouldUseMarkPriceFallback(lastBookTickerAt: number, now = Date.now()): boolean {
  if (lastBookTickerAt <= 0) return true;
  return now - lastBookTickerAt > BOOK_TICKER_STALE_MS;
}

export interface Wall {
  price: number;
  volume: number;
}

export interface WallSnapshot {
  currentPrice: number;
  /** Bid walls below current price, sorted by volume desc */
  buyWalls: Wall[];
  /** Ask walls above current price, sorted by volume desc */
  sellWalls: Wall[];
}

interface DepthEvent {
  e: string;
  s: string;
  U: number; // first update id in event
  u: number; // last update id in event
  pu: number; // last update id of previous event
  b: [string, string][];
  a: [string, string][];
}

/**
 * Maintains a local futures order book from the diff depth stream,
 * synchronized with a REST snapshot (Binance recommended algorithm).
 * Price ticks: bookTicker mid (primary), markPrice (fallback if bookTicker stale).
 */
class OrderBookCollector {
  private depthWs: WebsocketClient | null = null;
  private priceWs: WebsocketClient | null = null;
  private bids = new Map<string, number>();
  private asks = new Map<string, number>();
  private buffer: DepthEvent[] = [];
  private synced = false;
  private syncing = false;
  private lastU = 0;
  private symbol = '';
  private lastBookTickerAt = 0;

  currentPrice = 0;
  currentPriceSource: PriceSource = 'none';
  /** Best bid/ask from bookTicker (0 until the first event arrives). */
  currentBid = 0;
  currentAsk = 0;
  onPrice: ((price: number) => void) | null = null;

  private publishPrice(price: number, source: Exclude<PriceSource, 'none'>) {
    if (price <= 0) return;
    this.currentPrice = price;
    this.currentPriceSource = source;
    if (this.onPrice) this.onPrice(price);
  }

  /** bookTicker mid (primary) + markPrice (fallback). */
  startPriceStream(symbol: string) {
    this.symbol = symbol;
    if (this.priceWs) return;

    this.priceWs = new WebsocketClient({ beautify: false, demoTrading: USE_TESTNET });
    this.priceWs.on('message', (msg: unknown) => {
      const ev = ((msg as { data?: Record<string, unknown> })?.data ?? msg) as Record<string, unknown>;

      if (ev?.e === 'bookTicker' && ev.s === this.symbol) {
        const bid = Number(ev.b);
        const ask = Number(ev.a);
        const mid = computeBookMidPrice(bid, ask);
        if (mid !== null) {
          this.currentBid = bid;
          this.currentAsk = ask;
          this.lastBookTickerAt = Date.now();
          this.publishPrice(mid, 'bookTicker');
        }
        return;
      }

      if (ev?.e === 'markPriceUpdate' && ev.s === this.symbol) {
        if (shouldUseMarkPriceFallback(this.lastBookTickerAt)) {
          this.publishPrice(Number(ev.p), 'markPrice');
        }
      }
    });
    this.priceWs.on('exception', (d: unknown) => logger.error('[OB] Price WS exception', { data: d }));
    void this.priceWs.subscribeSymbolBookTicker(symbol, 'usdm');
    this.priceWs.subscribeMarkPrice(symbol, 'usdm', 1000);
    logger.info(`[OB] Price streams started for ${symbol} (primary: bookTicker, fallback: markPrice)`);
  }

  /** Start collecting depth updates for the symbol. */
  async startDepthCollection(symbol: string) {
    this.symbol = symbol;
    this.stopDepth();
    this.bids.clear();
    this.asks.clear();
    this.buffer = [];
    this.synced = false;
    this.syncing = false;
    this.lastU = 0;

    this.startPriceStream(symbol);

    this.depthWs = new WebsocketClient({ beautify: false, demoTrading: USE_TESTNET });
    this.depthWs.on('message', (msg: any) => {
      const ev = msg?.data ?? msg;
      if (ev?.e === 'depthUpdate' && ev.s === this.symbol) {
        this.handleDepthEvent(ev as DepthEvent);
      }
    });
    this.depthWs.on('exception', (d: any) => logger.error('[OB] Depth WS exception', { data: d }));
    this.depthWs.subscribeDiffBookDepth(symbol, 100, 'usdm');
    logger.info(`[OB] Depth collection started for ${symbol}`);
  }

  private handleDepthEvent(ev: DepthEvent) {
    if (!this.synced) {
      this.buffer.push(ev);
      void this.trySync();
      return;
    }
    if (this.lastU !== 0 && ev.pu !== this.lastU) {
      logger.warn('[OB] Depth stream out of sync, re-synchronizing...');
      this.synced = false;
      this.buffer = [ev];
      void this.trySync();
      return;
    }
    this.applyEvent(ev);
  }

  private async trySync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const snapshot = await client.getOrderBook({ symbol: this.symbol, limit: 1000 });
      this.bids.clear();
      this.asks.clear();
      for (const [p, q] of snapshot.bids) this.bids.set(String(p), Number(q));
      for (const [p, q] of snapshot.asks) this.asks.set(String(p), Number(q));

      const lastUpdateId = snapshot.lastUpdateId;
      const events = this.buffer.filter((e) => e.u >= lastUpdateId);
      this.lastU = 0;
      for (const ev of events) this.applyEvent(ev);

      this.buffer = [];
      this.synced = true;
      logger.info(`[OB] Book synced (lastUpdateId: ${lastUpdateId}, bids: ${this.bids.size}, asks: ${this.asks.size})`);
    } catch (e) {
      logger.error('[OB] Failed to sync order book snapshot', { error: e });
    } finally {
      this.syncing = false;
    }
  }

  private applyEvent(ev: DepthEvent) {
    for (const [price, qty] of ev.b) {
      const q = Number(qty);
      if (q === 0) this.bids.delete(price);
      else this.bids.set(price, q);
    }
    for (const [price, qty] of ev.a) {
      const q = Number(qty);
      if (q === 0) this.asks.delete(price);
      else this.asks.set(price, q);
    }
    this.lastU = ev.u;
  }

  /**
   * Aggregate the current book into price buckets and return the biggest
   * liquidity walls on each side of the current price.
   */
  getWalls(bucketSize: number, topN: number): WallSnapshot {
    const price = this.currentPrice;
    const bidAgg = new Map<number, number>();
    const askAgg = new Map<number, number>();

    for (const [p, q] of this.bids) {
      const pn = Number(p);
      if (pn >= price) continue;
      const bucket = Math.floor(pn / bucketSize) * bucketSize;
      bidAgg.set(bucket, (bidAgg.get(bucket) || 0) + q);
    }
    for (const [p, q] of this.asks) {
      const pn = Number(p);
      if (pn <= price) continue;
      const bucket = Math.ceil(pn / bucketSize) * bucketSize;
      askAgg.set(bucket, (askAgg.get(bucket) || 0) + q);
    }

    const toWalls = (m: Map<number, number>): Wall[] =>
      [...m.entries()]
        .map(([p, volume]) => ({ price: p, volume }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, topN);

    return {
      currentPrice: price,
      buyWalls: toWalls(bidAgg),
      sellWalls: toWalls(askAgg),
    };
  }

  get isSynced() {
    return this.synced;
  }

  get isDepthActive() {
    return this.depthWs !== null;
  }

  /** Start depth stream if not already running (preserves live book when active). */
  async ensureDepthCollection(symbol: string) {
    if (this.depthWs) {
      this.startPriceStream(symbol);
      return;
    }
    await this.startDepthCollection(symbol);
  }

  /** Stop the depth stream (price stream stays alive). */
  stopDepth() {
    if (this.depthWs) {
      try {
        this.depthWs.closeAll();
      } catch (e) {
        logger.error('[OB] Error closing depth WS', { error: e });
      }
      this.depthWs = null;
    }
  }

  /** Stop everything (depth + price streams). */
  stopAll() {
    this.stopDepth();
    if (this.priceWs) {
      try {
        this.priceWs.closeAll();
      } catch (e) {
        logger.error('[OB] Error closing price WS', { error: e });
      }
      this.priceWs = null;
    }
    this.currentPrice = 0;
    this.currentPriceSource = 'none';
    this.currentBid = 0;
    this.currentAsk = 0;
    this.lastBookTickerAt = 0;
  }
}

export const orderBookCollector = new OrderBookCollector();
