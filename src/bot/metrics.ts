import { SYMBOL, LADDER_LEVELS } from './config';
import { orderBookCollector, PriceSource } from './orderbook';
import { QueryResult } from 'pg';
import { countFilledOnSide, countOpenOnSide } from './ladder/coverage';
import { activeEntrySide } from './ladder/spacing';
import { computeLadderExitPricesFromState } from './phases/exitPricingContext';
import { resolveCyclePhase, CyclePhase } from './phases/types';
import { BotPhase, BotState } from './state';
import { LadderState } from './types';

export interface TradeRow {
  realized_pnl: string | number | null;
  closed_at?: Date | string;
}

export interface TradeMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  expectancy: number | null;
  totalPnl: number;
  pnlToday: number;
  pnlWeek: number;
}

export interface CycleMetrics {
  cyclePhase: CyclePhase;
  botPhase: BotPhase;
  symbol: string;
  side: string | null;
  windingDown: boolean;
  ladder: {
    levelsFilled: number;
    levelsOpen: number;
    levelsTotal: number;
    fills: number;
    partialCloses: number;
    baseQty: number;
  } | null;
  position: {
    qty: number;
    entryPrice: number;
    currentPrice: number;
    priceSource: PriceSource;
    unrealizedPnl: number | null;
  } | null;
  exits: {
    slPrice: number;
    tpPrice: number;
    slDistancePct: number;
    tpDistancePct: number;
    tpTargetUsd: number;
    slTargetUsd: number;
    riskAmount: number;
  } | null;
  cyclePnl: number;
}

export function computeTradeMetrics(rows: TradeRow[], now = Date.now()): TradeMetrics {
  const pnls = rows
    .map((r) => Number(r.realized_pnl ?? 0))
    .filter((n) => Number.isFinite(n));

  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const totalTrades = pnls.length;

  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const avgWin = avg(wins);
  const avgLoss = avg(losses);
  const winRate = totalTrades > 0 ? wins.length / totalTrades : null;

  let expectancy: number | null = null;
  if (totalTrades > 0 && avgWin !== null && avgLoss !== null && winRate !== null) {
    expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  }

  const dayAgo = now - 86_400_000;
  const weekAgo = now - 7 * 86_400_000;
  const pnlToday = sumPnlSince(rows, dayAgo, now);
  const pnlWeek = sumPnlSince(rows, weekAgo, now);

  return {
    totalTrades,
    wins: wins.length,
    losses: losses.length,
    winRate: winRate !== null ? round4(winRate) : null,
    avgWin: avgWin !== null ? round4(avgWin) : null,
    avgLoss: avgLoss !== null ? round4(avgLoss) : null,
    expectancy: expectancy !== null ? round4(expectancy) : null,
    totalPnl: round4(pnls.reduce((a, b) => a + b, 0)),
    pnlToday: round4(pnlToday),
    pnlWeek: round4(pnlWeek),
  };
}

function sumPnlSince(rows: TradeRow[], sinceMs: number, nowMs: number): number {
  return rows.reduce((sum, row) => {
    const closedAt = row.closed_at ? new Date(row.closed_at).getTime() : 0;
    if (closedAt >= sinceMs && closedAt <= nowMs) {
      return sum + Number(row.realized_pnl ?? 0);
    }
    return sum;
  }, 0);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function pctDistance(from: number, to: number): number {
  if (from <= 0) return 0;
  return round4((Math.abs(to - from) / from) * 100);
}

export function buildCycleMetrics(
  state: BotState,
  ladder: LadderState | null,
  tickSize = 0.01
): CycleMetrics {
  const cyclePhase = resolveCyclePhase(state.phase, ladder);
  const currentPrice = orderBookCollector.currentPrice;
  const priceSource = orderBookCollector.currentPriceSource;

  let ladderMetrics: CycleMetrics['ladder'] = null;
  if (ladder) {
    const entrySide = ladder.side ? activeEntrySide(ladder.side) : null;
    const levelsFilled = entrySide ? countFilledOnSide(ladder, entrySide) : 0;
    const levelsOpen = entrySide ? countOpenOnSide(ladder, entrySide) : 0;
    ladderMetrics = {
      levelsFilled,
      levelsOpen,
      levelsTotal: LADDER_LEVELS,
      fills: ladder.fills,
      partialCloses: ladder.partialCloses,
      baseQty: ladder.baseQty,
    };
  }

  let position: CycleMetrics['position'] = null;
  let exits: CycleMetrics['exits'] = null;

  if (ladder?.side && ladder.posQty > 0 && ladder.entryPrice > 0) {
    const dir = ladder.side === 'LONG' ? 1 : -1;
    const mark = currentPrice > 0 ? currentPrice : ladder.entryPrice;
    const unrealized = (mark - ladder.entryPrice) * ladder.posQty * dir;

    position = {
      qty: ladder.posQty,
      entryPrice: ladder.entryPrice,
      currentPrice: mark,
      priceSource: currentPrice > 0 ? priceSource : 'none',
      unrealizedPnl: round4(unrealized),
    };

    const exitPrices = computeLadderExitPricesFromState(
      ladder,
      tickSize,
      orderBookCollector.currentPrice
    );

    exits = {
      slPrice: exitPrices.slPrice,
      tpPrice: exitPrices.tpPrice,
      slDistancePct: pctDistance(ladder.entryPrice, exitPrices.slPrice),
      tpDistancePct: pctDistance(ladder.entryPrice, exitPrices.tpPrice),
      tpTargetUsd: round4(exitPrices.tpTargetUsd),
      slTargetUsd: round4(exitPrices.slTargetUsd),
      riskAmount: round4(ladder.riskAmount),
    };
  }

  return {
    cyclePhase,
    botPhase: state.phase,
    symbol: SYMBOL,
    side: ladder?.side ?? state.active_side,
    windingDown: ladder?.windingDown ?? false,
    ladder: ladderMetrics,
    position,
    exits,
    cyclePnl: round4(state.current_pnl),
  };
}

export interface MetricsDb {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>;
}

export async function fetchAllTrades(db: MetricsDb): Promise<TradeRow[]> {
  const res = await db.query(
    'SELECT realized_pnl, closed_at FROM trades ORDER BY closed_at DESC'
  );
  return res.rows as TradeRow[];
}

export async function fetchRecentTrades(db: MetricsDb, limit = 5) {
  const res = await db.query(
    'SELECT * FROM trades ORDER BY closed_at DESC LIMIT $1',
    [limit]
  );
  return res.rows;
}
