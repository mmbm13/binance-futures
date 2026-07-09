import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCatastrophicSlPrice,
  computeExitPrices,
  computeHarvestSlPrice,
  wouldSlTriggerNow,
} from '../phases/exitPricing';

describe('computeExitPrices', () => {
  it('sizes SL and TP for symmetric dollar risk on LONG at full size', () => {
    const exits = computeExitPrices('LONG', 1700, 0.066, 0.8, 0.01, 1.5);
    assert.equal(exits.closeSide, 'SELL');
    assert.equal(exits.mode, 'building');
    assert.ok(Math.abs(exits.tpTargetUsd - 1.2) < 1e-9);
    assert.ok(Math.abs(exits.slTargetUsd - 0.8) < 1e-9);
  });

  it('caps building TP % when qty is small (first ladder fill)', () => {
    const exits = computeExitPrices('SHORT', 1670, 0.014, 0.81, 0.01, 1.5);
    assert.ok(exits.tpPrice > 1643);
    assert.ok(exits.tpPrice < 1646);
  });

  it('uses stable full-ladder SL at avg entry with fixed max loss beyond deepest', () => {
    const projection = {
      avgEntry: 1692.73,
      qty: 0.051,
      deepestPrice: 1710,
      prices: [1670, 1690, 1710],
      quantities: [0.011, 0.016, 0.024],
    };
    const exits = computeExitPrices('SHORT', 1670, 0.011, 0.81, 0.01, 1.5, {
      buildingSlProjection: projection,
    });

    assert.equal(exits.skipSl, false);
    assert.ok(Math.abs(exits.slTargetUsd - 0.81) < 0.02);
    assert.ok(exits.slPrice > 1710 + 0.04);
    assert.ok(exits.slPrice < 1720);
  });

  it('defers building SL until all ladder orders are placed', () => {
    const exits = computeExitPrices('SHORT', 1670, 0.014, 0.81, 0.01, 1.5, {
      deferBuildingSl: true,
      buildingSlProjection: {
        avgEntry: 1692.73,
        qty: 0.066,
        deepestPrice: 1700,
        prices: [1670, 1680, 1700],
        quantities: [0.014, 0.021, 0.031],
      },
    });
    assert.equal(exits.skipSl, true);
    assert.equal(exits.mode, 'building');
  });

  it('uses breakeven SL (never symmetric loss) in harvest mode', () => {
    const exits = computeExitPrices('SHORT', 1695, 0.014, 0.82, 0.01, 1.5, {
      harvestMode: true,
    });
    assert.equal(exits.mode, 'harvest');
    assert.equal(exits.skipSl, false);
    // SHORT breakeven SL sits just below entry (locks ~0 instead of risking -1.5%)
    assert.ok(exits.slPrice < 1695);
    assert.ok(exits.slPrice > 1695 * 0.997);
  });

  it('falls back to wide symmetric harvest SL when breakeven is already breached', () => {
    const exits = computeExitPrices('SHORT', 1695, 0.014, 0.82, 0.01, 1.5, {
      harvestMode: true,
      currentPrice: 1694,
    });
    assert.equal(exits.skipSl, false);
    assert.ok(Math.abs(exits.slPrice - 1695 * 1.015) < 0.05);
  });

  it('skips harvest SL entirely when even the fallback would trigger (backstop takes over)', () => {
    const exits = computeExitPrices('SHORT', 1695, 0.014, 0.82, 0.01, 1.5, {
      harvestMode: true,
      currentPrice: 1725,
    });
    assert.equal(exits.skipSl, true);
  });

  it('skips building SL when full-ladder geometry is infeasible', () => {
    const exits = computeExitPrices('LONG', 1560, 0.015, 0.8, 0.01, 1.5, {
      buildingSlProjection: {
        avgEntry: 1540,
        qty: 0.07,
        deepestPrice: 1520,
        prices: [1560, 1540, 1520],
        quantities: [0.015, 0.022, 0.033],
      },
    });
    assert.equal(exits.skipSl, true);
    assert.equal(exits.slPrice, 0);
  });

  it('defers building SL but not when building trail is active', () => {
    const exits = computeExitPrices('SHORT', 1670, 0.014, 0.81, 0.01, 1.5, {
      deferBuildingSl: true,
      buildingTrailActive: true,
      buildingTrailPeakPrice: 1645,
      buildingTrailFloorPct: 0.015,
      buildingTrailPct: 0.0075,
    });
    assert.equal(exits.skipSl, false);
    assert.equal(exits.skipTp, true);
  });
});

describe('computeHarvestSlPrice', () => {
  it('floors at breakeven when peak has not moved', () => {
    const sl = computeHarvestSlPrice('SHORT', 1695, 1695, 0.01);
    assert.ok(Math.abs(sl - 1695 * (1 - 0.001)) < 0.02);
  });

  it('trails the peak once it beats breakeven (SHORT)', () => {
    const sl = computeHarvestSlPrice('SHORT', 1695, 1650, 0.01);
    assert.ok(Math.abs(sl - 1650 * 1.0075) < 0.02);
    assert.ok(sl < computeHarvestSlPrice('SHORT', 1695, 1695, 0.01));
  });

  it('trails the peak once it beats breakeven (LONG)', () => {
    const sl = computeHarvestSlPrice('LONG', 1700, 1730, 0.01);
    assert.ok(Math.abs(sl - 1730 * 0.9925) < 0.02);
    assert.ok(sl > 1700);
  });

  it('falls back to entry when peak is missing', () => {
    const sl = computeHarvestSlPrice('LONG', 1700, 0, 0.01);
    assert.ok(Math.abs(sl - 1700 * 1.001) < 0.02);
  });
});

describe('computeCatastrophicSlPrice', () => {
  it('places backstop at riskAmount × mult from entry', () => {
    const sl = computeCatastrophicSlPrice('LONG', 1700, 0.014, 0.8, 0.01, 2);
    assert.ok(Math.abs(sl - (1700 - 1.6 / 0.014)) < 0.02);
  });

  it('mirrors for SHORT', () => {
    const sl = computeCatastrophicSlPrice('SHORT', 1700, 0.014, 0.8, 0.01, 2);
    assert.ok(Math.abs(sl - (1700 + 1.6 / 0.014)) < 0.02);
  });

  it('returns 0 on invalid inputs', () => {
    assert.equal(computeCatastrophicSlPrice('LONG', 1700, 0, 0.8, 0.01), 0);
    assert.equal(computeCatastrophicSlPrice('LONG', 0, 0.014, 0.8, 0.01), 0);
  });
});

describe('wouldSlTriggerNow', () => {
  it('detects SHORT stop zone', () => {
    assert.equal(wouldSlTriggerNow('SHORT', 1720, 1719, 0.01), false);
    assert.equal(wouldSlTriggerNow('SHORT', 1720, 1720, 0.01), true);
  });

  it('detects LONG stop zone', () => {
    assert.equal(wouldSlTriggerNow('LONG', 1680, 1680, 0.01), true);
    assert.equal(wouldSlTriggerNow('LONG', 1680, 1690, 0.01), false);
  });
});
