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
  /**
   * A Fenix beam (main.js:6023-6039): faster, fatter, shorter-lived, and
   * twice the damage. A Fenix fires these instead of bullets.
   */
  readonly beam: boolean;
}

/** Distance an ordinary bullet covers in one tick. */
export const BULLET_STEP = SIM.bulletSpeed * TICK_DT;
const BEAM_STEP = SIM.beamSpeed * TICK_DT;
/** The longest step of any kind of bullet. */
export const BULLET_STEP_MAX = Math.max(BULLET_STEP, BEAM_STEP);

/** An ordinary bullet hits a ship when their centres are this close. */
export const BULLET_HIT_DISTANCE = SIM.shipHitRadius + SIM.bulletRadius;

/** Distance this bullet covers in one tick. */
export const bulletStep = (bullet: Bullet): number => (bullet.beam ? BEAM_STEP : BULLET_STEP);
export const bulletRadius = (bullet: Bullet): number =>
  bullet.beam ? SIM.beamRadius : SIM.bulletRadius;
export const bulletDamage = (bullet: Bullet): number =>
  bullet.beam ? SIM.beamDamage : SIM.bulletDamage;
export const bulletLifeTicks = (bullet: Bullet): number =>
  bullet.beam ? SIM.beamLifeTicks : SIM.bulletLifeTicks;

/** A bullet leaving the nose of `ship` at `tick` (main.js:6014-6021). Roll does not aim. */
export function spawnBullet(ownerId: number, tick: number, ship: ShipState): Bullet {
  return bulletFrom(ownerId, tick, ship.x, ship.y, ship.z, ship.yaw, ship.pitch, ship.fenix);
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
  beam: boolean,
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
    beam,
  };
}

export function bulletExpired(bullet: Bullet, tick: number): boolean {
  return tick - bullet.spawnTick >= bulletLifeTicks(bullet);
}

/** Distance along its path that a bullet has reached at a tick (which may be fractional). */
export function bulletTravel(bullet: Bullet, tick: number): number {
  return (tick - bullet.spawnTick) * bulletStep(bullet);
}

/**
 * Tests the path a bullet covers during `tick` against a sphere of radius
 * `hitDistance` around (cx, cy, cz). For a ship that is shipHitDistance. Returns how far along the path the first
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
  hitDistance: number,
): number {
  const age = tick - bullet.spawnTick;
  const step = bulletStep(bullet);
  const from = age === 0 ? -SIM.muzzleOffset : (age - 1) * step;
  const length = age === 0 ? SIM.muzzleOffset : step;

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

/** How close this bullet's centre must come to a ship's to hit it. */
export const shipHitDistance = (bullet: Bullet): number => SIM.shipHitRadius + bulletRadius(bullet);
