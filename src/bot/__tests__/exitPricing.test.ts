import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeExitPrices, wouldSlTriggerNow } from '../phases/exitPricing';

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

  it('uses symmetric % TP and SL in harvest mode (not building risk/qty)', () => {
    const harvest = computeExitPrices('SHORT', 1695, 0.014, 0.82, 0.01, 1.5, {
      harvestMode: true,
    });
    const building = computeExitPrices('SHORT', 1695, 0.014, 0.82, 0.01, 1.5);
    assert.equal(harvest.mode, 'harvest');
    assert.ok((harvest.slDistance / 1695) * 100 < 2);
    assert.ok((building.slDistance / 1695) * 100 > 3);
    assert.ok(harvest.slPrice < building.slPrice);
  });

  it('uses symmetric % TP and SL in harvest mode', () => {
    const exits = computeExitPrices('SHORT', 1695, 0.014, 0.82, 0.01, 1.5, {
      harvestMode: true,
    });
    assert.equal(exits.mode, 'harvest');
    assert.equal(exits.skipSl, false);
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
