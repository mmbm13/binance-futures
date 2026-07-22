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
/** When true, after the first fill hits activation %, replace fixed TP with a trailing SL. */
export const BUILDING_TRAIL_ENABLED = process.env.BUILDING_TRAIL_ENABLED !== 'false';
/** Favorable move from entry that arms building trail (default = BUILDING_TP_MAX_PCT). */
export const BUILDING_TRAIL_ACTIVATION_PCT = Number(
  process.env.BUILDING_TRAIL_ACTIVATION_PCT || BUILDING_TP_MAX_PCT
);
/** Minimum locked profit floor for building trail SL (default = activation). */
export const BUILDING_TRAIL_FLOOR_PCT = Number(
  process.env.BUILDING_TRAIL_FLOOR_PCT || BUILDING_TRAIL_ACTIVATION_PCT
);
/** Harvest SL floor: breakeven ± buffer (covers round-trip fees). */
export const HARVEST_BREAKEVEN_BUFFER_PCT = Number(process.env.HARVEST_BREAKEVEN_BUFFER_PCT || 0.001);
/** Harvest trailing SL distance from the best favorable price since harvest began. */
export const HARVEST_TRAIL_PCT = Number(process.env.HARVEST_TRAIL_PCT || 0.0075);
/** Re-place the trailing SL only when it improves by at least this fraction of entry. */
export const HARVEST_TRAIL_MIN_STEP_PCT = Number(process.env.HARVEST_TRAIL_MIN_STEP_PCT || 0.001);
/** Trailing SL distance from the best favorable price since building trail activation. */
export const BUILDING_TRAIL_PCT = Number(process.env.BUILDING_TRAIL_PCT || HARVEST_TRAIL_PCT);
/** Re-place building trail SL only when it improves by at least this fraction of entry. */
export const BUILDING_TRAIL_MIN_STEP_PCT = Number(
  process.env.BUILDING_TRAIL_MIN_STEP_PCT || HARVEST_TRAIL_MIN_STEP_PCT
);
/** Min ms between trail ratchet / partial-close evaluations (activation uses every WS tick). */
export const TRAIL_EVAL_INTERVAL_MS = Number(process.env.TRAIL_EVAL_INTERVAL_MS || 1_000);
/** Catastrophic backstop SL distance as multiple of riskAmount (always on exchange when normal SL is skipped). */
export const CATASTROPHIC_SL_MULT = Number(process.env.CATASTROPHIC_SL_MULT || 2.0);
/** Min net profit as fraction of cycle risk (riskAmount) before partial close. */
export const MIN_PARTIAL_PROFIT_RATIO = Number(process.env.MIN_PARTIAL_PROFIT_RATIO || 0.20);
/** Absolute floor (USDT) so tiny accounts still have a minimum bar. */
export const MIN_PARTIAL_PROFIT_FLOOR = Number(process.env.MIN_PARTIAL_PROFIT_FLOOR || 0.05);
export const MAKER_FEE = Number(process.env.MAKER_FEE || 0.0002);
export const TAKER_FEE = Number(process.env.TAKER_FEE || 0.0005);
export const NOTIONAL_MULTIPLIER = Number(process.env.NOTIONAL_MULTIPLIER || 1.0);
export const MIN_LADDER_SPACING_PCT = Number(process.env.MIN_LADDER_SPACING_PCT || 0.005);
export const MAX_LADDER_SPACING_PCT = Number(process.env.MAX_LADDER_SPACING_PCT || 0.01);
/** Min gap between deepest ladder rung and building SL as a fraction of deepest price (0.005 = 0.5%). */
export const MIN_SL_GAP_PCT = Number(process.env.MIN_SL_GAP_PCT || 0.005);

export const SIZE_MULTIPLIERS = Array.from(
  { length: LADDER_LEVELS },
  (_, i) => Math.pow(LADDER_SIZE_MULT, i)
);
export const SIZE_MULT_SUM = SIZE_MULTIPLIERS.reduce((a, b) => a + b, 0);

export function validateConfig(): void {
  if (LADDER_LEVELS < 2) throw new Error(`LADDER_LEVELS must be >= 2 (got ${LADDER_LEVELS})`);
  if (LADDER_SIZE_MULT <= 1) throw new Error(`LADDER_SIZE_MULT must be > 1 (got ${LADDER_SIZE_MULT})`);
  if (SIZE_MULT_SUM <= 0) throw new Error('Invalid ladder sizing configuration');
  if (!(MIN_SL_GAP_PCT > 0) || MIN_SL_GAP_PCT >= 1) {
    throw new Error(`MIN_SL_GAP_PCT must be in (0, 1) (got ${MIN_SL_GAP_PCT})`);
  }
}

validateConfig();
