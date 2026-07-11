import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  activateBuildingTrail,
  armBuildingTrailSlAtFloor,
  awaitingTrailGivebackBreached,
  buildingTrailActivationReached,
  buildingTrailFloorBreached,
  canEvaluateBuildingTrail,
  evaluateBuildingTrail,
  isAwaitingBuildingTrail,
  shouldActivateBuildingTrail,
  ratchetAwaitingTrailPeak,
  recoverAwaitingTrailPeakFromKlines,
  tryActivateBuildingTrailIfNeeded,
} from '../phases/buildingTrail';
import { computeBuildingTrailSlPrice, computeExitPrices, wouldSlTriggerNow } from '../phases/exitPricing';
import { client } from '../client';
import { makeLadder } from './helpers';

const TICK = 0.01;

describe('canEvaluateBuildingTrail', () => {
  it('requires first fill only with an open position', () => {
    assert.equal(canEvaluateBuildingTrail(null), false);
    assert.equal(canEvaluateBuildingTrail(makeLadder({ fills: 2 })), false);
    assert.equal(canEvaluateBuildingTrail(makeLadder({ fills: 1, posQty: 0 })), false);
    assert.equal(canEvaluateBuildingTrail(makeLadder({ fills: 1, posQty: 0.014, windingDown: true })), false);
    assert.equal(
      canEvaluateBuildingTrail(makeLadder({ fills: 1, posQty: 0.014, entryPrice: 1700 })),
      true
    );
  });
});

describe('buildingTrailActivationReached', () => {
  it('detects LONG activation at 1.5%', () => {
    assert.equal(buildingTrailActivationReached('LONG', 100, 101.4, 0.015), false);
    assert.equal(buildingTrailActivationReached('LONG', 100, 101.5, 0.015), true);
  });

  it('detects SHORT activation at 1.5%', () => {
    assert.equal(buildingTrailActivationReached('SHORT', 100, 98.6, 0.015), false);
    assert.equal(buildingTrailActivationReached('SHORT', 100, 98.5, 0.015), true);
  });
});

describe('shouldActivateBuildingTrail', () => {
  it('arms when price hits activation and trail is not yet active', () => {
    const l = makeLadder({ side: 'LONG', fills: 1, posQty: 0.014, entryPrice: 100 });
    assert.equal(shouldActivateBuildingTrail(l, 101.5), true);
    l.buildingTrailActive = true;
    assert.equal(shouldActivateBuildingTrail(l, 102), false);
  });

  it('arms on retracement after peak already reached activation', () => {
    const l = makeLadder({ side: 'LONG', fills: 1, posQty: 0.014, entryPrice: 100 });
    ratchetAwaitingTrailPeak(l, 102);
    assert.equal(l.buildingPeakPrice, 102);
    assert.equal(shouldActivateBuildingTrail(l, 101.2), true);
  });
});

describe('evaluateBuildingTrail', () => {
  it('ratchets peak and requests SL placement when none exists', () => {
    const l = makeLadder({
      side: 'LONG',
      fills: 1,
      posQty: 0.014,
      entryPrice: 100,
      buildingTrailActive: true,
      slPrice: null,
    });
    assert.equal(evaluateBuildingTrail(l, 103, TICK), true);
    assert.equal(l.buildingPeakPrice, 103);
  });

  it('floors SL at activation profit when peak is modest (LONG)', () => {
    const sl = computeBuildingTrailSlPrice('LONG', 100, 101.6, TICK, 0.015, 0.0075);
    assert.ok(Math.abs(sl - 101.5) < 0.02);
  });

  it('trails above floor once peak extends further (LONG)', () => {
    const sl = computeBuildingTrailSlPrice('LONG', 100, 104, TICK, 0.015, 0.0075);
    assert.ok(sl > 101.5);
    assert.ok(Math.abs(sl - 104 * 0.9925) < 0.02);
  });

  it('never loosens peak on adverse moves', () => {
    const l = makeLadder({
      side: 'SHORT',
      fills: 1,
      posQty: 0.014,
      entryPrice: 100,
      buildingTrailActive: true,
      buildingPeakPrice: 98,
      slPrice: 98.74,
    });
    assert.equal(evaluateBuildingTrail(l, 99, TICK), false);
    assert.equal(l.buildingPeakPrice, 98);
  });
});

describe('computeExitPrices building trail', () => {
  it('uses trailing SL and skips fixed TP when building trail is active', () => {
    const exits = computeExitPrices('LONG', 100, 0.014, 0.8, TICK, 1.5, {
      buildingTrailActive: true,
      buildingTrailPeakPrice: 104,
      buildingTrailFloorPct: 0.015,
      buildingTrailPct: 0.0075,
    });
    assert.equal(exits.mode, 'building');
    assert.equal(exits.skipTp, true);
    assert.equal(exits.skipSl, false);
    assert.ok(exits.slPrice > 101.5);
  });

  it('omits fixed TP while awaiting building trail activation', () => {
    const exits = computeExitPrices('SHORT', 1670, 0.014, 0.81, TICK, 1.5, {
      awaitingBuildingTrail: true,
    });
    assert.equal(exits.skipTp, true);
    assert.equal(exits.skipSl, false);
  });

  it('defers trail SL at floor when price is still at activation level', () => {
    const exits = computeExitPrices('LONG', 100, 0.014, 0.8, TICK, 1.5, {
      buildingTrailActive: true,
      buildingTrailPeakPrice: 101.5,
      buildingTrailFloorPct: 0.015,
      buildingTrailPct: 0.0075,
      currentPrice: 101.5,
    });
    assert.equal(exits.skipTp, true);
    assert.equal(exits.skipSl, true);
  });
});

describe('isAwaitingBuildingTrail', () => {
  it('is true for first fill before activation', () => {
    const l = makeLadder({ side: 'LONG', fills: 1, posQty: 0.014, entryPrice: 100 });
    assert.equal(isAwaitingBuildingTrail(l), true);
    l.buildingTrailActive = true;
    assert.equal(isAwaitingBuildingTrail(l), false);
  });
});

describe('buildingTrailFloorBreached', () => {
  it('detects retrace through floor when only catastrophic SL is armed', () => {
    const l = makeLadder({
      side: 'LONG',
      fills: 1,
      posQty: 0.014,
      entryPrice: 100,
      buildingTrailActive: true,
      slIsCatastrophic: true,
      slPrice: 90,
    });
    assert.equal(buildingTrailFloorBreached(l, 101.6, TICK), false);
    assert.equal(buildingTrailFloorBreached(l, 101.4, TICK), true);
  });
});

describe('awaitingTrailGivebackBreached', () => {
  it('closes when peak hit activation but price gives back through the floor', () => {
    const l = makeLadder({ side: 'LONG', fills: 1, posQty: 0.014, entryPrice: 100 });
    l.buildingPeakPrice = 102;
    assert.equal(awaitingTrailGivebackBreached(l, 101.6, TICK), false);
    assert.equal(awaitingTrailGivebackBreached(l, 101.4, TICK), true);
  });

  it('does not trigger before peak reached activation', () => {
    const l = makeLadder({ side: 'LONG', fills: 1, posQty: 0.014, entryPrice: 100 });
    l.buildingPeakPrice = 101.2;
    assert.equal(awaitingTrailGivebackBreached(l, 101.4, TICK), false);
  });
});

describe('armBuildingTrailSlAtFloor', () => {
  it('nudges LONG floor SL below the profit floor so it can arm', () => {
    const sl = armBuildingTrailSlAtFloor('LONG', 101.5, TICK);
    assert.ok(sl < 101.5);
    assert.equal(wouldSlTriggerNow('LONG', sl, 101.5, TICK), false);
  });

  it('nudges SHORT floor SL above the profit floor so it can arm', () => {
    const sl = armBuildingTrailSlAtFloor('SHORT', 98.5, TICK);
    assert.ok(sl > 98.5);
    assert.equal(wouldSlTriggerNow('SHORT', sl, 98.5, TICK), false);
  });
});

describe('recoverAwaitingTrailPeakFromKlines', () => {
  it('ratchets peak from 1m highs while awaiting LONG trail', async () => {
    const l = makeLadder({ side: 'LONG', fills: 1, posQty: 0.016, entryPrice: 1780 });
    const originalGetKlines = client.getKlines;
    client.getKlines = async () =>
      [
        [0, '0', 1800, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, '0', 1811, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, '0', 1795, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ] as Awaited<ReturnType<typeof client.getKlines>>;

    try {
      await recoverAwaitingTrailPeakFromKlines(l, 3);
      assert.equal(l.buildingPeakPrice, 1811);
      assert.equal(shouldActivateBuildingTrail(l, 1790), true);
    } finally {
      client.getKlines = originalGetKlines;
    }
  });
});

describe('tryActivateBuildingTrailIfNeeded', () => {
  it('arms trail when threshold is reached', async () => {
    const l = makeLadder({ side: 'LONG', fills: 1, posQty: 0.014, entryPrice: 100 });
    assert.equal(await tryActivateBuildingTrailIfNeeded(l, 101.5), true);
    assert.equal(l.buildingTrailActive, true);
    assert.equal(await tryActivateBuildingTrailIfNeeded(l, 102), false);
  });
});

describe('activateBuildingTrail', () => {
  it('marks trail active and sets peak from activation price', async () => {
    const l = makeLadder({
      side: 'LONG',
      fills: 1,
      posQty: 0.014,
      entryPrice: 100,
      entryOrders: [],
    });
    await activateBuildingTrail(l, 101.6);
    assert.equal(l.buildingTrailActive, true);
    assert.equal(l.buildingPeakPrice, 101.6);
  });
});
