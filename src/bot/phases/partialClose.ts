import {
  MIN_PARTIAL_PROFIT_FLOOR,
  MIN_PARTIAL_PROFIT_RATIO,
  TAKER_FEE,
} from '../config';
import { floorStep } from '../math';
import { LadderState } from '../types';

export interface PartialCloseEvaluation {
  shouldClose: boolean;
  keepQty?: number;
  closeQty?: number;
  unrealized?: number;
  feeThreshold?: number;
  profitThreshold?: number;
  minPartialProfit?: number;
  reason?: string;
}

export interface PartialCloseInput {
  ladder: LadderState;
  price: number;
  stepSize: number;
  minQty: number;
  takerFee?: number;
  minPartialProfitRatio?: number;
  minPartialProfitFloor?: number;
}

/** Scales with account size via riskAmount; optional absolute floor for tiny balances. */
export function resolveMinPartialProfit(
  riskAmount: number,
  ratio = MIN_PARTIAL_PROFIT_RATIO,
  floor = MIN_PARTIAL_PROFIT_FLOOR
): number {
  if (!Number.isFinite(riskAmount) || riskAmount <= 0) return floor;
  return Math.max(floor, riskAmount * ratio);
}

export function evaluatePartialClose(input: PartialCloseInput): PartialCloseEvaluation {
  const {
    ladder: l,
    price,
    stepSize,
    minQty,
    takerFee = TAKER_FEE,
    minPartialProfitRatio = MIN_PARTIAL_PROFIT_RATIO,
    minPartialProfitFloor = MIN_PARTIAL_PROFIT_FLOOR,
  } = input;

  if (!l.side || l.windingDown || !price) {
    return { shouldClose: false, reason: 'not_eligible' };
  }
  if (l.fills < 2) {
    return { shouldClose: false, reason: 'insufficient_fills' };
  }
  if (l.partialCloses >= l.fills - 1) {
    return { shouldClose: false, reason: 'partial_limit_reached' };
  }
  if (l.posQty <= 0 || l.entryPrice <= 0) {
    return { shouldClose: false, reason: 'no_position' };
  }

  const keepQty = floorStep(l.baseQty, stepSize);
  const closeQty = floorStep(l.posQty - keepQty, stepSize);
  if (closeQty < minQty || l.posQty <= keepQty) {
    return { shouldClose: false, reason: 'already_at_base_qty' };
  }

  const dir = l.side === 'LONG' ? 1 : -1;
  const unrealized = (price - l.entryPrice) * l.posQty * dir;
  const estExitFees = closeQty * price * takerFee;
  const feeThreshold = l.feesPaid + estExitFees;
  const minPartialProfit = resolveMinPartialProfit(
    l.riskAmount,
    minPartialProfitRatio,
    minPartialProfitFloor
  );
  const profitThreshold = feeThreshold + minPartialProfit;

  if (unrealized <= feeThreshold) {
    return {
      shouldClose: false,
      reason: 'unrealized_below_fees',
      unrealized,
      feeThreshold,
      profitThreshold,
      minPartialProfit,
    };
  }

  if (unrealized <= profitThreshold) {
    return {
      shouldClose: false,
      reason: 'unrealized_below_min_profit',
      unrealized,
      feeThreshold,
      profitThreshold,
      minPartialProfit,
    };
  }

  return {
    shouldClose: true,
    keepQty,
    closeQty,
    unrealized,
    feeThreshold,
    profitThreshold,
    minPartialProfit,
  };
}
