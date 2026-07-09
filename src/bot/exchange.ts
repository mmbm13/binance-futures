import { client } from './client';
import { SYMBOL } from './config';
import { logger } from '../utils/logger';
import { EntryOrder, LadderState, PositionSnapshot, SymbolPrecision } from './types';

export type ExchangeOpenOrder = {
  clientOrderId?: string;
  reduceOnly?: boolean | string;
};

export function countExchangeEntryOrders(openOrders: ExchangeOpenOrder[]): number {
  return openOrders.filter((o) => o.reduceOnly !== true && o.reduceOnly !== 'true').length;
}

/** Mark local OPEN entries as CANCELED when they are gone from the exchange. */
export function reconcileEntryOrders(
  ladder: LadderState,
  openOrders: ExchangeOpenOrder[]
): number {
  for (const o of ladder.entryOrders) {
    if (o.status === 'OPEN' && !isOpenOnExchange(o, openOrders)) {
      o.status = 'CANCELED';
    }
  }
  return ladder.entryOrders.filter((o) => o.status === 'OPEN').length;
}

export async function fetchOpenOrders(): Promise<ExchangeOpenOrder[]> {
  try {
    return await client.getAllOpenOrders({ symbol: SYMBOL });
  } catch {
    return [];
  }
}

export async function syncLadderWithExchange(ladder: LadderState): Promise<{
  openOrders: ExchangeOpenOrder[];
  exchangeEntryCount: number;
  localOpenCount: number;
}> {
  const openOrders = await fetchOpenOrders();
  const localOpenCount = reconcileEntryOrders(ladder, openOrders);
  return {
    openOrders,
    exchangeEntryCount: countExchangeEntryOrders(openOrders),
    localOpenCount,
  };
}

/** Tick/step/min filters for a symbol (defaults if the filter is missing). */
export async function fetchSymbolPrecision(symbol: string): Promise<SymbolPrecision> {
  const precision: SymbolPrecision = {
    tickSize: 0.01,
    stepSize: 0.001,
    minQty: 0.001,
    minNotional: 5,
  };
  try {
    const info = await client.getExchangeInfo();
    const symbolInfo = info.symbols.find((s) => s.symbol === symbol);
    if (!symbolInfo) {
      logger.error(`[Exchange] Symbol ${symbol} not found in exchange info`);
      return precision;
    }
    const lot = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE') as
      | { stepSize: string; minQty: string }
      | undefined;
    if (lot) {
      precision.stepSize = parseFloat(lot.stepSize);
      precision.minQty = parseFloat(lot.minQty);
    }
    const price = symbolInfo.filters.find((f) => f.filterType === 'PRICE_FILTER') as
      | { tickSize: string }
      | undefined;
    if (price) precision.tickSize = parseFloat(price.tickSize);
    const notional = symbolInfo.filters.find((f) => f.filterType === 'MIN_NOTIONAL') as
      | { notional?: string; minNotional?: string }
      | undefined;
    if (notional) {
      precision.minNotional = parseFloat(notional.notional || notional.minNotional || '5');
    }
  } catch (e) {
    logger.error('[Exchange] Failed to fetch exchange info', { error: e });
  }
  return precision;
}

export async function getAccountBalance(): Promise<number> {
  const res = await client.getAccountInformationV3();
  const asset = res.assets.find((a: { asset: string }) => a.asset === 'USDT');
  return asset ? parseFloat(asset.walletBalance as string) : 0;
}

export async function getPosition(): Promise<PositionSnapshot> {
  const positions = await client.getPositionsV3({ symbol: SYMBOL });
  const p = positions.find((pos) => parseFloat(pos.positionAmt as string) !== 0);
  if (!p) return { qty: 0, entry: 0, side: null };
  const amt = parseFloat(p.positionAmt as string);
  return {
    qty: Math.abs(amt),
    entry: parseFloat(p.entryPrice as string) || 0,
    side: amt > 0 ? 'LONG' : 'SHORT',
  };
}

/** Keep ladder.side aligned with the exchange position (source of truth for exits). */
export function syncLadderSideFromPosition(
  ladder: LadderState,
  pos: PositionSnapshot,
  context: string
): 'LONG' | 'SHORT' | null {
  if (!pos.side) return ladder.side;

  if (!ladder.side) {
    ladder.side = pos.side;
    return pos.side;
  }

  if (ladder.side !== pos.side) {
    logger.warn(
      `[${context}] Position side mismatch: ladder=${ladder.side} exchange=${pos.side} — using exchange`
    );
    ladder.side = pos.side;
  }

  return ladder.side;
}

export async function cancelAllOrders(): Promise<void> {
  try {
    await client.cancelAllOpenOrders({ symbol: SYMBOL });
  } catch { /* no regular orders is fine */ }
  try {
    await client.cancelAllAlgoOpenOrders({ symbol: SYMBOL });
  } catch { /* no algo orders is fine */ }
}

export async function cancelByClientOrderId(clientOrderId: string): Promise<void> {
  await client.cancelOrder({ symbol: SYMBOL, origClientOrderId: clientOrderId });
}

export function isOpenOnExchange(entry: EntryOrder, openOrders: { clientOrderId?: string }[]): boolean {
  return openOrders.some((oo) => oo.clientOrderId === entry.clientOrderId);
}
