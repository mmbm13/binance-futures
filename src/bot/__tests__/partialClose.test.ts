import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePartialClose, resolveMinPartialProfit } from '../phases/partialClose';
import { makeLadder } from './helpers';

function filledShortOrders(count = 3) {
  const qtys = [0.014, 0.021, 0.031];
  return Array.from({ length: count }, (_, i) => ({
    clientOrderId: `e${i}`,
    side: 'SELL' as const,
    price: 1696 - i * 20,
    qty: qtys[i] ?? 0.014,
    status: 'FILLED' as const,
  }));
}

describe('resolveMinPartialProfit', () => {
  it('scales with riskAmount', () => {
    assert.ok(Math.abs(resolveMinPartialProfit(0.8, 0.2) - 0.16) < 1e-9);
    assert.equal(resolveMinPartialProfit(100, 0.2), 20);
    assert.equal(resolveMinPartialProfit(10_000, 0.2), 2000);
  });

  it('uses floor when risk is tiny', () => {
    assert.equal(resolveMinPartialProfit(0.1, 0.2, 0.05), 0.05);
    assert.equal(resolveMinPartialProfit(0, 0.2, 0.05), 0.05);
  });
});

describe('evaluatePartialClose', () => {
  const base = {
    price: 1680,
    stepSize: 0.001,
    minQty: 0.001,
    takerFee: 0.0005,
  };

  it('rejects when winding down', () => {
    const result = evaluatePartialClose({
      ...base,
      ladder: makeLadder({ windingDown: true }),
    });
    assert.equal(result.shouldClose, false);
    assert.equal(result.reason, 'not_eligible');
  });

  it('rejects with fewer than 2 fills', () => {
    const result = evaluatePartialClose({
      ...base,
      ladder: makeLadder({ fills: 1, entryOrders: filledShortOrders(1) }),
    });
    assert.equal(result.reason, 'insufficient_fills');
  });

  it('approves partial close with 2 fills while deeper rungs remain open', () => {
    const result = evaluatePartialClose({
      ...base,
      ladder: makeLadder({
        fills: 2,
        entryOrders: [
          ...filledShortOrders(2),
          {
            clientOrderId: 'e2',
            side: 'SELL' as const,
            price: 1656,
            qty: 0.031,
            status: 'OPEN' as const,
          },
        ],
        feesPaid: 0.5,
        posQty: 0.035,
        baseQty: 0.014,
        entryPrice: 1696,
        side: 'SHORT',
        riskAmount: 0.8,
      }),
      price: 1650,
      minPartialProfitRatio: 0.2,
    });
    assert.equal(result.shouldClose, true);
    assert.equal(result.keepQty, 0.014);
    assert.equal(result.closeQty, 0.021);
  });

  it('rejects when unrealized does not beat fees', () => {
    const result = evaluatePartialClose({
      ...base,
      ladder: makeLadder({
        fills: 3,
        entryOrders: filledShortOrders(3),
        feesPaid: 5,
        posQty: 0.035,
        entryPrice: 1696,
        side: 'SHORT',
      }),
      price: 1690,
    });
    assert.equal(result.shouldClose, false);
    assert.equal(result.reason, 'unrealized_below_fees');
  });

  it('rejects when unrealized beats fees but not min profit from risk', () => {
    const result = evaluatePartialClose({
      ...base,
      ladder: makeLadder({
        fills: 3,
        entryOrders: filledShortOrders(3),
        feesPaid: 0.03,
        posQty: 0.035,
        baseQty: 0.014,
        entryPrice: 1696,
        side: 'SHORT',
        riskAmount: 0.8,
      }),
      price: 1693.2,
      minPartialProfitRatio: 0.2,
      minPartialProfitFloor: 0.05,
    });
    assert.equal(result.shouldClose, false);
    assert.equal(result.reason, 'unrealized_below_min_profit');
    assert.ok(Math.abs(result.minPartialProfit! - 0.16) < 1e-9);
    assert.ok(result.unrealized! > result.feeThreshold!);
    assert.ok(result.unrealized! < result.profitThreshold!);
  });

  it('approves profitable partial close for SHORT', () => {
    const result = evaluatePartialClose({
      ...base,
      ladder: makeLadder({
        fills: 3,
        entryOrders: filledShortOrders(3),
        feesPaid: 0.5,
        posQty: 0.035,
        baseQty: 0.014,
        entryPrice: 1696,
        side: 'SHORT',
        riskAmount: 0.8,
      }),
      price: 1650,
      minPartialProfitRatio: 0.2,
    });
    assert.equal(result.shouldClose, true);
    assert.equal(result.keepQty, 0.014);
    assert.equal(result.closeQty, 0.021);
    assert.ok(Math.abs(result.minPartialProfit! - 0.16) < 1e-9);
    assert.ok(result.unrealized! > result.profitThreshold!);
  });

  it('rejects when already at base qty', () => {
    const result = evaluatePartialClose({
      ...base,
      ladder: makeLadder({
        fills: 3,
        entryOrders: filledShortOrders(3),
        posQty: 0.014,
        baseQty: 0.014,
      }),
    });
    assert.equal(result.reason, 'already_at_base_qty');
  });
});
