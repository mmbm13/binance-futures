import * as dotenv from 'dotenv';

dotenv.config();

export const SYMBOL = process.env.SYMBOL || 'ETHUSDT';
export const LEVERAGE = Number(process.env.LEVERAGE || 10);
export const COLLECT_MINUTES = Number(process.env.ORDERBOOK_COLLECT_MINUTES || 10);
export const BUCKET_SIZE = Number(process.env.ORDERBOOK_BUCKET_SIZE || 10);
export const LADDER_LEVELS = Number(process.env.LADDER_LEVELS || 3);
export const LADDER_SIZE_MULT = Number(process.env.LADDER_SIZE_MULT || 1.3);
export const WALLS_TO_KEEP = Number(process.env.WALLS_TO_KEEP || 10);
export const ACCOUNT_RISK_PERCENT = Number(process.env.ACCOUNT_RISK_PERCENT || 0.01);
export const TP_REWARD_RATIO = Number(process.env.TP_REWARD_RATIO || 1.5);
/** Symmetric % exits in HARVESTING (TP and SL distance from entry). */
const _harvestExitPct = Number(process.env.HARVEST_EXIT_PCT || 0.015);
export const HARVEST_TP_MAX_PCT = Number(process.env.HARVEST_TP_MAX_PCT || _harvestExitPct);
export const HARVEST_SL_MAX_PCT = Number(process.env.HARVEST_SL_MAX_PCT || _harvestExitPct);
/** Max TP distance from entry in BUILDING (caps $-symmetric TP when qty is small). */
export const BUILDING_TP_MAX_PCT = Number(process.env.BUILDING_TP_MAX_PCT || _harvestExitPct);
/** Min net profit as fraction of cycle risk (riskAmount) before partial close. */
export const MIN_PARTIAL_PROFIT_RATIO = Number(process.env.MIN_PARTIAL_PROFIT_RATIO || 0.20);
/** Absolute floor (USDT) so tiny accounts still have a minimum bar. */
export const MIN_PARTIAL_PROFIT_FLOOR = Number(process.env.MIN_PARTIAL_PROFIT_FLOOR || 0.05);
export const MAKER_FEE = Number(process.env.MAKER_FEE || 0.0002);
export const TAKER_FEE = Number(process.env.TAKER_FEE || 0.0005);
export const NOTIONAL_MULTIPLIER = Number(process.env.NOTIONAL_MULTIPLIER || 1.0);
export const MIN_LADDER_SPACING_PCT = Number(process.env.MIN_LADDER_SPACING_PCT || 0.005);
export const MAX_LADDER_SPACING_PCT = Number(process.env.MAX_LADDER_SPACING_PCT || 0.01);
/** Min ticks between deepest ladder rung and building SL (avoids SL on same price as last order). */
export const MIN_SL_GAP_TICKS = Number(process.env.MIN_SL_GAP_TICKS || 5);

export const SIZE_MULTIPLIERS = Array.from(
  { length: LADDER_LEVELS },
  (_, i) => Math.pow(LADDER_SIZE_MULT, i)
);
export const SIZE_MULT_SUM = SIZE_MULTIPLIERS.reduce((a, b) => a + b, 0);

export function validateConfig(): void {
  if (LADDER_LEVELS < 2) throw new Error(`LADDER_LEVELS must be >= 2 (got ${LADDER_LEVELS})`);
  if (LADDER_SIZE_MULT <= 1) throw new Error(`LADDER_SIZE_MULT must be > 1 (got ${LADDER_SIZE_MULT})`);
  if (SIZE_MULT_SUM <= 0) throw new Error('Invalid ladder sizing configuration');
}

validateConfig();
