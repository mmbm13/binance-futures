import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createArmedCascade,
  detectCascade,
  isCascadeExhausted,
  LiqWindowHistory,
  notionalInWindow,
  percentile,
  priceChangeOverWindow,
  refreshArmedOnLiq,
  computeLiqRevStops,
} from '../../strategies/liqrev/cascadeDetector';
import { isArmedExpired, isTimeStopDue } from '../../strategies/liqrev/rules';

describe('cascadeDetector', () => {
  it('percentile returns interpolated value', () => {
    assert.equal(percentile([1, 2, 3, 4], 0), 1);
    assert.ok(percentile([100, 200, 300, 400], 0.99) >= 390);
  });

  it('detects bearish cascade when sell liqs and price drop exceed thresholds', () => {
    const r = detectCascade({
      sellNotional60s: 600_000,
      buyNotional60s: 10_000,
      priceChange60s: -90,
      atr1m: 30,
      sellThreshold: 500_000,
      buyThreshold: 500_000,
      priceMoveAtrMult: 3,
    });
    assert.ok(r);
    assert.equal(r!.direction, 'bearish');
    assert.equal(r!.tradeSide, 'LONG');
  });

  it('rejects cascade when price move is too small', () => {
    const r = detectCascade({
      sellNotional60s: 600_000,
      buyNotional60s: 0,
      priceChange60s: -50,
      atr1m: 30,
      sellThreshold: 500_000,
      buyThreshold: 500_000,
      priceMoveAtrMult: 3,
    });
    assert.equal(r, null);
  });

  it('sums notional in sliding window', () => {
    const now = 1_000_000;
    const events = [
      { ts: now - 30_000, side: 'SELL' as const, notional: 100, price: 2000 },
      { ts: now - 70_000, side: 'SELL' as const, notional: 999, price: 2000 },
    ];
    assert.equal(notionalInWindow(events, 'SELL', now, 60), 100);
  });

  it('priceChangeOverWindow uses oldest and latest in window', () => {
    const now = 60_000;
    const hist = [
      { ts: 5_000, price: 2100 },
      { ts: 55_000, price: 2000 },
    ];
    assert.equal(priceChangeOverWindow(hist, now, 60), -100);
  });

  it('refreshArmedOnLiq resets clock and updates extreme on second leg', () => {
    const now = 100_000;
    let armed = createArmedCascade(
      { direction: 'bearish', tradeSide: 'LONG', liqSide: 'SELL' },
      2000,
      2100,
      -5,
      now - 20_000
    );
    armed = refreshArmedOnLiq(armed, 1980, now);
    assert.equal(armed.cascadeExtreme, 1980);
    assert.equal(armed.lastLiqAt, now);
  });

  it('isCascadeExhausted requires quiet period, stable price, and CVD flip', () => {
    const armed = createArmedCascade(
      { direction: 'bearish', tradeSide: 'LONG', liqSide: 'SELL' },
      2000,
      2100,
      -10,
      0
    );
    armed.lastLiqAt = 0;
    assert.equal(
      isCascadeExhausted({ armed, now: 50_000, price: 2010, cvd1m: 5, exhaustSec: 45 }),
      true
    );
    assert.equal(
      isCascadeExhausted({ armed, now: 50_000, price: 1970, cvd1m: 5, exhaustSec: 45 }),
      false
    );
  });

  it('LiqWindowHistory uses min notional until enough samples', () => {
    const h = new LiqWindowHistory(10);
    assert.equal(h.threshold('SELL', 0.99, 500_000), 500_000);
    for (let i = 0; i < 12; i++) h.push(100_000 * (i + 1), 0);
    assert.ok(h.threshold('SELL', 0.99, 500_000) >= 500_000);
  });

  it('computeLiqRevStops for long reversal', () => {
    const { sl, tp } = computeLiqRevStops('LONG', 2000, 2100, 1950, 20, 0.5, 0.5, 0.1);
    assert.equal(sl, 1940);
    assert.equal(tp, 2075);
  });
});

describe('liqrev rules', () => {
  it('time stop and armed TTL helpers', () => {
    const t0 = Date.now();
    assert.equal(isTimeStopDue(t0, 45, t0 + 44 * 60_000), false);
    assert.equal(isTimeStopDue(t0, 45, t0 + 46 * 60_000), true);
    assert.equal(isArmedExpired(t0, 10, t0 + 9 * 60_000), false);
    assert.equal(isArmedExpired(t0, 10, t0 + 11 * 60_000), true);
  });
});
