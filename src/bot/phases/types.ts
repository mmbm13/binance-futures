import { BotPhase } from '../state';
import { LadderState } from '../types';
import { isHarvestMode } from './harvestMode';

/** Explicit cycle phases — each maps to a distinct handler module. */
export type CyclePhase =
  | 'IDLE'
  | 'COLLECTING'
  | 'STRADDLE'
  | 'BUILDING'
  | 'HARVESTING'
  | 'EXITING';

export function resolveCyclePhase(botPhase: BotPhase, ladder: LadderState | null): CyclePhase {
  if (botPhase === 'IDLE') return 'IDLE';
  if (botPhase === 'COLLECTING') return 'COLLECTING';
  if (botPhase === 'WAITING_ENTRY') return 'STRADDLE';
  if (botPhase === 'HARVESTING' || (ladder && isHarvestMode(ladder, botPhase))) return 'HARVESTING';
  if (botPhase === 'BUILDING' || botPhase === 'IN_POSITION') return 'BUILDING';
  return 'IDLE';
}

export function cyclePhaseToBotPhase(phase: CyclePhase): BotPhase {
  switch (phase) {
    case 'IDLE':
      return 'IDLE';
    case 'COLLECTING':
      return 'COLLECTING';
    case 'STRADDLE':
      return 'WAITING_ENTRY';
    case 'BUILDING':
      return 'BUILDING';
    case 'HARVESTING':
    case 'EXITING':
      return 'HARVESTING';
  }
}

export function isInTradePhase(phase: BotPhase): boolean {
  return phase === 'BUILDING' || phase === 'HARVESTING' || phase === 'IN_POSITION';
}

export function botPhaseForLadder(ladder: LadderState): BotPhase {
  if (isHarvestMode(ladder)) return 'HARVESTING';
  if (ladder.side) return 'BUILDING';
  return 'WAITING_ENTRY';
}
