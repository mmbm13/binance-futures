import { db } from '../../db';
import { logger } from '../../utils/logger';

/**
 * Record every evaluated setup — executed or not — so thresholds can be
 * calibrated later. Never throws (a failed insert must not break trading).
 */
export async function recordSignal(
  strategy: string,
  symbol: string,
  kind: string,
  payload: Record<string, unknown>,
  acted: boolean
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO signals (strategy, symbol, kind, payload, acted)
       VALUES ($1, $2, $3, $4, $5)`,
      [strategy, symbol, kind, JSON.stringify(payload), acted]
    );
  } catch (e) {
    logger.error('[Signals] Failed to record signal', { strategy, kind, error: e });
  }
}
