import { QueryResult } from 'pg';

export interface StrategyTradeRow {
  strategy: string;
  realized_pnl: string | number | null;
  fees: string | number | null;
  funding: string | number | null;
  opened_at?: Date | string | null;
  closed_at?: Date | string | null;
}

export interface EquityRow {
  strategy: string;
  balance: string | number;
  unrealized: string | number | null;
  taken_at: Date | string;
}

export interface StrategyStats {
  strategy: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  totalPnl: number;
  feesTotal: number;
  fundingTotal: number;
  avgHoldHours: number | null;
  tradesPerWeek: number | null;
  maxDrawdownPct: number | null;
  sharpeDaily: number | null;
}

const num = (v: string | number | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Max peak-to-trough drawdown as a fraction of the peak (0.12 = −12%). */
export function computeMaxDrawdown(equity: number[]): number | null {
  if (equity.length < 2) return null;
  let peak = equity[0];
  let maxDd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak);
  }
  return round4(maxDd);
}

/** Annualized Sharpe from daily equity closes (last snapshot per calendar day). */
export function computeSharpeDaily(
  snapshots: { equity: number; takenAt: number }[]
): number | null {
  const byDay = new Map<string, number>();
  for (const s of [...snapshots].sort((a, b) => a.takenAt - b.takenAt)) {
    byDay.set(new Date(s.takenAt).toISOString().slice(0, 10), s.equity);
  }
  const closes = [...byDay.values()];
  if (closes.length < 3) return null;

  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push(closes[i] / closes[i - 1] - 1);
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  return round4((mean / std) * Math.sqrt(365));
}

export function computeStrategyStats(
  strategy: string,
  trades: StrategyTradeRow[],
  equityRows: EquityRow[]
): StrategyStats {
  const pnls = trades.map((t) => num(t.realized_pnl));
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const totalTrades = pnls.length;

  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const winRate = totalTrades > 0 ? wins.length / totalTrades : null;
  const expectancy = totalTrades > 0 ? pnls.reduce((a, b) => a + b, 0) / totalTrades : null;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : totalTrades > 0 ? null : null;

  let holdSumMs = 0;
  let holdCount = 0;
  let firstClose = Infinity;
  let lastClose = -Infinity;
  for (const t of trades) {
    const closed = t.closed_at ? new Date(t.closed_at).getTime() : NaN;
    if (Number.isFinite(closed)) {
      firstClose = Math.min(firstClose, closed);
      lastClose = Math.max(lastClose, closed);
      const opened = t.opened_at ? new Date(t.opened_at).getTime() : NaN;
      if (Number.isFinite(opened) && closed >= opened) {
        holdSumMs += closed - opened;
        holdCount++;
      }
    }
  }
  const avgHoldHours = holdCount > 0 ? round4(holdSumMs / holdCount / 3_600_000) : null;
  const spanWeeks =
    Number.isFinite(firstClose) && lastClose > firstClose
      ? (lastClose - firstClose) / (7 * 86_400_000)
      : null;
  const tradesPerWeek =
    spanWeeks && spanWeeks > 0 ? round4(totalTrades / spanWeeks) : null;

  const equitySeries = equityRows
    .map((r) => ({
      equity: num(r.balance) + num(r.unrealized),
      takenAt: new Date(r.taken_at).getTime(),
    }))
    .filter((r) => Number.isFinite(r.takenAt))
    .sort((a, b) => a.takenAt - b.takenAt);

  return {
    strategy,
    totalTrades,
    wins: wins.length,
    losses: losses.length,
    winRate: winRate !== null ? round4(winRate) : null,
    expectancy: expectancy !== null ? round4(expectancy) : null,
    profitFactor: profitFactor !== null ? round4(profitFactor) : null,
    totalPnl: round4(pnls.reduce((a, b) => a + b, 0)),
    feesTotal: round4(trades.reduce((s, t) => s + num(t.fees), 0)),
    fundingTotal: round4(trades.reduce((s, t) => s + num(t.funding), 0)),
    avgHoldHours,
    tradesPerWeek,
    maxDrawdownPct: computeMaxDrawdown(equitySeries.map((e) => e.equity)),
    sharpeDaily: computeSharpeDaily(equitySeries),
  };
}

export interface CompareDb {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>;
}

/** Per-strategy comparison table for GET /compare. */
export async function buildComparison(db: CompareDb): Promise<StrategyStats[]> {
  const tradesRes = await db.query(
    `SELECT strategy, realized_pnl, fees, funding, opened_at, closed_at
     FROM trades ORDER BY closed_at ASC`
  );
  const equityRes = await db.query(
    `SELECT strategy, balance, unrealized, taken_at
     FROM equity_snapshots ORDER BY taken_at ASC`
  );

  const trades = tradesRes.rows as StrategyTradeRow[];
  const equity = equityRes.rows as EquityRow[];

  const ids = new Set<string>([
    ...trades.map((t) => t.strategy || 'ladder'),
    ...equity.map((e) => e.strategy),
  ]);

  return [...ids]
    .sort()
    .map((id) =>
      computeStrategyStats(
        id,
        trades.filter((t) => (t.strategy || 'ladder') === id),
        equity.filter((e) => e.strategy === id)
      )
    );
}
