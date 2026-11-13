// Every number the shared simulation depends on. Client and server must agree
// on all of them, so a hash of this object is part of the fingerprint the
// handshake compares (sim/fingerprint.ts).
//
// "main.js:N" is the line in v1 (branch feature/multiplayer-pvp, commit
// 42757f5) the value was read from. Values with no reference are new in v2
// and are explained in docs/DECISIONS.md.

export const TICK_RATE = 60;

export const SIM = {
  tickRate: TICK_RATE,

  // Flight
  startSpeed: 20, // main.js:4471
  minSpeed: 5, // main.js:4473
  maxSpeed: 60, // main.js:4474
  boostMultiplier: 3.08, // main.js:8702
  throttleRate: 22, // units/s² applied to the target speed, main.js:8713
  speedFollow: 6, // per second, main.js:8725
  speedFollowBoost: 10, // per second while boosting, main.js:8725
  yawRate: 2.0, // rad/s, main.js:4476
  pitchRate: 1.35, // rad/s, main.js:4477
  pitchLimitMargin: 0.05, // pitch stays within ±(π/2 − margin), main.js:8772
  bankPerYaw: 0.9, // main.js:8787
  bankLimit: 0.7, // rad, main.js:8788
  bankFollow: 8, // per second, main.js:8791

  // World
  maxY: 500, // main.js:8808
  planetRadius: 1200, // main.js:4524
  planetKillMargin: 20, // lethal inside radius + margin, main.js:9623
  beltInner: 3600, // main.js:4606
  beltOuter: 5200, // main.js:4607
  spawnYSpread: 100, // spawn y is ±50, main.js:4613

  // Life cycle
  maxHp: 100, // main.js:4314
  respawnTicks: 180, // 3 s (decision D5; v1's server used 3000 ms, server:2132)
  invulnerableTicks: 78, // 1.3 s after every spawn, server:3102

  // Weapons
  bulletSpeed: 230, // units/s, main.js:351. Bullets do not inherit ship velocity (main.js:6044)
  bulletLifeTicks: 180, // 3.0 s, main.js:352
  bulletRadius: 0.25, // main.js:6046
  muzzleOffset: 1.8, // bullets start this far ahead of the ship, main.js:6021
  shipHitRadius: 2.0, // ship against bullets, main.js:9811
  bulletDamage: 15, // main.js:9872
  fireCooldownTicks: 7, // v1 fired every 0.11 s, which is every 7th frame at 60 fps (main.js:8840)

  // Lag compensation (decision D2)
  maxViewDelayTicks: 21, // 350 ms: the furthest back a shooter's view is honoured
} as const;

export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

/** The saucer hull is a sphere of radius 2.0 (main.js:4220), so 4.0 across. */
export const SHIP_HULL_RADIUS = 2.0;
export const SHIP_LENGTH = SHIP_HULL_RADIUS * 2;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Number-to-string conversion is exactly specified, so this is the same in every engine. */
export const CONSTANTS_HASH = fnv1a(JSON.stringify(SIM));
