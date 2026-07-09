import { MAKER_FEE, TAKER_FEE } from '../bot/config';
import { floorStep } from '../bot/math';
import { logger } from '../utils/logger';

export interface SpotPaperState {
  usdtBalance: number;
  assetQty: number;
  feesPaid: number;
}

/** Simulated spot wallet for delta-neutral paper runs. */
export class SpotPaperWallet {
  private s: SpotPaperState;

  constructor(
    initialUsdt = Number(process.env.PAPER_INITIAL_BALANCE || 1000),
    private readonly takerFee = TAKER_FEE,
    private readonly makerFee = MAKER_FEE
  ) {
    this.s = { usdtBalance: initialUsdt, assetQty: 0, feesPaid: 0 };
  }

  toJSON(): SpotPaperState {
    return { ...this.s };
  }

  restore(state: SpotPaperState): void {
    this.s = { ...state };
  }

  get assetQty(): number {
    return this.s.assetQty;
  }

  get usdtBalance(): number {
    return this.s.usdtBalance;
  }

  get feesPaid(): number {
    return this.s.feesPaid;
  }

  /** MARKET buy at ask. */
  buyMarket(qty: number, ask: number): { ok: boolean; reason?: string } {
    if (qty <= 0 || ask <= 0) return { ok: false, reason: 'invalid_inputs' };
    const cost = qty * ask;
    const fee = cost * this.takerFee;
    if (cost + fee > this.s.usdtBalance) return { ok: false, reason: 'insufficient_usdt' };
    this.s.usdtBalance -= cost + fee;
    this.s.assetQty += qty;
    this.s.feesPaid += fee;
    return { ok: true };
  }

  /** MARKET sell at bid. */
  sellMarket(qty: number, bid: number): { ok: boolean; reason?: string } {
    const sellQty = Math.min(qty, this.s.assetQty);
    if (sellQty <= 0 || bid <= 0) return { ok: false, reason: 'no_asset' };
    const proceeds = sellQty * bid;
    const fee = proceeds * this.takerFee;
    this.s.assetQty -= sellQty;
    this.s.usdtBalance += proceeds - fee;
    this.s.feesPaid += fee;
    return { ok: true };
  }

  /** Accrue funding income to USDT (short perp receives when rate > 0). */
  accrueFunding(notional: number, rate8h: number): void {
    if (notional <= 0 || rate8h === 0) return;
    const payment = notional * rate8h;
    this.s.usdtBalance += payment;
    logger.debug('[SpotPaper] Funding accrual', { payment, rate8h, notional });
  }
}

export function computeCombinedPaperBalance(
  futuresUsdt: number,
  spotUsdt: number,
  assetQty: number,
  markPrice: number
): number {
  return futuresUsdt + spotUsdt + assetQty * markPrice;
}
