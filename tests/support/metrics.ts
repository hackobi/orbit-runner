// Calculators for the pass thresholds. The virtual-time tests and the
// Playwright suite both use these, so a number means the same thing in both.

export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

export function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export interface BulletKey {
  ownerId: number;
  spawnTick: number;
  targetId: number;
}

const keyOf = (hit: BulletKey): string => `${hit.ownerId}:${hit.spawnTick}:${hit.targetId}`;

/**
 * Of the hits a shooter saw on its own screen, the share the server also
 * decided were hits, joined by bullet and target.
 */
export function hitAgreement(
  viewHits: readonly BulletKey[],
  serverHits: readonly BulletKey[],
): { seen: number; confirmed: number; unseen: number; agreement: number } {
  const server = new Set(serverHits.map(keyOf));
  const view = new Set(viewHits.map(keyOf));
  let confirmed = 0;
  for (const key of view) if (server.has(key)) confirmed++;
  let unseen = 0;
  for (const key of server) if (!view.has(key)) unseen++;
  return { seen: view.size, confirmed, unseen, agreement: view.size ? confirmed / view.size : 1 };
}

/**
 * The no-snap rule: between two frames a drawn ship may move at most
 * `factor` times what its speed limit allows in that real time. Returns how
 * far over the limit it went (0 or less means within it).
 */
export function snapExcess(
  moved: number,
  elapsedMs: number,
  speedLimit: number,
  factor: number,
): number {
  return moved - factor * speedLimit * (elapsedMs / 1000);
}
