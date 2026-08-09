/** Money helpers. Costs are computed in integer micro-USD to avoid float drift, then rounded for storage. */

export function microsToUsd(micros: number): number {
  return Math.round(micros) / 1_000_000;
}

export function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
