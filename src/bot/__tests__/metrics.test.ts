import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeTradeMetrics, buildCycleMetrics } from '../metrics';
import { BotState } from '../state';
import { makeLadder } from './helpers';

describe('computeTradeMetrics', () => {
  it('computes win rate and expectancy', () => {
    const metrics = computeTradeMetrics([
      { realized_pnl: 1.2, closed_at: '2026-06-10T10:00:00Z' },
      { realized_pnl: 0.3, closed_at: '2026-06-10T11:00:00Z' },
      { realized_pnl: -0.8, closed_at: '2026-06-10T12:00:00Z' },
    ]);

    assert.equal(metrics.totalTrades, 3);
    assert.equal(metrics.wins, 2);
    assert.equal(metrics.losses, 1);
    assert.equal(metrics.winRate, 0.6667);
    assert.equal(metrics.avgWin, 0.75);
    assert.equal(metrics.avgLoss, -0.8);
    assert.equal(metrics.totalPnl, 0.7);
    assert.ok(metrics.expectancy! > 0);
  });

  it('returns null rates when no trades', () => {
    const metrics = computeTradeMetrics([]);
    assert.equal(metrics.totalTrades, 0);
    assert.equal(metrics.winRate, null);
    assert.equal(metrics.expectancy, null);
  });

  it('sums pnl for today and week windows', () => {
    const now = new Date('2026-06-10T15:00:00Z').getTime();
    const metrics = computeTradeMetrics(
      [
        { realized_pnl: 2, closed_at: '2026-06-10T10:00:00Z' },
        { realized_pnl: -1, closed_at: '2026-06-09T10:00:00Z' },
        { realized_pnl: 5, closed_at: '2026-06-01T10:00:00Z' },
      ],
      now
    );
    assert.equal(metrics.pnlToday, 2);
    assert.equal(metrics.pnlWeek, 1);
    assert.equal(metrics.totalPnl, 6);
  });
});

describe('buildCycleMetrics', () => {
  const baseState: BotState = {
    status: 'RUNNING',
    phase: 'BUILDING',
    cycle_id: 'test-cycle',
    orders: {},
    current_pnl: 0.45,
    entry_price: 1696,
    active_side: 'SHORT',
  };

  it('describes BUILDING phase with ladder and exits', () => {
    const ladder = makeLadder({
      side: 'SHORT',
      posQty: 0.035,
      entryPrice: 1696,
      riskAmount: 0.8,
      entryOrders: [
        { clientOrderId: 'a', side: 'SELL', price: 1690, qty: 0.014, status: 'FILLED' },
        { clientOrderId: 'b', side: 'SELL', price: 1700, qty: 0.021, status: 'FILLED' },
        { clientOrderId: 'c', side: 'SELL', price: 1720, qty: 0.031, status: 'OPEN' },
      ],
    });

    const metrics = buildCycleMetrics(baseState, ladder);
    assert.equal(metrics.cyclePhase, 'BUILDING');
    assert.equal(metrics.windingDown, false);
    assert.equal(metrics.ladder?.levelsFilled, 2);
    assert.equal(metrics.ladder?.levelsOpen, 1);
    assert.equal(metrics.cyclePnl, 0.45);
    assert.ok(metrics.exits!.slPrice > metrics.exits!.tpPrice);
    assert.ok(metrics.exits!.tpTargetUsd > 0);
    assert.ok(metrics.exits!.slTargetUsd > 0);
  });

  it('detects HARVESTING from windingDown', () => {
    const ladder = makeLadder({ windingDown: true, posQty: 0.014, entryPrice: 1696 });
    const metrics = buildCycleMetrics({ ...baseState, phase: 'HARVESTING' }, ladder);
    assert.equal(metrics.cyclePhase, 'HARVESTING');
    assert.equal(metrics.windingDown, true);
    // Breakeven/trailing SL locks in near entry: SL target much smaller than TP target.
    assert.ok(metrics.exits!.slTargetUsd < metrics.exits!.tpTargetUsd);
    assert.ok(metrics.exits!.slPrice < 1696);
    assert.ok(metrics.exits!.slPrice > 1696 * 0.997);
  });
});
