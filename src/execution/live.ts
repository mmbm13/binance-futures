import { client } from '../bot/client';
import { getAccountBalance, getPosition } from '../bot/exchange';
import { PositionSnapshot } from '../bot/types';
import {
  Executor,
  NewOrderParams,
  OrderAck,
  StopAck,
  StopMarketParams,
} from './types';

/** Thin adapter over the real USDM client (same calls the ladder engine makes). */
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;

  constructor(private readonly symbol: string) {}

  async submitOrder(params: NewOrderParams): Promise<OrderAck> {
    const res = await client.submitNewOrder({
      symbol: this.symbol,
      side: params.side,
      type: params.type,
      quantity: params.quantity,
      ...(params.type === 'LIMIT'
        ? { price: params.price, timeInForce: params.timeInForce ?? 'GTC' }
        : {}),
      ...(params.reduceOnly ? { reduceOnly: 'true' } : {}),
      ...(params.clientOrderId ? { newClientOrderId: params.clientOrderId } : {}),
    } as Parameters<typeof client.submitNewOrder>[0]);
    return { orderId: res.orderId, clientOrderId: res.clientOrderId };
  }

  async submitStopMarket(params: StopMarketParams): Promise<StopAck> {
    const res = await client.submitNewAlgoOrder({
      algoType: 'CONDITIONAL',
      symbol: this.symbol,
      side: params.side,
      type: 'STOP_MARKET',
      triggerPrice: params.triggerPrice,
      ...(params.closePosition
        ? { closePosition: 'true' }
        : { quantity: params.quantity }),
    } as Parameters<typeof client.submitNewAlgoOrder>[0]);
    return { algoId: Number(res.algoId) };
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    await client.cancelOrder({ symbol: this.symbol, origClientOrderId: clientOrderId });
  }

  async cancelAllStops(): Promise<void> {
    try {
      await client.cancelAllAlgoOpenOrders({ symbol: this.symbol });
    } catch { /* none open is fine */ }
  }

  async getPosition(): Promise<PositionSnapshot> {
    return getPosition();
  }

  async getBalance(): Promise<number> {
    return getAccountBalance();
  }
}
