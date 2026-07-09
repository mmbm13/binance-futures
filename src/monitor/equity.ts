import { db } from '../db';
import { getAccountBalance, getPosition } from '../bot/exchange';
import { orderBookCollector } from '../bot/orderbook';
import { EXECUTION_MODE, getActiveStrategy } from '../strategies/registry';
import { logger } from '../utils/logger';

const SNAPSHOT_INTERVAL_MS = Number(process.env.EQUITY_SNAPSHOT_MINUTES || 60) * 60_000;

let timer: NodeJS.Timeout | null = null;

interface MetricsPosition {
  side?: string;
  qty?: number;
  entry?: number;
}

function unrealizedFromPosition(pos: MetricsPosition | null | undefined, mark: number): number {
  if (!pos?.side || !pos.qty || !pos.entry || mark <= 0) return 0;
  const dir = pos.side === 'LONG' ? 1 : pos.side === 'SHORT' ? -1 : 0;
  if (dir === 0) return 0;
  return (mark - pos.entry) * pos.qty * dir;
}

export async function takeEquitySnapshot(strategy: string): Promise<void> {
  try {
    let balance: number;
    let unrealized = 0;
    const mark = orderBookCollector.currentPrice;

    if (EXECUTION_MODE === 'paper') {
      const metrics = await getActiveStrategy().getMetrics();
      balance = Number(metrics.balance ?? 0);
      unrealized = unrealizedFromPosition(metrics.position as MetricsPosition, mark);
    } else {
      balance = await getAccountBalance();
      const pos = await getPosition();
      unrealized = unrealizedFromPosition(
        pos.qty > 0 ? { side: pos.side ?? undefined, qty: pos.qty, entry: pos.entry } : null,
        mark
      );
    }

    await db.query(
      `INSERT INTO equity_snapshots (strategy, balance, unrealized) VALUES ($1, $2, $3)`,
      [strategy, balance, unrealized]
    );
  } catch (e) {
    logger.error('[Equity] Snapshot failed', { error: e });
  }
}

export function startEquitySnapshots(strategy: string): void {
  if (timer) return;
  timer = setInterval(() => void takeEquitySnapshot(strategy), SNAPSHOT_INTERVAL_MS);
  // First snapshot shortly after boot so the curve starts at day one.
  setTimeout(() => void takeEquitySnapshot(strategy), 15_000);
  logger.info(
    `[Equity] Snapshots every ${SNAPSHOT_INTERVAL_MS / 60000} min (strategy: ${strategy}, mode: ${EXECUTION_MODE})`
  );
}

export function stopEquitySnapshots(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
