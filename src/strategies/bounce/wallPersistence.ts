export interface WallBucket {
  price: number;
  volume: number;
}

export interface WallSnapshot {
  ts: number;
  currentPrice: number;
  buyWalls: WallBucket[];
  sellWalls: WallBucket[];
}

export interface ScoredZone {
  price: number;
  /** bid = support (long), ask = resistance (short) */
  side: 'bid' | 'ask';
  presence: number;
  avgVolume: number;
  score: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Aggregate per-bucket stats across the collection window. */
export function buildScoredZones(
  samples: WallSnapshot[],
  side: 'bid' | 'ask',
  presenceThreshold: number,
  minVolumeRatio: number,
  maxZones: number
): ScoredZone[] {
  if (samples.length === 0) return [];

  const allVolumes: number[] = [];
  for (const s of samples) {
    for (const w of [...s.buyWalls, ...s.sellWalls]) {
      if (w.volume > 0) allVolumes.push(w.volume);
    }
  }
  const med = median(allVolumes);
  const minVol = med * minVolumeRatio;

  const stats = new Map<number, { count: number; volSum: number }>();

  for (const s of samples) {
    const walls = side === 'bid' ? s.buyWalls : s.sellWalls;
    const seen = new Set<number>();
    for (const w of walls) {
      if (w.volume <= 0) continue;
      if (side === 'bid' && w.price >= s.currentPrice) continue;
      if (side === 'ask' && w.price <= s.currentPrice) continue;
      if (seen.has(w.price)) continue;
      seen.add(w.price);
      const cur = stats.get(w.price) ?? { count: 0, volSum: 0 };
      cur.count += 1;
      cur.volSum += w.volume;
      stats.set(w.price, cur);
    }
  }

  const n = samples.length;
  const zones: ScoredZone[] = [];

  for (const [price, { count, volSum }] of stats) {
    const presence = count / n;
    const avgVolume = volSum / count;
    if (presence < presenceThreshold || avgVolume < minVol) continue;
    zones.push({
      price,
      side,
      presence,
      avgVolume,
      score: presence * avgVolume,
    });
  }

  return zones.sort((a, b) => b.score - a.score).slice(0, maxZones);
}

/** Live volume at the zone price must retain at least `retention` of the measured avg. */
export function zoneVolumeRetained(
  zone: ScoredZone,
  liveWalls: WallBucket[],
  retention: number
): boolean {
  const live = liveWalls.find((w) => w.price === zone.price);
  if (!live) return false;
  return live.volume >= zone.avgVolume * retention;
}

/** Find live volume at the zone bucket (0 if missing). */
export function liveVolumeAtZone(zone: ScoredZone, liveWalls: WallBucket[]): number {
  return liveWalls.find((w) => w.price === zone.price)?.volume ?? 0;
}
