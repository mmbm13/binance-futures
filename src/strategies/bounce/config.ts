import * as dotenv from 'dotenv';

dotenv.config();

export const BOUNCE_COLLECT_MINUTES = Number(process.env.BOUNCE_COLLECT_MINUTES || 10);
export const BOUNCE_SAMPLE_INTERVAL_SEC = Number(process.env.BOUNCE_SAMPLE_INTERVAL_SEC || 10);
export const BOUNCE_BUCKET_SIZE = Number(process.env.BOUNCE_BUCKET_SIZE || process.env.ORDERBOOK_BUCKET_SIZE || 10);
export const BOUNCE_WALLS_TO_KEEP = Number(process.env.BOUNCE_WALLS_TO_KEEP || process.env.WALLS_TO_KEEP || 10);
export const BOUNCE_MAX_ZONES_PER_SIDE = Number(process.env.BOUNCE_MAX_ZONES_PER_SIDE || 3);

export const BOUNCE_WALL_PRESENCE = Number(process.env.BOUNCE_WALL_PRESENCE || 0.7);
/** Min avg volume vs median of same-side walls (3 was too strict on ETH — nothing passed). */
export const BOUNCE_WALL_MIN_RATIO = Number(process.env.BOUNCE_WALL_MIN_RATIO || 1.5);
export const BOUNCE_ZONE_TOUCH_PCT = Number(process.env.BOUNCE_ZONE_TOUCH_PCT || 0.001);
export const BOUNCE_CONFIRM_REBOUND_PCT = Number(process.env.BOUNCE_CONFIRM_REBOUND_PCT || 0.0015);
export const BOUNCE_CONFIRM_CVD = process.env.BOUNCE_CONFIRM_CVD !== 'false';
export const BOUNCE_ZONE_RETENTION = Number(process.env.BOUNCE_ZONE_RETENTION || 0.5);

export const BOUNCE_RISK_PCT = Number(process.env.BOUNCE_RISK_PCT || 0.01);
export const BOUNCE_ATR_PERIOD = Number(process.env.BOUNCE_ATR_PERIOD || 14);
export const BOUNCE_SL_ATR_BUFFER = Number(process.env.BOUNCE_SL_ATR_BUFFER || 0.5);
export const BOUNCE_BREAKEVEN_TRIGGER_PCT = Number(process.env.BOUNCE_BREAKEVEN_TRIGGER_PCT || 0.0075);

export const BOUNCE_MAX_ADDS = Number(process.env.BOUNCE_MAX_ADDS || 2);
export const BOUNCE_ADD_TRIGGER_R = Number(process.env.BOUNCE_ADD_TRIGGER_R || 0.5);
export const BOUNCE_ADD_SIZE_RATIO = Number(process.env.BOUNCE_ADD_SIZE_RATIO || 0.5);
export const BOUNCE_SETUP_TTL_MIN = Number(process.env.BOUNCE_SETUP_TTL_MIN || 30);
export const BOUNCE_LIMIT_FILL_SEC = Number(process.env.BOUNCE_LIMIT_FILL_SEC || 10);

export const BOUNCE_TICK_THROTTLE_MS = Number(process.env.BOUNCE_TICK_THROTTLE_MS || 5_000);
