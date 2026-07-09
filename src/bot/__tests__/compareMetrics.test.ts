import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMaxDrawdown,
  computeSharpeDaily,
  computeStrategyStats,
} from '../compareMetrics';

describe('computeMaxDrawdown', () => {
  it('finds the deepest peak-to-trough drop', () => {
    const dd = computeMaxDrawdown([100, 120, 90, 110, 80]);
    assert.ok(Math.abs(dd! - (120 - 80) / 120) < 1e-4); // rounded to 4 decimals
  });

  it('returns 0 for a monotonic rise and null for short series', () => {
    assert.equal(computeMaxDrawdown([100, 110, 120]), 0);
    assert.equal(computeMaxDrawdown([100]), null);
  });
});

describe('computeSharpeDaily', () => {
  it('computes annualized sharpe from daily closes', () => {
    const day = 86_400_000;
    const t0 = new Date('2026-06-01T12:00:00Z').getTime();
    const snapshots = [100, 101, 102, 103, 104].map((equity, i) => ({
      equity,
      takenAt: t0 + i * day,
    }));
    const sharpe = computeSharpeDaily(snapshots);
    assert.ok(sharpe !== null && sharpe > 0);
  });

  it('uses only the last snapshot of each day', () => {
    const t0 = new Date('2026-06-01T00:00:00Z').getTime();
    const snapshots = [
      { equity: 100, takenAt: t0 + 1 * 3_600_000 },
      { equity: 500, takenAt: t0 + 2 * 3_600_000 }, // intraday spike ignored
      { equity: 100, takenAt: t0 + 23 * 3_600_000 },
    ];
    assert.equal(computeSharpeDaily(snapshots), null); // 1 day = no returns
  });
});

describe('computeStrategyStats', () => {
  const trades = [
    { strategy: 'momentum', realized_pnl: 3, fees: 0.5, funding: 0, opened_at: '2026-06-01T00:00:00Z', closed_at: '2026-06-01T06:00:00Z' },
    { strategy: 'momentum', realized_pnl: -1, fees: 0.4, funding: 0, opened_at: '2026-06-03T00:00:00Z', closed_at: '2026-06-03T02:00:00Z' },
    { strategy: 'momentum', realized_pnl: -1, fees: 0.4, funding: 0.2, opened_at: '2026-06-08T00:00:00Z', closed_at: '2026-06-08T04:00:00Z' },
  ];

  it('computes trade stats, fees and hold time', () => {
    const stats = computeStrategyStats('momentum', trades, []);
    assert.equal(stats.totalTrades, 3);
    assert.equal(stats.wins, 1);
    assert.equal(stats.losses, 2);
    assert.ok(Math.abs(stats.profitFactor! - 1.5) < 1e-9); // 3 / 2
    assert.ok(Math.abs(stats.expectancy! - 1 / 3) < 1e-4);
    assert.ok(Math.abs(stats.feesTotal - 1.3) < 1e-9);
    assert.ok(Math.abs(stats.fundingTotal - 0.2) < 1e-9);
    assert.equal(stats.avgHoldHours, 4); // (6+2+4)/3
    assert.ok(stats.tradesPerWeek! > 0);
  });

  it('handles empty inputs', () => {
    const stats = computeStrategyStats('funding', [], []);
    assert.equal(stats.totalTrades, 0);
    assert.equal(stats.winRate, null);
    assert.equal(stats.maxDrawdownPct, null);
    assert.equal(stats.sharpeDaily, null);
  });
});
