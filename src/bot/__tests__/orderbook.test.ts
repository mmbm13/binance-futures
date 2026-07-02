import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBookMidPrice,
  shouldUseMarkPriceFallback,
} from '../orderbook';

describe('computeBookMidPrice', () => {
  it('returns mid of valid bid/ask', () => {
    assert.equal(computeBookMidPrice(1697.5, 1698.5), 1698);
  });

  it('rejects inverted or equal quotes', () => {
    assert.equal(computeBookMidPrice(1700, 1699), null);
    assert.equal(computeBookMidPrice(1700, 1700), null);
  });

  it('rejects non-positive quotes', () => {
    assert.equal(computeBookMidPrice(0, 1700), null);
    assert.equal(computeBookMidPrice(1699, -1), null);
  });
});

describe('shouldUseMarkPriceFallback', () => {
  const now = 1_000_000;

  it('uses mark when bookTicker never arrived', () => {
    assert.equal(shouldUseMarkPriceFallback(0, now), true);
  });

  it('uses mark when bookTicker is stale', () => {
    assert.equal(shouldUseMarkPriceFallback(now - 15_000, now), true);
  });

  it('ignores mark when bookTicker is fresh', () => {
    assert.equal(shouldUseMarkPriceFallback(now - 2_000, now), false);
  });
});
