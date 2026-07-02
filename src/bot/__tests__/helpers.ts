import { LadderState } from '../types';

export function makeLadder(overrides: Partial<LadderState> = {}): LadderState {
  return {
    baseQty: 0.014,
    riskAmount: 0.8,
    buyWalls: [],
    sellWalls: [],
    usedWalls: [],
    side: 'SHORT',
    entryOrders: [],
    fills: 0,
    partialCloses: 0,
    feesPaid: 0,
    entryPrice: 1696,
    posQty: 0.035,
    slAlgoId: null,
    tpClientOrderId: null,
    windingDown: false,
    ladderStep: 1,
    ...overrides,
  };
}
