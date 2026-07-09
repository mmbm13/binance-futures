import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFundingApr,
  computeQty,
  computeTrailStop,
  evaluateEntrySignal,
  shouldPause,
  updateExtreme,
  EntryIndicators,
} from '../../strategies/momentum/rules';

const baseInd: EntryIndicators = {
  close: 2050,
  high: 2055,
  low: 2020,
  channelHigh: 2040,
  channelLow: 1960,
  atrValue: 20,
  adxValue: 30,
};

const params = { adxMin: 20, atrStopMult: 2, maxBreakoutAtr: 4, fundingVetoApr: 0.3 };

describe('evaluateEntrySignal', () => {
  it('signals LONG on a close above the channel high', () => {
    const r = evaluateEntrySignal(baseInd, 0, params);
    assert.equal(r.reason, 'ok');
    assert.equal(r.signal!.side, 'LONG');
    assert.equal(r.signal!.stopDistance, 40); // 2 × ATR
  });

  it('signals SHORT on a close below the channel low', () => {
    const r = evaluateEntrySignal(
      { ...baseInd, close: 1950, high: 1980, low: 1945 },
      0,
      params
    );
    assert.equal(r.signal!.side, 'SHORT');
  });

  it('returns no_breakout inside the channel (no signal record noise)', () => {
    const r = evaluateEntrySignal({ ...baseInd, close: 2000 }, 0, params);
    assert.equal(r.signal, null);
    assert.equal(r.reason, 'no_breakout');
  });

  it('vetoes on low ADX', () => {
    const r = evaluateEntrySignal({ ...baseInd, adxValue: 15 }, 0, params);
    assert.equal(r.signal, null);
    assert.equal(r.reason, 'adx_below_min');
  });

  it('vetoes giant breakout candles (>4×ATR)', () => {
    const r = evaluateEntrySignal({ ...baseInd, high: 2110, low: 2020 }, 0, params);
    assert.equal(r.signal, null);
    assert.equal(r.reason, 'breakout_candle_too_large');
  });

  it('vetoes LONG when funding is euphoric and SHORT when deeply negative', () => {
    assert.equal(evaluateEntrySignal(baseInd, 0.5, params).reason, 'funding_veto');
    const shortInd = { ...baseInd, close: 1950, high: 1980, low: 1945 };
    assert.equal(evaluateEntrySignal(shortInd, -0.5, params).reason, 'funding_veto');
    // Funding against the OTHER side does not veto
    assert.equal(evaluateEntrySignal(baseInd, -0.5, params).reason, 'ok');
  });
});

describe('computeTrailStop', () => {
  it('trails the extreme and never retreats (LONG)', () => {
    const s1 = computeTrailStop('LONG', 2100, 20, 3, null, 0.01);
    assert.equal(s1, 2040); // 2100 − 60
    const s2 = computeTrailStop('LONG', 2200, 20, 3, s1, 0.01);
    assert.equal(s2, 2140);
    // Extreme unchanged but ATR expands → candidate worse → keep current
    const s3 = computeTrailStop('LONG', 2200, 40, 3, s2, 0.01);
    assert.equal(s3, 2140);
  });

  it('mirrors for SHORT', () => {
    const s1 = computeTrailStop('SHORT', 1900, 20, 3, null, 0.01);
    assert.equal(s1, 1960);
    const s2 = computeTrailStop('SHORT', 1850, 20, 3, s1, 0.01);
    assert.equal(s2, 1910);
  });
});

describe('updateExtreme', () => {
  it('ratchets highs for LONG and lows for SHORT', () => {
    assert.equal(updateExtreme('LONG', 2100, { high: 2150, low: 2050 }), 2150);
    assert.equal(updateExtreme('LONG', 2100, { high: 2080, low: 2050 }), 2100);
    assert.equal(updateExtreme('SHORT', 1900, { high: 1950, low: 1850 }), 1850);
  });
});

describe('computeQty', () => {
  it('sizes by risk over stop distance and floors to step', () => {
    // risk = 1000 × 0.01 = 10; stop 40 → 0.25
    const r = computeQty(1000, 0.01, 40, 2000, 0.001, 0.001, 5);
    assert.equal(r.qty, 0.25);
    assert.equal(r.valid, true);
  });

  it('rejects below minQty and minNotional', () => {
    assert.equal(computeQty(10, 0.01, 100, 2000, 0.001, 0.001, 5).valid, false);
    assert.equal(computeQty(100, 0.01, 400, 2000, 0.001, 0.001, 5).reason, 'notional_below_min');
  });
});

describe('shouldPause / computeFundingApr', () => {
  it('pauses at the loss cap', () => {
    assert.equal(shouldPause(5, 6), false);
    assert.equal(shouldPause(6, 6), true);
    assert.equal(shouldPause(10, 0), false); // disabled
  });

  it('annualizes 8h funding', () => {
    assert.ok(Math.abs(computeFundingApr(0.0001) - 0.1095) < 1e-9);
  });
});
