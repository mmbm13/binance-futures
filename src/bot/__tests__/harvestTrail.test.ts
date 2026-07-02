import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canTrailHarvest, evaluateHarvestTrail } from '../phases/harvestTrail';
import { makeLadder } from './helpers';

const TICK = 0.01;

describe('canTrailHarvest', () => {
  it('requires harvest state with an open position', () => {
    assert.equal(canTrailHarvest(null), false);
    assert.equal(canTrailHarvest(makeLadder({ windingDown: false, partialCloses: 0 })), false);
    assert.equal(canTrailHarvest(makeLadder({ windingDown: true, posQty: 0 })), false);
    assert.equal(
      canTrailHarvest(makeLadder({ windingDown: true, posQty: 0.014, entryPrice: 1696 })),
      true
    );
  });
});

describe('evaluateHarvestTrail', () => {
  it('ratchets the peak and requests SL placement when none exists', () => {
    const l = makeLadder({ windingDown: true, posQty: 0.014, entryPrice: 1696, slPrice: null });
    assert.equal(evaluateHarvestTrail(l, 1690, TICK), true);
    assert.equal(l.harvestPeakPrice, 1690);
  });

  it('does not re-place SL for improvements below the min step', () => {
    const l = makeLadder({
      windingDown: true,
      posQty: 0.014,
      entryPrice: 1696,
      harvestPeakPrice: 1690,
      slPrice: 1694.31, // breakeven SL already on exchange
    });
    // Small favorable move: trail still worse than breakeven floor → no change.
    assert.equal(evaluateHarvestTrail(l, 1689, TICK), false);
  });

  it('re-places SL when the trail improves past the min step (SHORT)', () => {
    const l = makeLadder({
      windingDown: true,
      posQty: 0.014,
      entryPrice: 1696,
      harvestPeakPrice: 1690,
      slPrice: 1694.31,
    });
    assert.equal(evaluateHarvestTrail(l, 1650, TICK), true);
    assert.equal(l.harvestPeakPrice, 1650);
  });

  it('never loosens the peak on adverse moves', () => {
    const l = makeLadder({
      windingDown: true,
      posQty: 0.014,
      entryPrice: 1696,
      harvestPeakPrice: 1650,
      slPrice: 1662.94,
    });
    assert.equal(evaluateHarvestTrail(l, 1660, TICK), false);
    assert.equal(l.harvestPeakPrice, 1650);
  });

  it('skips placement when the desired SL would trigger immediately', () => {
    const l = makeLadder({
      windingDown: true,
      posQty: 0.014,
      entryPrice: 1696,
      harvestPeakPrice: 1690,
      slPrice: null,
    });
    // Price back at breakeven zone: placing SL at 1694.3 would fire instantly.
    assert.equal(evaluateHarvestTrail(l, 1695, TICK), false);
  });

  it('upgrades a catastrophic backstop to a proper trailing SL', () => {
    const l = makeLadder({
      windingDown: true,
      posQty: 0.014,
      entryPrice: 1696,
      harvestPeakPrice: 1690,
      slPrice: 1810,
      slIsCatastrophic: true,
    });
    assert.equal(evaluateHarvestTrail(l, 1688, TICK), true);
  });
});
