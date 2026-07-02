import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLastLadderRefPrice,
  resolveNextLadderPrice,
  wallMeetsSpacing,
  dedupeLadderPrice,
} from '../ladder/spacing';
import { makeLadder } from './helpers';

describe('getLastLadderRefPrice', () => {
  it('uses deepest price for LONG', () => {
    const l = makeLadder({
      side: 'LONG',
      entryOrders: [
        { clientOrderId: 'a', side: 'BUY', price: 1680, qty: 0.01, status: 'FILLED' },
        { clientOrderId: 'b', side: 'BUY', price: 1670, qty: 0.015, status: 'OPEN' },
      ],
    });
    assert.equal(getLastLadderRefPrice(l), 1670);
  });

  it('uses shallowest price for SHORT', () => {
    const l = makeLadder({
      side: 'SHORT',
      entryOrders: [
        { clientOrderId: 'a', side: 'SELL', price: 1700, qty: 0.01, status: 'FILLED' },
        { clientOrderId: 'b', side: 'SELL', price: 1720, qty: 0.015, status: 'OPEN' },
      ],
    });
    assert.equal(getLastLadderRefPrice(l), 1720);
  });
});

describe('wallMeetsSpacing', () => {
  it('rejects SHORT wall too close to reference', () => {
    assert.equal(wallMeetsSpacing(1705, 'SHORT', [1700], 0.01), false);
  });

  it('accepts SHORT wall beyond min spacing', () => {
    assert.equal(wallMeetsSpacing(1717, 'SHORT', [1700], 0.01), true);
  });
});

describe('resolveNextLadderPrice', () => {
  it('falls back to pct spacing when no wall in band', () => {
    const result = resolveNextLadderPrice(
      [{ price: 1800, volume: 100 }],
      'SHORT',
      [1700],
      1700,
      [1700],
      0.01,
      0.01,
      0.02
    );
    assert.equal(result.source, 'pct');
    assert.equal(result.price, 1734);
  });

  it('picks highest-volume wall in band', () => {
    const result = resolveNextLadderPrice(
      [
        { price: 1718, volume: 50 },
        { price: 1720, volume: 200 },
      ],
      'SHORT',
      [1700],
      1700,
      [1700],
      0.01,
      0.01,
      0.02
    );
    assert.equal(result.source, 'wall');
    assert.equal(result.price, 1720);
  });
});

describe('dedupeLadderPrice', () => {
  it('nudges price when duplicate detected', () => {
    const price = dedupeLadderPrice(1720, 1700, 'SHORT', [1720], 0.01, 0.01);
    assert.equal(price, 1717);
  });
});
