import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canAntiMartingaleAdd,
  computeZoneSlPrice,
  detectZoneTouch,
  isReboundConfirmed,
  shouldAbortOnZoneWithdrawal,
  updateTouchExtreme,
} from '../../strategies/bounce/rules';
import { ScoredZone } from '../../strategies/bounce/wallPersistence';

const bidZone = (price: number): ScoredZone => ({
  price,
  side: 'bid',
  presence: 1,
  avgVolume: 100,
  score: 100,
});

const askZone = (price: number): ScoredZone => ({
  price,
  side: 'ask',
  presence: 1,
  avgVolume: 100,
  score: 100,
});

describe('detectZoneTouch', () => {
  it('detects long setup when price reaches bid zone', () => {
    const touch = detectZoneTouch(1980, [bidZone(1980)], [], 0.001);
    assert.equal(touch?.tradeSide, 'LONG');
  });

  it('detects short setup at ask zone', () => {
    const touch = detectZoneTouch(2020, [], [askZone(2020)], 0.001);
    assert.equal(touch?.tradeSide, 'SHORT');
  });

  it('returns null far from zones', () => {
    assert.equal(detectZoneTouch(2000, [bidZone(1980)], [askZone(2020)], 0.001), null);
  });
});

describe('isReboundConfirmed', () => {
  it('requires rebound pct and positive cvd for long', () => {
    assert.equal(
      isReboundConfirmed({
        tradeSide: 'LONG',
        price: 1985,
        touchExtreme: 1975,
        cvd1m: 10,
        reboundPct: 0.0015,
      }),
      true
    );
    assert.equal(
      isReboundConfirmed({
        tradeSide: 'LONG',
        price: 1976,
        touchExtreme: 1975,
        cvd1m: 10,
        reboundPct: 0.0015,
      }),
      false
    );
    assert.equal(
      isReboundConfirmed({
        tradeSide: 'LONG',
        price: 1985,
        touchExtreme: 1975,
        cvd1m: -1,
        reboundPct: 0.0015,
      }),
      false
    );
  });
});

describe('updateTouchExtreme', () => {
  it('tracks min for long and max for short', () => {
    assert.equal(updateTouchExtreme('LONG', 1980, 1975), 1975);
    assert.equal(updateTouchExtreme('LONG', 1975, 1978), 1975);
    assert.equal(updateTouchExtreme('SHORT', 2020, 2025), 2025);
  });
});

describe('computeZoneSlPrice', () => {
  it('places SL below bid zone for long', () => {
    const sl = computeZoneSlPrice('LONG', 2000, 20, 0.5, 0.01);
    assert.equal(sl, 1990);
  });

  it('places SL above ask zone for short', () => {
    const sl = computeZoneSlPrice('SHORT', 2000, 20, 0.5, 0.01);
    assert.equal(sl, 2010);
  });
});

describe('canAntiMartingaleAdd', () => {
  it('allows add only when in profit by trigger R', () => {
    assert.equal(canAntiMartingaleAdd(4, 10, 0, 2, 0.5), false);
    assert.equal(canAntiMartingaleAdd(6, 10, 0, 2, 0.5), true);
    assert.equal(canAntiMartingaleAdd(20, 10, 2, 2, 0.5), false);
  });
});

describe('shouldAbortOnZoneWithdrawal', () => {
  it('aborts only before breakeven when zone is gone', () => {
    assert.equal(shouldAbortOnZoneWithdrawal(false, false), true);
    assert.equal(shouldAbortOnZoneWithdrawal(true, false), false);
    assert.equal(shouldAbortOnZoneWithdrawal(false, true), false);
  });
});
