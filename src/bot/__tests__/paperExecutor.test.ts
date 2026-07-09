import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PaperExecutor } from '../../execution/paper';
import { FillEvent } from '../../execution/types';

function makeExecutor(events: FillEvent[] = []) {
  const ex = new PaperExecutor({
    symbol: 'ETHUSDT',
    initialBalance: 1000,
    makerFee: 0.0002,
    takerFee: 0.0005,
    slippagePct: 0,
    onEvent: (e) => events.push(e),
  });
  ex.tick({ bid: 1999, ask: 2001 });
  return ex;
}

describe('PaperExecutor', () => {
  it('fills MARKET buy at ask with taker fee', async () => {
    const events: FillEvent[] = [];
    const ex = makeExecutor(events);

    await ex.submitOrder({ side: 'BUY', type: 'MARKET', quantity: 0.5 });

    const pos = await ex.getPosition();
    assert.equal(pos.side, 'LONG');
    assert.equal(pos.qty, 0.5);
    assert.equal(pos.entry, 2001);
    // fee = 0.5 × 2001 × 0.0005 = 0.50025
    assert.ok(Math.abs((await ex.getBalance()) - (1000 - 0.50025)) < 1e-9);
    assert.equal(events.length, 1);
    assert.equal(events[0].order.orderStatus, 'FILLED');
  });

  it('rests LIMIT buy below market and fills as maker when ask crosses', async () => {
    const events: FillEvent[] = [];
    const ex = makeExecutor(events);

    await ex.submitOrder({ side: 'BUY', type: 'LIMIT', price: 1990, quantity: 1 });
    assert.equal(events.length, 0); // resting

    ex.tick({ bid: 1988, ask: 1990 }); // ask touches limit
    assert.equal(events.length, 1);

    const pos = await ex.getPosition();
    assert.equal(pos.entry, 1990);
    // maker fee = 1 × 1990 × 0.0002 = 0.398
    assert.ok(Math.abs((await ex.getBalance()) - (1000 - 0.398)) < 1e-9);
  });

  it('rejects marketable post-only (GTX) orders', async () => {
    const ex = makeExecutor();
    await assert.rejects(
      ex.submitOrder({ side: 'BUY', type: 'LIMIT', price: 2005, quantity: 1, timeInForce: 'GTX' }),
      /GTX/
    );
  });

  it('triggers stop and realizes PnL on close', async () => {
    const events: FillEvent[] = [];
    const ex = makeExecutor(events);

    await ex.submitOrder({ side: 'BUY', type: 'MARKET', quantity: 1 }); // long @ 2001
    await ex.submitStopMarket({ side: 'SELL', triggerPrice: 1950, closePosition: true });

    ex.tick({ bid: 1949, ask: 1950 }); // bid <= trigger → stop fires, fill at bid 1949

    const pos = await ex.getPosition();
    assert.equal(pos.qty, 0);
    const closeEvent = events[events.length - 1];
    assert.equal(closeEvent.order.side, 'SELL');
    // realized = (1949 − 2001) × 1 = −52
    assert.ok(Math.abs(Number(closeEvent.order.realisedProfit) - -52) < 1e-9);
  });

  it('rejects a stop that would trigger immediately', async () => {
    const ex = makeExecutor();
    await assert.rejects(
      ex.submitStopMarket({ side: 'SELL', triggerPrice: 2000, closePosition: true }),
      /immediately/
    );
  });

  it('reduceOnly never opens or flips a position', async () => {
    const events: FillEvent[] = [];
    const ex = makeExecutor(events);

    await ex.submitOrder({ side: 'SELL', type: 'MARKET', quantity: 1, reduceOnly: true });
    assert.equal((await ex.getPosition()).qty, 0);
    assert.equal(events.length, 0);

    await ex.submitOrder({ side: 'BUY', type: 'MARKET', quantity: 0.4 });
    await ex.submitOrder({ side: 'SELL', type: 'MARKET', quantity: 2, reduceOnly: true });
    assert.equal((await ex.getPosition()).qty, 0); // capped at position size, not flipped
  });

  it('averages entry price when adding to a position', async () => {
    const ex = makeExecutor();
    await ex.submitOrder({ side: 'BUY', type: 'MARKET', quantity: 1 }); // @2001
    ex.tick({ bid: 2099, ask: 2101 });
    await ex.submitOrder({ side: 'BUY', type: 'MARKET', quantity: 1 }); // @2101
    const pos = await ex.getPosition();
    assert.equal(pos.qty, 2);
    assert.ok(Math.abs(pos.entry - 2051) < 1e-9);
  });

  it('serializes and restores state', async () => {
    const ex = makeExecutor();
    await ex.submitOrder({ side: 'BUY', type: 'MARKET', quantity: 1 });
    await ex.submitStopMarket({ side: 'SELL', triggerPrice: 1900, closePosition: true });
    const snapshot = ex.toJSON();

    const ex2 = makeExecutor();
    ex2.restore(snapshot);
    assert.equal((await ex2.getPosition()).qty, 1);
    assert.equal(ex2.toJSON().restingStops.length, 1);
    assert.ok(Math.abs((await ex2.getBalance()) - (await ex.getBalance())) < 1e-9);
  });
});
