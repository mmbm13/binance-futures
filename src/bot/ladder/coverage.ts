import { LADDER_LEVELS } from '../config';
import { LadderState } from '../types';
import { activeEntrySide } from './spacing';

export function effectiveLadderLevels(ladder: LadderState): number {
  return ladder.ladderLevels ?? LADDER_LEVELS;
}

/** Levels covered for placement; after partial close only ladderStep counts, not old fills. */
export function getLadderCoverage(
  l: LadderState,
  filledOnSide: number,
  openOnSide: number
): number {
  if (l.posQty > 0 && l.posQty <= l.baseQty * 1.05 && filledOnSide > l.ladderStep) {
    return l.ladderStep + openOnSide;
  }
  return filledOnSide + openOnSide;
}

export function computeSlotsRemaining(
  l: LadderState,
  filledOnSide: number,
  openOnSide: number,
  ladderLevels: number
): number {
  return ladderLevels - getLadderCoverage(l, filledOnSide, openOnSide);
}

export function shouldTopUpLadder(
  l: LadderState,
  filledOnSide: number,
  openOnSide: number,
  ladderLevels: number
): boolean {
  if (l.windingDown || l.ladderSizingBlocked) return false;
  if (l.posQty > 0 && l.baseQty > 0 && l.fills >= 2 && l.posQty <= l.baseQty * 1.1) {
    return false;
  }
  return getLadderCoverage(l, filledOnSide, openOnSide) < ladderLevels;
}

export function countFilledOnSide(l: LadderState, entrySide: 'BUY' | 'SELL'): number {
  return l.entryOrders.filter((o) => o.side === entrySide && o.status === 'FILLED').length;
}

export function countOpenOnSide(l: LadderState, entrySide: 'BUY' | 'SELL'): number {
  return l.entryOrders.filter((o) => o.side === entrySide && o.status === 'OPEN').length;
}

/** All planned ladder rungs filled — partial close / harvest eligibility. */
export function isLadderFullyFilled(
  ladder: LadderState,
  ladderLevels: number = LADDER_LEVELS
): boolean {
  if (!ladder.side) return false;
  const entrySide = activeEntrySide(ladder.side);
  const filled = countFilledOnSide(ladder, entrySide);
  const target = ladder.ladderSizingBlocked ? Math.min(2, ladderLevels) : ladderLevels;
  return filled >= target;
}

/** All ladder entry limits placed (OPEN and/or FILLED) — SL may be sent to exchange. */
export function isLadderFullyPlaced(
  ladder: LadderState,
  ladderLevels: number = LADDER_LEVELS
): boolean {
  if (!ladder.side) return false;
  const entrySide = activeEntrySide(ladder.side);
  const placed = countFilledOnSide(ladder, entrySide) + countOpenOnSide(ladder, entrySide);
  const target = ladder.ladderSizingBlocked ? Math.min(2, ladderLevels) : ladderLevels;
  return placed >= target;
}

export function countPlacedOnSide(ladder: LadderState, entrySide: 'BUY' | 'SELL'): number {
  return countFilledOnSide(ladder, entrySide) + countOpenOnSide(ladder, entrySide);
}
