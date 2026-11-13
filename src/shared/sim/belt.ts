// The asteroid belt. Every rock circles the planet at a fixed distance,
// height and rate (main.js:4835-4866, 8919-8923), so where it is at any tick
// follows from the room's seed and the tick alone. Server and clients each
// build the same belt and never send a rock's position.
//
// A rock's distance from the planet and its height never change, so the
// index that finds the rocks near a point is built once.

import { SIM, TICK_DT } from '../constants.ts';
import { TWO_PI, cos, sin, wrapTurns } from '../math.ts';
import { Rng } from '../rng.ts';
import { BULLET_STEP, bulletHit } from './bullets.ts';
import type { Bullet } from './bullets.ts';

export interface Asteroid {
  /** Distance from the planet's axis. */
  readonly orbitRadius: number;
  /** Angle at tick 0. The rock is at (cos·r, y, sin·r). */
  readonly angle0: number;
  readonly anglePerTick: number;
  readonly y: number;
  /** Drawn size. */
  readonly scale: number;
  /** Collision radius. */
  readonly radius: number;
}

export interface Belt {
  readonly asteroids: readonly Asteroid[];
  /** Asteroid ids by orbit radius, in rings BIN_WIDTH wide, ids ascending. */
  readonly bins: readonly (readonly number[])[];
  /** The largest collision radius in the belt. */
  readonly maxRadius: number;
}

const BIN_WIDTH = 20;
const BIN_COUNT = Math.ceil((SIM.beltOuter - SIM.beltInner) / BIN_WIDTH);

/** The belt for a seed. `count` is SIM.asteroidCount except in tests that want empty space. */
export function createBelt(seed: number, count: number): Belt {
  const rng = new Rng(seed ^ 0x0a57e801);
  const asteroids: Asteroid[] = [];
  const bins: number[][] = Array.from({ length: BIN_COUNT }, () => []);
  let maxRadius = 0;
  for (let id = 0; id < count; id++) {
    const angle0 = rng.next() * TWO_PI;
    const orbitRadius = SIM.beltInner + rng.next() * (SIM.beltOuter - SIM.beltInner);
    const y = (rng.next() - 0.5) * SIM.asteroidYSpread;
    const scale = SIM.asteroidScaleMin + rng.next() * SIM.asteroidScaleSpread;
    const perSecond = SIM.asteroidOrbitMin + rng.next() * SIM.asteroidOrbitSpread;
    const radius = scale * SIM.asteroidRadiusFactor;
    asteroids.push({
      orbitRadius,
      angle0,
      anglePerTick: perSecond * TICK_DT,
      y,
      scale,
      radius,
    });
    const bin = Math.min(BIN_COUNT - 1, Math.floor((orbitRadius - SIM.beltInner) / BIN_WIDTH));
    bins[bin]?.push(id);
    if (radius > maxRadius) maxRadius = radius;
  }
  return { asteroids, bins, maxRadius };
}

/** Which rocks are destroyed at a tick. The server knows; a client predicts. */
export interface GoneView {
  asteroidGone(id: number, tick: number): boolean;
}

/** A rock's angle around the planet at a tick, which may be fractional. */
export function asteroidAngle(asteroid: Asteroid, tick: number): number {
  return wrapTurns(asteroid.angle0 + asteroid.anglePerTick * tick);
}

/** Where a rock's centre is at a tick. */
export function asteroidPosition(
  asteroid: Asteroid,
  tick: number,
): { x: number; y: number; z: number } {
  const angle = asteroidAngle(asteroid, tick);
  return {
    x: cos(angle) * asteroid.orbitRadius,
    y: asteroid.y,
    z: sin(angle) * asteroid.orbitRadius,
  };
}

/**
 * The lowest-numbered live rock whose centre is within its own radius plus
 * `extra` of the point at `tick`, or −1.
 */
export function asteroidTouching(
  belt: Belt,
  gone: GoneView,
  tick: number,
  x: number,
  y: number,
  z: number,
  extra: number,
): number {
  const reachMax = belt.maxRadius + extra;
  const radial = Math.sqrt(x * x + z * z);
  if (radial < SIM.beltInner - reachMax || radial > SIM.beltOuter + reachMax) return -1;
  const first = Math.max(0, Math.floor((radial - reachMax - SIM.beltInner) / BIN_WIDTH));
  const last = Math.min(BIN_COUNT - 1, Math.floor((radial + reachMax - SIM.beltInner) / BIN_WIDTH));
  let found = -1;
  for (let bin = first; bin <= last; bin++) {
    const ids = belt.bins[bin];
    if (!ids) continue;
    for (const id of ids) {
      if (found >= 0 && id > found) break;
      const asteroid = belt.asteroids[id];
      if (!asteroid) continue;
      const reach = asteroid.radius + extra;
      const dy = asteroid.y - y;
      if (dy > reach || dy < -reach) continue;
      const dr = asteroid.orbitRadius - radial;
      if (dr > reach || dr < -reach) continue;
      const angle = asteroidAngle(asteroid, tick);
      const dx = cos(angle) * asteroid.orbitRadius - x;
      const dz = sin(angle) * asteroid.orbitRadius - z;
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      if (gone.asteroidGone(id, tick)) continue;
      found = id;
    }
  }
  return found;
}

export interface AsteroidHit {
  id: number;
  /** How far along the bullet's path this tick the contact is, 0 to 1. */
  at: number;
}

/**
 * The first live rock a bullet meets on the path it covers during `tick`, or
 * null. Rocks are tested where they are at that tick.
 */
export function bulletAsteroidHit(
  belt: Belt,
  gone: GoneView,
  bullet: Bullet,
  tick: number,
): AsteroidHit | null {
  // The middle of this tick's path, and half its length.
  const age = tick - bullet.spawnTick;
  const half = (age === 0 ? SIM.muzzleOffset : BULLET_STEP) / 2;
  const middle = age === 0 ? -half : (age - 1) * BULLET_STEP + half;
  const x = bullet.ox + bullet.dx * middle;
  const y = bullet.oy + bullet.dy * middle;
  const z = bullet.oz + bullet.dz * middle;

  const extra = SIM.bulletRadius + half;
  const reachMax = belt.maxRadius + extra;
  const radial = Math.sqrt(x * x + z * z);
  if (radial < SIM.beltInner - reachMax || radial > SIM.beltOuter + reachMax) return null;
  const first = Math.max(0, Math.floor((radial - reachMax - SIM.beltInner) / BIN_WIDTH));
  const last = Math.min(BIN_COUNT - 1, Math.floor((radial + reachMax - SIM.beltInner) / BIN_WIDTH));
  let hit: AsteroidHit | null = null;
  for (let bin = first; bin <= last; bin++) {
    const ids = belt.bins[bin];
    if (!ids) continue;
    for (const id of ids) {
      const asteroid = belt.asteroids[id];
      if (!asteroid) continue;
      const reach = asteroid.radius + extra;
      const dy = asteroid.y - y;
      if (dy > reach || dy < -reach) continue;
      const dr = asteroid.orbitRadius - radial;
      if (dr > reach || dr < -reach) continue;
      const angle = asteroidAngle(asteroid, tick);
      const at = bulletHit(
        bullet,
        tick,
        cos(angle) * asteroid.orbitRadius,
        asteroid.y,
        sin(angle) * asteroid.orbitRadius,
        asteroid.radius + SIM.bulletRadius,
      );
      if (at < 0 || gone.asteroidGone(id, tick)) continue;
      // The nearer contact wins; on a tie, the lower id, so every machine agrees.
      if (!hit || at < hit.at || (at === hit.at && id < hit.id)) hit = { id, at };
    }
  }
  return hit;
}

/**
 * Which rocks are destroyed, and since when. A rock comes back a fixed time
 * after it was destroyed, so one tick per rock answers "was it there?" for
 * any recent tick, which is what replaying a prediction needs.
 */
export class DestroyedAsteroids implements GoneView {
  private readonly since: Int32Array;

  constructor(count: number) {
    this.since = new Int32Array(count).fill(NEVER);
  }

  asteroidGone(id: number, tick: number): boolean {
    const since = this.since[id];
    return since !== undefined && since <= tick && tick < since + SIM.asteroidRespawnTicks;
  }

  destroy(id: number, tick: number): void {
    if (id >= 0 && id < this.since.length) this.since[id] = tick;
  }

  /** Every rock that is gone at `tick`, with the tick it was destroyed. */
  goneAt(tick: number): { id: number; tick: number }[] {
    const list: { id: number; tick: number }[] = [];
    for (let id = 0; id < this.since.length; id++) {
      if (this.asteroidGone(id, tick)) list.push({ id, tick: this.since[id] ?? NEVER });
    }
    return list;
  }

  clear(): void {
    this.since.fill(NEVER);
  }
}

const NEVER = -0x7fffffff;
