export { computeEntryQty } from '../bounce/rules';
export {
  computeLiqRevStops,
  type TradeSide,
  type CascadeDirection,
} from './cascadeDetector';

/** True when position exceeded the time-stop horizon. */
export function isTimeStopDue(openedAt: number | null, timeStopMin: number, now = Date.now()): boolean {
  if (!openedAt) return false;
  return now - openedAt >= timeStopMin * 60_000;
}

export function isCooldownActive(cooldownUntil: number | null, now = Date.now()): boolean {
  return cooldownUntil !== null && now < cooldownUntil;
}

export function isArmedExpired(armedAt: number, ttlMin: number, now = Date.now()): boolean {
  return now - armedAt >= ttlMin * 60_000;
}
