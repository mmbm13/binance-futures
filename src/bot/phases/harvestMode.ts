import { floorStep } from '../math';
import { LadderState } from '../types';
import { BotPhase } from '../state';

export function countOpenEntryOrders(ladder: LadderState): number {
  return ladder.entryOrders.filter((o) => o.status === 'OPEN').length;
}

/** Trimmed position qty after partial (≈ 1× baseQty). */
export function isNearKeepQty(posQty: number, baseQty: number, stepSize: number): boolean {
  if (posQty <= 0 || baseQty <= 0) return false;
  const keep = floorStep(baseQty, stepSize);
  return posQty <= keep + stepSize * 1.5;
}

/** True only after an actual partial close (not merely fills>=2 with small-looking qty). */
export function isPostPartialPosition(
  ladder: LadderState,
  posQty?: number,
  stepSize?: number
): boolean {
  if (ladder.partialCloses <= 0 && !ladder.windingDown) return false;
  const qty = posQty ?? ladder.posQty;
  if (qty <= 0 || ladder.baseQty <= 0) return false;
  if (stepSize !== undefined) {
    return isNearKeepQty(qty, ladder.baseQty, stepSize);
  }
  return qty <= ladder.baseQty * 1.1;
}

/** No entry orders on exchange, trimmed position — only SL/TP remain (post-partial). */
export function isExitsOnlyPhase(
  ladder: LadderState,
  posQty: number,
  exchangeEntryCount: number,
  stepSize?: number
): boolean {
  if (!ladder.side || posQty <= 0 || ladder.fills < 2 || exchangeEntryCount > 0) {
    return false;
  }
  return isNearKeepQty(posQty, ladder.baseQty, stepSize ?? 0.001);
}

/** True when remainder should use harvest exits (symmetric %), not building SL. */
export function isHarvestMode(
  ladder: LadderState,
  botPhase?: BotPhase,
  posQty?: number,
  _exchangeEntryCount?: number,
  stepSize?: number
): boolean {
  const qty = posQty ?? ladder.posQty;
  return (
    ladder.windingDown ||
    ladder.partialCloses > 0 ||
    botPhase === 'HARVESTING' ||
    isPostPartialPosition(ladder, qty, stepSize)
  );
}

/**
 * Repair ladder flags after a partial close that failed mid-transition
 * (e.g. phase stuck at BUILDING, windingDown not persisted).
 */
export function repairHarvestState(
  ladder: LadderState,
  posQty?: number,
  exchangeEntryCount?: number,
  stepSize?: number
): boolean {
  const qty = posQty ?? ladder.posQty;
  const exchangeOpen = exchangeEntryCount ?? countOpenEntryOrders(ladder);

  // Never infer harvest while ladder entry limits are still open on the exchange.
  if (exchangeOpen > 0) return false;

  const shouldHarvest =
    ladder.partialCloses > 0 || isExitsOnlyPhase(ladder, qty, exchangeOpen, stepSize);

  if (!shouldHarvest) return false;

  if (!ladder.windingDown) {
    ladder.windingDown = true;
  }
  if (ladder.partialCloses === 0) {
    ladder.partialCloses = 1;
  }
  ladder.ladderSizingBlocked = false;
  return true;
}
