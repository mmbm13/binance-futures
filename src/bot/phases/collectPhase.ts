import { randomUUID } from 'crypto';
import { COLLECT_MINUTES, SYMBOL } from '../config';
import { cancelAllOrders } from '../exchange';
import { orderBookCollector } from '../orderbook';
import { stateManager } from '../state';
import { logger } from '../../utils/logger';

export interface CollectPhaseCallbacks {
  onCollectComplete: () => Promise<void>;
  onPriceTick: (price: number) => void;
}

export async function enterCollectPhase(
  callbacks: CollectPhaseCallbacks,
  timerHolder: { _collectTimer: NodeJS.Timeout | null }
): Promise<void> {
  const state = await stateManager.getState();
  if (state.status !== 'RUNNING') {
    logger.info('Bot not RUNNING, not starting cycle.');
    return;
  }
  if (state.phase === 'COLLECTING' && timerHolder._collectTimer) {
    logger.warn('Cycle already collecting, skipping duplicate start.');
    return;
  }

  await cancelAllOrders();

  const cycleId = randomUUID();
  await stateManager.updatePhase('COLLECTING', cycleId, {});
  logger.info(`[Collect] Cycle ${cycleId}: collecting order book for ${COLLECT_MINUTES} min...`);

  orderBookCollector.onPrice = callbacks.onPriceTick;
  await orderBookCollector.startDepthCollection(SYMBOL);

  if (timerHolder._collectTimer) clearTimeout(timerHolder._collectTimer);
  timerHolder._collectTimer = setTimeout(() => {
    timerHolder._collectTimer = null;
    callbacks.onCollectComplete().catch((e) =>
      logger.error('[Collect] Error after collection window', { error: e })
    );
  }, COLLECT_MINUTES * 60_000);
}

export function stopCollectTimer(timerHolder: { _collectTimer: NodeJS.Timeout | null }): void {
  if (timerHolder._collectTimer) {
    clearTimeout(timerHolder._collectTimer);
    timerHolder._collectTimer = null;
  }
}
