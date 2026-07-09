import {
  HARVEST_BREAKEVEN_BUFFER_PCT,
  HARVEST_TRAIL_MIN_STEP_PCT,
  HARVEST_TRAIL_PCT,
} from '../../bot/config';
import { computeHarvestSlPrice, wouldSlTriggerNow } from '../../bot/phases/exitPricing';

export interface TrailingPosition {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  peakPrice: number;
  stopPrice: number | null;
  slIsCatastrophic?: boolean;
}

export interface TrailingEval {
  shouldUpdate: boolean;
  newPeak: number;
  newStop: number;
}

/** Ratchet peak and decide if the exchange SL should be re-placed. */
export function evaluatePositionTrailing(
  pos: TrailingPosition,
  price: number,
  tickSize: number,
  minStepPct: number = HARVEST_TRAIL_MIN_STEP_PCT,
  trailPct: number = HARVEST_TRAIL_PCT,
  breakevenBufferPct: number = HARVEST_BREAKEVEN_BUFFER_PCT
): TrailingEval {
  const dir = pos.side === 'LONG' ? 1 : -1;
  const base = pos.peakPrice > 0 ? pos.peakPrice : pos.entryPrice;
  const newPeak = dir === 1 ? Math.max(base, price) : Math.min(base, price);
  const newStop = computeHarvestSlPrice(
    pos.side,
    pos.entryPrice,
    newPeak,
    tickSize,
    breakevenBufferPct,
    trailPct
  );

  if (price <= 0) {
    return { shouldUpdate: false, newPeak, newStop };
  }
  if (wouldSlTriggerNow(pos.side, newStop, price, tickSize)) {
    return { shouldUpdate: false, newPeak, newStop };
  }

  const currentSl = pos.stopPrice ?? 0;
  if (currentSl <= 0 || pos.slIsCatastrophic) {
    return { shouldUpdate: true, newPeak, newStop };
  }

  const improvement = (newStop - currentSl) * dir;
  return {
    shouldUpdate: improvement >= pos.entryPrice * minStepPct,
    newPeak,
    newStop,
  };
}
