import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCyclePhase,
  cyclePhaseToBotPhase,
  isInTradePhase,
  botPhaseForLadder,
} from '../phases/types';
import { makeLadder } from './helpers';

describe('resolveCyclePhase', () => {
  it('maps DB phases to cycle phases', () => {
    assert.equal(resolveCyclePhase('IDLE', null), 'IDLE');
    assert.equal(resolveCyclePhase('COLLECTING', null), 'COLLECTING');
    assert.equal(resolveCyclePhase('WAITING_ENTRY', makeLadder({ side: null })), 'STRADDLE');
  });

  it('detects BUILDING from ladder state', () => {
    const l = makeLadder({ side: 'SHORT', windingDown: false });
    assert.equal(resolveCyclePhase('BUILDING', l), 'BUILDING');
    assert.equal(resolveCyclePhase('IN_POSITION', l), 'BUILDING');
  });

  it('detects HARVESTING from windingDown or post-partial position', () => {
    const l = makeLadder({ windingDown: true });
    assert.equal(resolveCyclePhase('BUILDING', l), 'HARVESTING');
    assert.equal(resolveCyclePhase('HARVESTING', l), 'HARVESTING');
    const postPartial = makeLadder({ fills: 2, posQty: 0.014, baseQty: 0.014 });
    assert.equal(resolveCyclePhase('BUILDING', postPartial), 'HARVESTING');
  });
});

describe('cyclePhaseToBotPhase', () => {
  it('persists explicit bot phases', () => {
    assert.equal(cyclePhaseToBotPhase('STRADDLE'), 'WAITING_ENTRY');
    assert.equal(cyclePhaseToBotPhase('BUILDING'), 'BUILDING');
    assert.equal(cyclePhaseToBotPhase('HARVESTING'), 'HARVESTING');
  });
});

describe('botPhaseForLadder', () => {
  it('returns WAITING_ENTRY before direction is chosen', () => {
    assert.equal(botPhaseForLadder(makeLadder({ side: null })), 'WAITING_ENTRY');
  });

  it('returns BUILDING when side is set', () => {
    assert.equal(botPhaseForLadder(makeLadder({ side: 'LONG', windingDown: false })), 'BUILDING');
  });

  it('returns HARVESTING after partial', () => {
    assert.equal(botPhaseForLadder(makeLadder({ windingDown: true })), 'HARVESTING');
    assert.equal(botPhaseForLadder(makeLadder({ partialCloses: 1 })), 'HARVESTING');
    assert.equal(
      botPhaseForLadder(makeLadder({ fills: 2, posQty: 0.014, baseQty: 0.014 })),
      'HARVESTING'
    );
  });
});

describe('isInTradePhase', () => {
  it('includes legacy IN_POSITION', () => {
    assert.equal(isInTradePhase('IN_POSITION'), true);
    assert.equal(isInTradePhase('BUILDING'), true);
    assert.equal(isInTradePhase('HARVESTING'), true);
    assert.equal(isInTradePhase('WAITING_ENTRY'), false);
  });
});
