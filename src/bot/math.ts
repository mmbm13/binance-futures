export function roundStep(value: number, step: number): number {
  if (step === 0) return value;
  const inv = 1.0 / step;
  return Math.round(value * inv) / inv;
}

export function floorStep(value: number, step: number): number {
  if (step === 0) return value;
  const inv = 1.0 / step;
  return Math.floor(value * inv) / inv;
}

export function ceilStep(value: number, step: number): number {
  if (step === 0) return value;
  const inv = 1.0 / step;
  return Math.ceil(value * inv) / inv;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
