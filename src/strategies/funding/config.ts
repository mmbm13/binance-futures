import * as dotenv from 'dotenv';

dotenv.config();

export const FUNDING_SYMBOL = process.env.FUNDING_SYMBOL || process.env.SYMBOL || 'ETHUSDT';
export const FUNDING_ENTRY_APR = Number(process.env.FUNDING_ENTRY_APR || 0.15);
export const FUNDING_EXIT_APR = Number(process.env.FUNDING_EXIT_APR || 0.05);
export const FUNDING_ENTRY_WINDOWS = Number(process.env.FUNDING_ENTRY_WINDOWS || 2);
export const FUNDING_EXIT_WINDOWS = Number(process.env.FUNDING_EXIT_WINDOWS || 3);
export const FUNDING_NOTIONAL_PCT = Number(process.env.FUNDING_NOTIONAL_PCT || 0.5);
export const FUNDING_MAX_LEVERAGE = Number(process.env.FUNDING_MAX_LEVERAGE || 2);
export const FUNDING_REBALANCE_DRIFT = Number(process.env.FUNDING_REBALANCE_DRIFT || 0.02);
export const FUNDING_EVAL_MINUTES = Number(process.env.FUNDING_EVAL_MINUTES || 15);
export const FUNDING_HOURLY_MINUTES = Number(process.env.FUNDING_HOURLY_MINUTES || 60);
export const FUNDING_MARGIN_REDUCE_RATIO = Number(process.env.FUNDING_MARGIN_REDUCE_RATIO || 0.25);
export const FUNDING_MARGIN_WARN_RATIO = Number(process.env.FUNDING_MARGIN_WARN_RATIO || 0.5);
/** Estimated hold for pre-entry fee gate (days). */
export const FUNDING_MIN_HOLD_DAYS = Number(process.env.FUNDING_MIN_HOLD_DAYS || 7);
/** Four taker legs (open/close perp + spot). */
export const FUNDING_CYCLE_FEE_LEGS = Number(process.env.FUNDING_CYCLE_FEE_LEGS || 4);
