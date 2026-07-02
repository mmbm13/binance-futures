import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeGeometricLadderQuantities,
  computeRiskSizedLadderQuantities,
  buildingSlPrice,
  projectedSlPrice,
  slBeyondDeepestRung,
  validateLadderQuantities,
  validateRiskSizedLadder,
  validateLadderWithSlGeometry,
} from '../ladder/sizing';
import { projectFullLadder } from '../ladder/projection';
import { computeExitPrices } from '../phases/exitPricing';
import { makeLadder } from './helpers';

describe('validateLadderQuantities', () => {
  it('rejects qty below minQty', () => {
    const result = validateLadderQuantities([0.014, 0.0005], [1670, 1690], 0.001, 5);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'qty_below_min');
    assert.equal(result.level, 2);
  });

  it('rejects notional below exchange minimum', () => {
    const result = validateLadderQuantities([0.001, 0.001], [1670, 1690], 0.001, 20);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'notional_below_min');
  });

  it('rejects many levels when risk-sized qty is too small', () => {
    const prices = [1670, 1690, 1710, 1730, 1750];
    const result = validateRiskSizedLadder(
      prices,
      'SHORT',
      0.5,
      0.001,
      0.001,
      20,
      0.01,
      1.5,
      0.001
    );
    assert.equal(result.valid, false);
    assert.ok(
      result.reason === 'qty_below_min' ||
        result.reason === 'notional_below_min' ||
        result.reason === 'sl_geometry_infeasible'
    );
  });
});

describe('computeGeometricLadderQuantities', () => {
  it('keeps monotonic sizes per LADDER_SIZE_MULT', () => {
    const qtys = computeGeometricLadderQuantities(3, 0.014, 0.001, 1.5, 0.014);
    assert.deepEqual(qtys, [0.014, 0.021, 0.031]);
    assert.ok(qtys[1] > qtys[0]);
    assert.ok(qtys[2] > qtys[1]);
  });
});

describe('validateLadderWithSlGeometry', () => {
  it('accepts geometric ladder when SL clears deepest rung', () => {
    const prices = [1670, 1690, 1710];
    const result = validateLadderWithSlGeometry(
      prices,
      'SHORT',
      0.011,
      0.81,
      0.001,
      0.001,
      5,
      0.01
    );
    assert.equal(result.valid, true);
    assert.deepEqual(result.quantities, [0.011, 0.016, 0.024]);
    assert.ok(slBeyondDeepestRung(result.quantities!, prices, 'SHORT', 0.81, 0.01));
  });

  it('rejects default baseQty when SL would sit on deepest rung', () => {
    const prices = [1670, 1690, 1710];
    const result = validateLadderWithSlGeometry(
      prices,
      'SHORT',
      0.014,
      0.81,
      0.001,
      0.001,
      5,
      0.01
    );
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'sl_geometry_infeasible');
  });
});

describe('computeRiskSizedLadderQuantities', () => {
  it('keeps monotonic qty per rung when scaling', () => {
    const prices = [1670, 1690, 1710];
    const qtys = computeRiskSizedLadderQuantities(
      prices,
      'SHORT',
      0.81,
      0.001,
      0.001,
      0.01,
      1.5,
      0.014
    );

    assert.equal(qtys[0], 0.014);
    assert.ok(qtys[1] >= qtys[0]);
    assert.ok(qtys[2] >= qtys[1]);
  });

  it('uses smaller scale when default mult overshoots deepest rung', () => {
    const prices = [1670, 1690, 1710];
    const defaultMult = computeRiskSizedLadderQuantities(
      prices,
      'SHORT',
      0.81,
      0.001,
      0.001,
      0.01,
      1.5,
      0.014
    );
    const fixedGeom = [0.014, 0.021, 0.031];
    assert.ok(!slBeyondDeepestRung(fixedGeom, prices, 'SHORT', 0.81, 0.01));
    assert.ok(defaultMult[2] < fixedGeom[2]);
  });

  it('buildingSlPrice returns null when geometry is infeasible', () => {
    const prices = [1670, 1690, 1710];
    const qtys = [0.014, 0.021, 0.031];
    assert.equal(buildingSlPrice(qtys, prices, 'SHORT', 0.81, 0.01), null);
  });

  it('buildingSlPrice returns price strictly beyond deepest when valid', () => {
    const prices = [1670, 1690, 1710];
    const qtys = [0.011, 0.016, 0.024];
    const sl = buildingSlPrice(qtys, prices, 'SHORT', 0.81, 0.01);
    assert.ok(sl !== null);
    assert.ok(sl! > 1710 + 0.04);
  });
});

describe('full ladder SL with risk-sized qty', () => {
  it('projects exits with monotonic order qty and SL beyond deepest', () => {
    const prices = [1670, 1690, 1710];
    const qtys = computeGeometricLadderQuantities(3, 0.011, 0.001, 1.5, 0.011);
    assert.ok(slBeyondDeepestRung(qtys, prices, 'SHORT', 0.81, 0.01));

    const ladder = makeLadder({
      side: 'SHORT',
      baseQty: 0.011,
      riskAmount: 0.81,
      entryOrders: [
        { clientOrderId: 'a', side: 'SELL', price: 1670, qty: qtys[0], status: 'FILLED' },
        { clientOrderId: 'b', side: 'SELL', price: 1690, qty: qtys[1], status: 'OPEN' },
        { clientOrderId: 'c', side: 'SELL', price: 1710, qty: qtys[2], status: 'OPEN' },
      ],
    });

    const projection = projectFullLadder(ladder, 3, 0.001)!;
    const exits = computeExitPrices('SHORT', 1670, 0.014, 0.81, 0.01, 1.5, {
      buildingSlProjection: {
        avgEntry: projection.avgEntry,
        qty: projection.totalQty,
        deepestPrice: projection.deepestPrice,
        prices: projection.levels.map((l) => l.price),
        quantities: projection.levels.map((l) => l.qty),
      },
    });

    assert.ok(projection.levels[1].qty > projection.levels[0].qty);
    assert.ok(exits.slPrice > projection.deepestPrice);
    assert.ok(Math.abs(exits.slTargetUsd - 0.81) < 0.05);
  });
});
