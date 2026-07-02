import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planLadderPricesFromWalls, projectFullLadder, hasFullLadderProjection } from '../ladder/projection';
import { resolveBaseQtyForLadder } from '../ladder/sizing';
import { makeLadder } from './helpers';

describe('planLadderPricesFromWalls', () => {
  it('plans N rungs using same spacing logic as build phase', () => {
    const buyWalls = [1570, 1560, 1550, 1540, 1530].map((price) => ({ price, volume: 1000 }));
    const prices = planLadderPricesFromWalls(buyWalls, 'LONG', 1570, 3, 0.01);
    assert.deepEqual(prices, [1570, 1550, 1530]);
  });

  it('rejects straddle when full ladder + SL is infeasible at account cap', () => {
    const buyWalls = [1570, 1560, 1550, 1540, 1530].map((price) => ({ price, volume: 1000 }));
    const sellWalls = [1580, 1590, 1600].map((price) => ({ price, volume: 1000 }));
    const longPrices = planLadderPricesFromWalls(buyWalls, 'LONG', 1570, 3, 0.01);
    const shortPrices = planLadderPricesFromWalls(sellWalls, 'SHORT', 1580, 3, 0.01);
    const resolved = resolveBaseQtyForLadder(
      shortPrices,
      longPrices,
      0.81,
      0.001,
      0.001,
      20,
      0.01,
      1.5,
      0.015,
      3
    );
    assert.equal(resolved, null);
  });
});

describe('projectFullLadder', () => {
  it('projects avg entry and total qty for full SHORT ladder', () => {
    const ladder = makeLadder({
      side: 'SHORT',
      baseQty: 0.014,
      entryOrders: [
        { clientOrderId: 'a', side: 'SELL', price: 1700, qty: 0.014, status: 'FILLED' },
        { clientOrderId: 'b', side: 'SELL', price: 1730, qty: 0.021, status: 'OPEN' },
        { clientOrderId: 'c', side: 'SELL', price: 1750, qty: 0.031, status: 'OPEN' },
      ],
    });

    const projection = projectFullLadder(ladder, 3, 0.001);
    assert.ok(projection);
    assert.equal(projection!.levels.length, 3);
    assert.ok(Math.abs(projection!.totalQty - 0.066) < 1e-9);
    assert.ok(projection!.avgEntry > 1730);
    assert.ok(projection!.avgEntry < 1740);
    assert.equal(projection!.deepestPrice, 1750);
    assert.equal(hasFullLadderProjection(ladder, 3), true);
  });

  it('sorts LONG rungs from highest to lowest price', () => {
    const ladder = makeLadder({
      side: 'LONG',
      baseQty: 0.014,
      entryOrders: [
        { clientOrderId: 'a', side: 'BUY', price: 1680, qty: 0.014, status: 'FILLED' },
        { clientOrderId: 'b', side: 'BUY', price: 1660, qty: 0.021, status: 'OPEN' },
        { clientOrderId: 'c', side: 'BUY', price: 1650, qty: 0.031, status: 'OPEN' },
      ],
    });

    const projection = projectFullLadder(ladder, 3, 0.001);
    assert.ok(projection);
    assert.equal(projection!.levels[0].price, 1680);
    assert.equal(projection!.levels[2].price, 1650);
    assert.equal(projection!.deepestPrice, 1650);
  });

  it('returns null when side is not set', () => {
    assert.equal(projectFullLadder(makeLadder({ side: null }), 3, 0.001), null);
  });
});
