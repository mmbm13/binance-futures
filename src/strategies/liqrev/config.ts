import * as dotenv from 'dotenv';

dotenv.config();

export const LIQREV_WINDOW_SEC = Number(process.env.LIQREV_WINDOW_SEC || 60);
export const LIQREV_PERCENTILE = Number(process.env.LIQREV_PERCENTILE || 0.99);
export const LIQREV_MIN_NOTIONAL = Number(process.env.LIQREV_MIN_NOTIONAL || 500_000);
export const LIQREV_PRICE_MOVE_ATR = Number(process.env.LIQREV_PRICE_MOVE_ATR || 3);
export const LIQREV_EXHAUST_SEC = Number(process.env.LIQREV_EXHAUST_SEC || 45);
export const LIQREV_ARMED_TTL_MIN = Number(process.env.LIQREV_ARMED_TTL_MIN || 10);
export const LIQREV_RISK_PCT = Number(process.env.LIQREV_RISK_PCT || 0.01);
export const LIQREV_ATR_PERIOD = Number(process.env.LIQREV_ATR_PERIOD || 14);
export const LIQREV_SL_BUFFER_ATR = Number(process.env.LIQREV_SL_BUFFER_ATR || 0.5);
export const LIQREV_TP_RETRACE = Number(process.env.LIQREV_TP_RETRACE || 0.5);
export const LIQREV_TIME_STOP_MIN = Number(process.env.LIQREV_TIME_STOP_MIN || 45);
export const LIQREV_COOLDOWN_MIN = Number(process.env.LIQREV_COOLDOWN_MIN || 30);
export const LIQREV_TICK_THROTTLE_MS = Number(process.env.LIQREV_TICK_THROTTLE_MS || 2_000);
/** Completed 60s windows kept for percentile (~24h at 1/min). */
export const LIQREV_HISTORY_WINDOWS = Number(process.env.LIQREV_HISTORY_WINDOWS || 1440);
