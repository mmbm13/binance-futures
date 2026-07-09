import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScoredZones,
  WallSnapshot,
  zoneVolumeRetained,
} from '../../strategies/bounce/wallPersistence';

function sample(ts: number, price: number, buy: [number, number][], sell: [number, number][]): WallSnapshot {
  return {
    ts,
    currentPrice: price,
    buyWalls: buy.map(([p, v]) => ({ price: p, volume: v })),
    sellWalls: sell.map(([p, v]) => ({ price: p, volume: v })),
  };
}

describe('buildScoredZones', () => {
  it('keeps buckets present in most samples with high relative volume', () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sample(i, 2000, [[1980, 100]], [])
    );
    const bid = buildScoredZones(samples, 'bid', 0.7, 1, 3);
    assert.equal(bid.length, 1);
    assert.equal(bid[0].price, 1980);
    assert.ok(bid[0].presence >= 0.7);
  });

  it('drops buckets that appear only once (spoof)', () => {
    const samples = [
      ...Array.from({ length: 9 }, (_, i) => sample(i, 2000, [[1980, 100]], [])),
      sample(9, 2000, [[1980, 100], [1970, 200]], []),
    ];
    const bid = buildScoredZones(samples, 'bid', 0.7, 1, 3);
    assert.equal(bid.some((z) => z.price === 1970), false);
    assert.equal(bid.some((z) => z.price === 1980), true);
  });

  it('respects maxZones cap', () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sample(i, 2000, [
        [1980, 100],
        [1970, 90],
        [1960, 80],
        [1950, 70],
      ], [])
    );
    const bid = buildScoredZones(samples, 'bid', 0.7, 1, 2);
    assert.equal(bid.length, 2);
  });
});

describe('zoneVolumeRetained', () => {
  it('requires live volume >= retention × avgVolume', () => {
    const zone = { price: 1980, side: 'bid' as const, presence: 1, avgVolume: 100, score: 100 };
    assert.equal(zoneVolumeRetained(zone, [{ price: 1980, volume: 60 }], 0.5), true);
    assert.equal(zoneVolumeRetained(zone, [{ price: 1980, volume: 40 }], 0.5), false);
    assert.equal(zoneVolumeRetained(zone, [], 0.5), false);
  });
});
