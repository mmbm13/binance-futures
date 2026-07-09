import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { atr, adx, Candle, donchianHigh, donchianLow } from '../../strategies/momentum/indicators';

function candle(open: number, high: number, low: number, close: number, i = 0): Candle {
  return { openTime: i * 3_600_000, open, high, low, close, volume: 100 };
}

/** Steady uptrend: each candle gains `step` with range `range`. */
function uptrend(n: number, start = 100, step = 2, range = 3): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + i * step;
    return candle(close - step, close + range / 2, close - step - range / 2, close, i);
  });
}

/** Flat chop: alternating up/down closes around a level. */
function chop(n: number, level = 100, amp = 1): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = level + (i % 2 === 0 ? amp : -amp);
    return candle(level, level + amp, level - amp, close, i);
  });
}

describe('atr', () => {
  it('equals the candle range for constant-range candles without gaps', () => {
    const candles = Array.from({ length: 30 }, (_, i) => candle(100, 105, 95, 100, i));
    const value = atr(candles, 14);
    assert.ok(Math.abs(value! - 10) < 1e-9);
  });

  it('returns null with insufficient data', () => {
    assert.equal(atr(uptrend(10), 14), null);
  });
});

describe('donchian channels', () => {
  it('excludes the most recent candle from the channel', () => {
    const candles = [
      ...Array.from({ length: 20 }, (_, i) => candle(100, 110, 90, 100, i)),
      candle(100, 150, 100, 149, 20), // breakout candle
    ];
    assert.equal(donchianHigh(candles, 20), 110); // not 150
    assert.equal(donchianLow(candles, 20), 90);
  });

  it('returns null with insufficient data', () => {
    assert.equal(donchianHigh(uptrend(10), 20), null);
  });
});

describe('adx', () => {
  it('is high in a steady trend and low in chop', () => {
    const trending = adx(uptrend(60), 14);
    const choppy = adx(chop(60), 14);
    assert.ok(trending !== null && choppy !== null);
    assert.ok(trending! > 25, `trending adx ${trending}`);
    assert.ok(choppy! < 20, `choppy adx ${choppy}`);
    assert.ok(trending! > choppy!);
  });

  it('returns null with insufficient data', () => {
    assert.equal(adx(uptrend(20), 14), null);
  });
});
