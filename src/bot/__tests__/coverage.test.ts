import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLadderCoverage,
  computeSlotsRemaining,
  shouldTopUpLadder,
  isLadderFullyPlaced,
  isLadderFullyFilled,
} from '../ladder/coverage';
import { makeLadder } from './helpers';

describe('getLadderCoverage', () => {
  it('sums filled and open when position is large', () => {
    const l = makeLadder({ posQty: 0.05, ladderStep: 1 });
    assert.equal(getLadderCoverage(l, 2, 1), 3);
  });

  it('ignores stale fills after partial close at baseQty', () => {
    const l = makeLadder({
      posQty: 0.014,
      baseQty: 0.014,
      ladderStep: 1,
    });
    assert.equal(getLadderCoverage(l, 3, 0), 1);
    assert.equal(getLadderCoverage(l, 3, 1), 2);
  });

  it('does not apply partial rule when posQty slightly above threshold', () => {
    const l = makeLadder({
      posQty: 0.0148,
      baseQty: 0.014,
      ladderStep: 1,
    });
    assert.equal(getLadderCoverage(l, 2, 1), 3);
  });
});

describe('computeSlotsRemaining', () => {
  it('returns 0 when ladder is full', () => {
    const l = makeLadder({ posQty: 0.05 });
    assert.equal(computeSlotsRemaining(l, 2, 1, 3), 0);
  });

  it('returns remaining slots after partial close', () => {
    const l = makeLadder({ posQty: 0.014, baseQty: 0.014, ladderStep: 1 });
    assert.equal(computeSlotsRemaining(l, 3, 0, 3), 2);
  });
});

describe('shouldTopUpLadder', () => {
  it('returns false in harvest mode', () => {
    const l = makeLadder({ windingDown: true });
    assert.equal(shouldTopUpLadder(l, 1, 0, 3), false);
  });

  it('returns true when a slot is missing', () => {
    const l = makeLadder({ posQty: 0.05 });
    assert.equal(shouldTopUpLadder(l, 2, 0, 3), true);
  });

  it('returns false when covered', () => {
    const l = makeLadder({ posQty: 0.05 });
    assert.equal(shouldTopUpLadder(l, 2, 1, 3), false);
  });
});

describe('isLadderFullyPlaced', () => {
  const threeOrders = [
    { clientOrderId: 'a', side: 'SELL' as const, price: 1700, qty: 0.014, status: 'FILLED' as const },
    { clientOrderId: 'b', side: 'SELL' as const, price: 1710, qty: 0.021, status: 'OPEN' as const },
    { clientOrderId: 'c', side: 'SELL' as const, price: 1720, qty: 0.031, status: 'OPEN' as const },
  ];

  it('true when filled + open cover all levels', () => {
    const l = makeLadder({ entryOrders: threeOrders });
    assert.equal(isLadderFullyPlaced(l), true);
    assert.equal(isLadderFullyFilled(l), false);
  });

  it('false when still missing a placed order', () => {
    const l = makeLadder({ entryOrders: threeOrders.slice(0, 2) });
    assert.equal(isLadderFullyPlaced(l), false);
  });
});
