export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function trueRanges(candles: Candle[]): number[] {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(
      Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    );
  }
  return trs;
}

/** Average True Range with Wilder smoothing. Null until period+1 candles exist. */
export function atr(candles: Candle[], period = 14): number | null {
  if (period < 1 || candles.length < period + 1) return null;
  const trs = trueRanges(candles);
  let value = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    value = (value * (period - 1) + trs[i]) / period;
  }
  return value;
}

/** Highest high of the last `period` candles, EXCLUDING the most recent one. */
export function donchianHigh(candles: Candle[], period = 20): number | null {
  if (candles.length < period + 1) return null;
  const window = candles.slice(-period - 1, -1);
  return Math.max(...window.map((c) => c.high));
}

/** Lowest low of the last `period` candles, EXCLUDING the most recent one. */
export function donchianLow(candles: Candle[], period = 20): number | null {
  if (candles.length < period + 1) return null;
  const window = candles.slice(-period - 1, -1);
  return Math.min(...window.map((c) => c.low));
}

/**
 * Average Directional Index (Wilder). Needs at least 2×period+1 candles.
 * High values (>25) = trending market; low values (<20) = chop.
 */
export function adx(candles: Candle[], period = 14): number | null {
  if (period < 1 || candles.length < 2 * period + 1) return null;

  const dmPlus: number[] = [];
  const dmMinus: number[] = [];
  const trs = trueRanges(candles);

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
    dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder smoothed sums (first value = plain sum of the first `period`)
  const smooth = (arr: number[]): number[] => {
    const out: number[] = [];
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(sum);
    for (let i = period; i < arr.length; i++) {
      sum = sum - sum / period + arr[i];
      out.push(sum);
    }
    return out;
  };

  const smTr = smooth(trs);
  const smPlus = smooth(dmPlus);
  const smMinus = smooth(dmMinus);

  const dxs: number[] = [];
  for (let i = 0; i < smTr.length; i++) {
    if (smTr[i] === 0) {
      dxs.push(0);
      continue;
    }
    const diPlus = (100 * smPlus[i]) / smTr[i];
    const diMinus = (100 * smMinus[i]) / smTr[i];
    const sum = diPlus + diMinus;
    dxs.push(sum === 0 ? 0 : (100 * Math.abs(diPlus - diMinus)) / sum);
  }

  if (dxs.length < period) return null;
  let value = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    value = (value * (period - 1) + dxs[i]) / period;
  }
  return value;
}
