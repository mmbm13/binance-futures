import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countOpenEntryOrders,
  isExitsOnlyPhase,
  isHarvestMode,
  isNearKeepQty,
  isPostPartialPosition,
  repairHarvestState,
} from '../phases/harvestMode';
import { reconcileEntryOrders } from '../exchange';
import { makeLadder } from './helpers';

const STEP = 0.001;

describe('isHarvestMode', () => {
  it('detects harvest from windingDown, partialCloses, or phase', () => {
    assert.equal(isHarvestMode(makeLadder({ windingDown: true })), true);
    assert.equal(isHarvestMode(makeLadder({ partialCloses: 1 })), true);
    assert.equal(isHarvestMode(makeLadder({}), 'HARVESTING'), true);
    assert.equal(isHarvestMode(makeLadder({})), false);
  });

  it('does not harvest on fill 2 with lagging position qty (pre-partial)', () => {
    const l = makeLadder({
      fills: 2,
      posQty: 0.014,
      baseQty: 0.014,
      windingDown: false,
      partialCloses: 0,
    });
    assert.equal(isHarvestMode(l, 'BUILDING', 0.014, 0, STEP), false);
    assert.equal(isHarvestMode(l, 'BUILDING', 0.014, 1, STEP), false);
    assert.equal(repairHarvestState(l, 0.014, 1, STEP), false);
  });

  it('detects exits-only on exchange after repair (0 entry orders, trimmed position)', () => {
    const l = makeLadder({
      fills: 2,
      posQty: 0.014,
      baseQty: 0.014,
      entryOrders: [
        {
          clientOrderId: 'a',
          side: 'SELL',
          price: 1700,
          qty: 0.014,
          status: 'OPEN',
        },
      ],
    });
    assert.equal(isExitsOnlyPhase(l, 0.014, 0, STEP), true);
    assert.equal(isHarvestMode(l, 'BUILDING', 0.014, 0, STEP), false);
    assert.equal(repairHarvestState(l, 0.014, 0, STEP), true);
    assert.equal(isHarvestMode(l, 'BUILDING', 0.014, 0, STEP), true);
  });

  it('does not harvest full position with no open entries', () => {
    const l = makeLadder({ fills: 2, posQty: 0.035, baseQty: 0.014 });
    assert.equal(isExitsOnlyPhase(l, 0.035, 0, STEP), false);
  });
});

describe('isNearKeepQty', () => {
  it('matches keep qty within one step', () => {
    assert.equal(isNearKeepQty(0.014, 0.014, STEP), true);
    assert.equal(isNearKeepQty(0.035, 0.014, STEP), false);
  });
});

describe('repairHarvestState', () => {
  it('restores windingDown when post-partial flags were lost', () => {
    const l = makeLadder({
      fills: 2,
      posQty: 0.014,
      baseQty: 0.014,
      windingDown: false,
      partialCloses: 0,
    });
    assert.equal(repairHarvestState(l, 0.014, 0, STEP), true);
    assert.equal(l.windingDown, true);
    assert.equal(l.partialCloses, 1);
  });

  it('repairs when local OPEN is stale but exchange has no entries', () => {
    const l = makeLadder({
      fills: 2,
      posQty: 0.014,
      baseQty: 0.014,
      windingDown: false,
      partialCloses: 0,
      entryOrders: [
        { clientOrderId: 'gone', side: 'SELL', price: 1710, qty: 0.014, status: 'OPEN' },
      ],
    });
    reconcileEntryOrders(l, []);
    assert.equal(repairHarvestState(l, 0.014, 0, STEP), true);
    assert.equal(l.windingDown, true);
  });

  it('no-op when still building full ladder', () => {
    const l = makeLadder({ fills: 2, posQty: 0.035, windingDown: false });
    assert.equal(repairHarvestState(l, 0.035, 1, STEP), false);
    assert.equal(l.windingDown, false);
  });
});

describe('countOpenEntryOrders', () => {
  it('counts only OPEN entries', () => {
    const l = makeLadder({
      entryOrders: [
        { clientOrderId: 'a', side: 'SELL', price: 1, qty: 1, status: 'FILLED' },
        { clientOrderId: 'b', side: 'SELL', price: 2, qty: 1, status: 'OPEN' },
      ],
    });
    assert.equal(countOpenEntryOrders(l), 1);
  });
});
