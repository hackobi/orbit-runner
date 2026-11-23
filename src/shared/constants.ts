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

  // Energy (decision D21). Whole units, so the wire carries it exactly. It
  // pays for the boost and brake buttons; a shield orb tops it up.
  maxEnergy: 6000,
  energyRegen: 5, // a tick: empty to full in 20 s
  thrustCost: 40, // a tick of boost or brake: a full tank lasts 2.5 s
  thrustStartEnergy: 600, // a tenth of a tank to start either, so a dry tank does not stutter
  thrustBoostMultiplier: 2, // the boost button: 120 u/s, under an orb boost's 185
  brakeRate: 88, // units/s² off the target speed, four times the throttle's
  shieldOrbEnergy: 1500, // a quarter of a tank

  // World
  maxY: 500, // main.js:8808
  planetRadius: 1200, // main.js:4524
  planetKillMargin: 20, // lethal inside radius + margin, main.js:9623
  beltInner: 3600, // main.js:4606
  beltOuter: 5200, // main.js:4607
  spawnYSpread: 100, // spawn y is ±50, main.js:4613

  // Asteroid belt (main.js:4835-4873). Rocks orbit the planet in the XZ plane.
  asteroidCount: 2000, // main.js:4873
  asteroidYSpread: 120, // height is ±60, main.js:4839
  asteroidScaleMin: 2, // main.js:4843
  asteroidScaleSpread: 7, // scale is 2 to 9, main.js:4843
  asteroidRadiusFactor: 0.95, // collision radius is scale × this, main.js:4858
  asteroidOrbitMin: 0.012, // rad/s, main.js:4862
  asteroidOrbitSpread: 0.03, // orbit speed is 0.012 to 0.042 rad/s, main.js:4862
  asteroidRespawnTicks: 1800, // 30 s. v1 never brought a rock back; a room runs for days
  shipCrashRadius: 1.8, // ship against asteroids, main.js:4494
  crashDamageMin: 45, // main.js:8496
  crashDamageSpread: 30, // a crash costs 45 to 75, main.js:8496
  crashCooldownTicks: 36, // 0.6 s without another crash, main.js:8509

  // Orbs. Fixed in place on the ring; counts are v1's caps (main.js:8340-8370, 5418).
  orbYSpread: 40, // height is ±20, main.js:5140
  orbRespawnTicks: 1800, // 30 s. v1 topped orbs up around the ship instead
  pickupRadius: 2.2, // the ship against orbs, main.js:4495
  shieldOrbs: 160,
  pinkOrbs: 120,
  fenixOrbs: 120,
  zaphireOrbs: 120,
  wormholeOrbs: 120,
  boostOrbs: 120,
  minerOrbs: 300,
  hunterOrbs: 300,
  shieldOrbRadius: 1.2, // main.js:5126
  pinkOrbRadius: 1.6, // main.js:5186
  fenixOrbRadius: 1.7, // shot only, main.js:9211
  zaphireOrbRadius: 2.4, // main.js:5344
  wormholeOrbRadius: 1.8, // main.js:5553
  boostOrbRadius: 6.2, // v1's pulsed between 5.94 and 6.46, main.js:9329
  multiplierOrbRadius: 4.3, // miner and hunter; v1's pulsed between 4.01 and 4.59
  shieldOrbGain: 25, // main.js:9099
  boostTicksMin: 180, // 3 s, main.js:9332
  boostTicksSpread: 180, // a boost lasts 3 to 6 s, main.js:9332
  wormholeMinJump: 5000, // decision D9. v1 asked for 12,000, which no two ring wormholes are
  wormholeScatterMin: 150, // the ship arrives this far from the exit, main.js:9537
  wormholeScatterSpread: 250, // main.js:9537
  shotEffectDelayTicks: 30, // what a shot orb does to the shooter happens 0.5 s later

  // Fenix (main.js:5095-5106, 8697-8701, 6023-6039)
  fenixMaxSpeed: 80, // main.js:8700
  fenixCrashDivisor: 2, // a crash costs a Fenix half, main.js:8494
  beamSpeed: 300, // units/s, main.js:353
  beamLifeTicks: 155, // v1's 2.576 s in whole ticks, main.js:354
  beamRadius: 0.45, // main.js:6031
  beamDamage: 30, // main.js:9872

  // The Fenix orb's weapon upgrade (decision D24): on top of the
  // transformation, the gun fires faster for a while.
  rapidTicks: 900, // 15 s
  rapidCooldownTicks: 4, // against the gun's 7

  // World edge (decision D11)
  combatZoneRadius: 9000, // from the planet's axis
  edgeDamage: 5, // off the ship every edgeDamageEveryTicks while outside
  edgeDamageEveryTicks: 30,

  // Life cycle
  maxHp: 100, // main.js:4314
  maxShield: 100, // main.js:9099
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

  // Heavy shot (decision D22): slow enough to dodge when seen, so it rewards
  // an ambush. A ship carries a few a life.
  heavySpeed: 150, // units/s: under a bullet's 230, over the boost button's 120
  heavyLifeTicks: 200, // 3.3 s, 500 units
  heavyRadius: 1.5,
  heavyDamage: 60,
  heavyAmmo: 2, // a life
  heavyCooldownTicks: 60, // 1 s between the two

  // Homing shot (decision D23). Charged by holding its button, paid for in
  // energy, and steered by the server toward one ship. It turns in a circle
  // of radius speed / turn rate, 150 units against a ship's 30, so a
  // hard turn close in gets inside it.
  seekerChargeTicks: 60, // 1 s held before it can be released
  seekerCost: 2400, // energy: two fifths of a tank
  seekerCooldownTicks: 300, // as long as it flies, so a ship has one out at a time
  seekerSpeed: 180, // units/s: over the boost button's 120, just under an orb boost's 185
  seekerTurnRate: 1.2, // rad/s
  seekerLifeTicks: 300, // 5 s: it gains 120 u/s on a ship at top speed, so 600 units
  seekerRadius: 0.8,
  seekerDamage: 40,
  seekerLockRange: 600, // no further than it can catch a ship flying straight away
  seekerLockAngle: 0.5, // rad either side of the nose

  // Stunts (decision D38): a barrel roll to either side and a backflip.
  rollTicks: 30, // half a second for one turn about the nose
  rollSlide: 36, // units the ship moves sideways during it
  rollCost: 1200, // energy: a fifth of a tank
  flipTicks: 60, // one second for the loop
  flipRadius: 12, // of the loop
  flipRise: 24, // units higher the ship comes out than it went in, off its old track
  flipCost: 2400, // energy: what the homing shot it shakes off cost to fire
  stuntCooldownTicks: 30, // after one ends, before the next can start

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
