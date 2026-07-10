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

function sideVolumes(samples: WallSnapshot[], side: 'bid' | 'ask'): number[] {
  const vols: number[] = [];
  for (const s of samples) {
    const walls = side === 'bid' ? s.buyWalls : s.sellWalls;
    for (const w of walls) {
      if (w.volume > 0) vols.push(w.volume);
    }
  }
  return vols;
}

export interface ZoneBuildDiagnostics {
  samples: number;
  side: 'bid' | 'ask';
  sideMedianVolume: number;
  minVolume: number;
  candidates: number;
  passed: number;
}

/** Aggregate per-bucket stats across the collection window. */
export function buildScoredZones(
  samples: WallSnapshot[],
  side: 'bid' | 'ask',
  presenceThreshold: number,
  minVolumeRatio: number,
  maxZones: number,
  diagnostics?: ZoneBuildDiagnostics
): ScoredZone[] {
  if (samples.length === 0) return [];

  const sideVols = sideVolumes(samples, side);
  const med = median(sideVols);
  const minVol = med > 0 ? med * minVolumeRatio : 0;

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
  const persistentStats = [...stats.entries()].filter(([, { count }]) => count / n >= presenceThreshold);
  const maxAvgAmongPersistent = Math.max(
    0,
    ...persistentStats.map(([, { count, volSum }]) => volSum / count)
  );

  for (const [price, { count, volSum }] of stats) {
    const presence = count / n;
    const avgVolume = volSum / count;
    const isDominantLeader =
      presence >= presenceThreshold && avgVolume + 1e-9 >= maxAvgAmongPersistent * 0.95;
    const passesVolume = avgVolume + 1e-9 >= minVol || isDominantLeader;
    if (presence < presenceThreshold || !passesVolume) continue;
    zones.push({
      price,
      side,
      presence,
      avgVolume,
      score: presence * avgVolume,
    });
  }

  const ranked = zones.sort((a, b) => b.score - a.score).slice(0, maxZones);
  if (diagnostics) {
    diagnostics.samples = n;
    diagnostics.side = side;
    diagnostics.sideMedianVolume = med;
    diagnostics.minVolume = minVol;
    diagnostics.candidates = stats.size;
    diagnostics.passed = ranked.length;
  }
  return ranked;
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
