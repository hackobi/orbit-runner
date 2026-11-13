// Bullets. A bullet flies in a straight line at constant speed, so its
// position at any tick follows from where and when it was fired. Server and
// client both compute it with these functions.
//
// Collision tests the whole segment a bullet covers in a tick, not just its
// end point, so a fast bullet cannot pass through a ship between two ticks.

import { SIM, TICK_DT } from '../constants.ts';
import { cos, sin } from '../math.ts';
import type { ShipState } from './ship.ts';

export interface Bullet {
  readonly ownerId: number;
  /** The tick it was fired. With the owner, this identifies the bullet. */
  readonly spawnTick: number;
  /** Where it started: the muzzle, 1.8 units ahead of the ship. */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** Unit direction of flight. */
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

/** Distance a bullet covers in one tick. */
export const BULLET_STEP = SIM.bulletSpeed * TICK_DT;

/** Bullets hit a ship when their centres are this close. */
export const BULLET_HIT_DISTANCE = SIM.shipHitRadius + SIM.bulletRadius;

/** A bullet leaving the nose of `ship` at `tick` (main.js:6014-6021). Roll does not aim. */
export function spawnBullet(ownerId: number, tick: number, ship: ShipState): Bullet {
  return bulletFrom(ownerId, tick, ship.x, ship.y, ship.z, ship.yaw, ship.pitch);
}

/** The same, from the ship's position and heading. Used for bullets received from the server. */
export function bulletFrom(
  ownerId: number,
  spawnTick: number,
  shipX: number,
  shipY: number,
  shipZ: number,
  yaw: number,
  pitch: number,
): Bullet {
  const cosPitch = cos(pitch);
  const dx = sin(yaw) * cosPitch;
  const dy = -sin(pitch);
  const dz = cos(yaw) * cosPitch;
  return {
    ownerId,
    spawnTick,
    ox: shipX + dx * SIM.muzzleOffset,
    oy: shipY + dy * SIM.muzzleOffset,
    oz: shipZ + dz * SIM.muzzleOffset,
    dx,
    dy,
    dz,
  };
}

export function bulletExpired(bullet: Bullet, tick: number): boolean {
  return tick - bullet.spawnTick >= SIM.bulletLifeTicks;
}

/** Distance along its path that a bullet has reached at a tick (which may be fractional). */
export function bulletTravel(bullet: Bullet, tick: number): number {
  return (tick - bullet.spawnTick) * BULLET_STEP;
}

/**
 * Tests the path a bullet covers during `tick` against a sphere of radius
 * `hitDistance` around (cx, cy, cz); by default a ship's. Returns how far along the path the first
 * contact is, 0 to 1, or −1 for a miss.
 *
 * On the tick it is fired the path runs from the ship's centre to the muzzle,
 * so a target touching the shooter's nose is not skipped.
 */
export function bulletHit(
  bullet: Bullet,
  tick: number,
  cx: number,
  cy: number,
  cz: number,
  hitDistance = BULLET_HIT_DISTANCE,
): number {
  const age = tick - bullet.spawnTick;
  const from = age === 0 ? -SIM.muzzleOffset : (age - 1) * BULLET_STEP;
  const length = age === 0 ? SIM.muzzleOffset : BULLET_STEP;

  // Start of the path, relative to the sphere's centre.
  const px = bullet.ox + bullet.dx * from - cx;
  const py = bullet.oy + bullet.dy * from - cy;
  const pz = bullet.oz + bullet.dz * from - cz;

  const distanceSq = px * px + py * py + pz * pz;
  const radiusSq = hitDistance * hitDistance;
  if (distanceSq <= radiusSq) return 0;

  // Closest approach of the ray to the centre, as a distance along the ray.
  const along = -(px * bullet.dx + py * bullet.dy + pz * bullet.dz);
  if (along <= 0) return -1;
  const missSq = distanceSq - along * along;
  if (missSq > radiusSq) return -1;
  const entry = along - Math.sqrt(radiusSq - missSq);
  return entry <= length ? entry / length : -1;
}
