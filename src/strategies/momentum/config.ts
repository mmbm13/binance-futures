import * as dotenv from 'dotenv';

dotenv.config();

export const MOM_INTERVAL = process.env.MOM_INTERVAL || '1h';
export const MOM_DONCHIAN_PERIOD = Number(process.env.MOM_DONCHIAN_PERIOD || 20);
export const MOM_ATR_PERIOD = Number(process.env.MOM_ATR_PERIOD || 14);
export const MOM_ADX_PERIOD = Number(process.env.MOM_ADX_PERIOD || 14);
export const MOM_ATR_STOP_MULT = Number(process.env.MOM_ATR_STOP_MULT || 2.0);
export const MOM_ATR_TRAIL_MULT = Number(process.env.MOM_ATR_TRAIL_MULT || 3.0);
export const MOM_ADX_MIN = Number(process.env.MOM_ADX_MIN || 20);
/** Skip breakout candles larger than this many ATRs (likely exhaustion). */
export const MOM_MAX_BREAKOUT_ATR = Number(process.env.MOM_MAX_BREAKOUT_ATR || 4);
export const MOM_RISK_PCT = Number(process.env.MOM_RISK_PCT || 0.01);
export const MOM_MAX_CONSECUTIVE_LOSSES = Number(process.env.MOM_MAX_CONSECUTIVE_LOSSES || 6);
export const MOM_PAUSE_HOURS = Number(process.env.MOM_PAUSE_HOURS || 24);
/** Don't open LONG if funding APR > this; don't open SHORT if funding APR < −this. */
export const MOM_FUNDING_VETO_APR = Number(process.env.MOM_FUNDING_VETO_APR || 0.30);
/** Candles kept in the rolling buffer (warm-up fetches this many too). */
export const MOM_BUFFER_SIZE = Number(process.env.MOM_BUFFER_SIZE || 300);
