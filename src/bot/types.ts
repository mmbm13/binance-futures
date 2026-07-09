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
  /** Trigger price of the SL currently on the exchange (null when no SL placed). */
  slPrice?: number | null;
  /** True when the active SL is the wide catastrophic backstop, not the normal SL. */
  slIsCatastrophic?: boolean;
  /** Best favorable price since harvest began (drives trailing SL). */
  harvestPeakPrice?: number;
  /** True after first-fill building trail arms (fixed TP removed, trailing SL active). */
  buildingTrailActive?: boolean;
  /** Best favorable price since building trail activation. */
  buildingPeakPrice?: number;
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
