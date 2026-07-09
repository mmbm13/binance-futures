import { PositionSnapshot } from '../bot/types';

export interface NewOrderParams {
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: number;
  price?: number;
  /** 'GTC' rests; 'GTX' (post-only) is rejected if immediately marketable. */
  timeInForce?: 'GTC' | 'GTX' | 'IOC';
  reduceOnly?: boolean;
  clientOrderId?: string;
}

export interface StopMarketParams {
  side: 'BUY' | 'SELL';
  triggerPrice: number;
  /** Close the whole position on trigger (qty ignored). */
  closePosition?: boolean;
  quantity?: number;
}

export interface OrderAck {
  orderId: string | number;
  clientOrderId: string;
}

export interface StopAck {
  algoId: number;
}

/**
 * Synthetic user-data event, shaped like the fields strategies read from
 * ORDER_TRADE_UPDATE so paper and live handlers share code.
 */
export interface FillEvent {
  order: {
    symbol: string;
    clientOrderId: string;
    side: 'BUY' | 'SELL';
    orderStatus: 'FILLED' | 'CANCELED' | 'EXPIRED';
    orderType: 'MARKET' | 'LIMIT';
    averagePrice: string;
    orderFilledAccumulatedQuantity: string;
    reduceOnly: boolean;
    realisedProfit: string;
    /** Marks the event as simulated. */
    paper: true;
  };
}

export interface Executor {
  readonly mode: 'live' | 'paper';
  submitOrder(params: NewOrderParams): Promise<OrderAck>;
  submitStopMarket(params: StopMarketParams): Promise<StopAck>;
  cancelOrder(clientOrderId: string): Promise<void>;
  cancelAllStops(): Promise<void>;
  getPosition(): Promise<PositionSnapshot>;
  getBalance(): Promise<number>;
}
