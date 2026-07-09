import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeApr,
  computeNotionalQty,
  needsRebalance,
  passesPreEntryFeeGate,
  resolveOpenLegAction,
  shouldOpen,
  shouldClose,
  countConsecutiveAbove,
} from '../../strategies/funding/rules';

describe('funding rules', () => {
  it('computeApr(0.0001) ≈ 0.1095', () => {
    assert.ok(Math.abs(computeApr(0.0001) - 0.1095) < 0.001);
  });

  it('shouldOpen requires N consecutive windows', () => {
    const rates = [0.00005, 0.00006, 0.00007];
    assert.equal(shouldOpen([rates[2]], 0.15, 2), false);
    assert.equal(shouldOpen(rates, 0.15, 2), false);
    const high = [0.0001, 0.00015, 0.00015, 0.00015];
    assert.equal(countConsecutiveAbove(high, 0.15), 3);
    assert.equal(shouldOpen(high, 0.15, 2), true);
  });

  it('shouldClose requires M windows below exit threshold', () => {
    const low = [0.0001, 0.00002, 0.00002, 0.00002];
    assert.equal(shouldClose(low, 0.05, 3), true);
    assert.equal(shouldClose([0.0001, 0.00002], 0.05, 3), false);
  });

  it('needsRebalance at 2.1% drift, not at 1.9%', () => {
    assert.equal(needsRebalance(1.021, 1, 0.02), true);
    assert.equal(needsRebalance(1.019, 1, 0.02), false);
  });

  it('passesPreEntryFeeGate rejects low APR vs fees', () => {
    assert.equal(passesPreEntryFeeGate(0.05, 7, 0.002), false);
    assert.equal(passesPreEntryFeeGate(0.25, 14, 0.002), true);
  });

  it('resolveOpenLegAction rolls back spot when perp fails', () => {
    assert.equal(resolveOpenLegAction({ spotQty: 1, perpQty: 0, perpFailed: true }), 'rollback_spot');
    assert.equal(resolveOpenLegAction({ spotQty: 1, perpQty: 1 }), 'complete');
    assert.equal(resolveOpenLegAction({ spotQty: 0, perpQty: 0 }), 'buy_spot');
  });

  it('computeNotionalQty floors to step', () => {
    const s = computeNotionalQty(1000, 0.5, 2000, 0.01, 0.01, 5);
    assert.equal(s.valid, true);
    assert.equal(s.qty, 0.25);
  });
});
