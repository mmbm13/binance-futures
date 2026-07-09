import { botEngine, SYMBOL } from '../bot/engine';
import { client } from '../bot/client';
import { stateManager } from '../bot/state';
import { buildCycleMetrics } from '../bot/metrics';
import { logger } from '../utils/logger';
import { Strategy } from './types';

/**
 * The original order-book ladder bot wrapped in the common Strategy interface.
 * All logic stays in src/bot/engine.ts; this class only adapts the surface.
 */
export class LadderStrategy implements Strategy {
  readonly id = 'ladder' as const;

  async init(): Promise<void> {
    await botEngine.init();
  }

  async start(): Promise<void> {
    if (!botEngine.initialized) {
      await botEngine.init();
    } else {
      await botEngine.syncStateWithBinance();
    }
  }

  async stop(): Promise<void> {
    await botEngine.stop();
    try {
      await client.cancelAllOpenOrders({ symbol: SYMBOL });
    } catch { /* no regular orders is fine */ }
    try {
      await client.cancelAllAlgoOpenOrders({ symbol: SYMBOL });
    } catch { /* no algo orders is fine */ }
    logger.info('[Ladder] Stopped and canceled all open orders (regular + algo).');
  }

  async sync(): Promise<void> {
    await botEngine.syncStateWithBinance();
  }

  async onOrderUpdate(data: { order: Record<string, unknown> }): Promise<unknown> {
    return botEngine.handleOrderUpdate(data);
  }

  async onAlgoUpdate(data: { algoOrder: Record<string, unknown> }): Promise<unknown> {
    return botEngine.handleAlgoUpdate(data);
  }

  async getMetrics(): Promise<Record<string, unknown>> {
    const state = await stateManager.getState();
    return buildCycleMetrics(state, botEngine.ladder, botEngine.tickSize) as unknown as Record<
      string,
      unknown
    >;
  }
}
