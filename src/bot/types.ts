import { Wall } from './orderbook';

export interface EntryOrder {
  clientOrderId: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  status: 'OPEN' | 'FILLED' | 'CANCELED';
}

export interface LadderState {
  baseQty: number;
  riskAmount: number;
  buyWalls: Wall[];
  sellWalls: Wall[];
  usedWalls: number[];
  side: 'LONG' | 'SHORT' | null;
  entryOrders: EntryOrder[];
  fills: number;
  partialCloses: number;
  feesPaid: number;
  entryPrice: number;
  posQty: number;
  slAlgoId: number | null;
  tpClientOrderId: string | null;
  windingDown: boolean;
  ladderStep: number;
  /** Set when risk-sized ladder cannot place more levels (account too small). */
  ladderSizingBlocked?: boolean;
  /** Effective rung count after risk/geometry resolution (defaults to config LADDER_LEVELS). */
  ladderLevels?: number;
}

export interface PositionSnapshot {
  qty: number;
  entry: number;
  side: 'LONG' | 'SHORT' | null;
}

export interface SymbolPrecision {
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}
