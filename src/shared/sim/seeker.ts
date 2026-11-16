// The homing shot (decision D23). Unlike a bullet it has no formula for where
// it will be: each tick it turns toward its target, by at most its turn rate,
// and flies one step. Only the server runs this; clients are sent where each
// one is and draw it as they draw other ships.

import { SIM, TICK_DT } from '../constants.ts';
import { cos, sin } from '../math.ts';
import type { Bullet } from './bullets.ts';
import type { ShipState } from './ship.ts';

export interface Seeker {
  readonly ownerId: number;
  /** The tick it was launched. With the owner, this identifies it. */
  readonly spawnTick: number;
  /** The ship it follows, or null once it has none and flies straight. */
  readonly targetId: number | null;
  /** The life of the target it locked on to. A respawn or a wormhole jump breaks the lock. */
  readonly targetSpawnSeq: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit direction of flight. */
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

export const SEEKER_STEP = SIM.seekerSpeed * TICK_DT;
const TURN_COS = cos(SIM.seekerTurnRate * TICK_DT);
const TURN_SIN = sin(SIM.seekerTurnRate * TICK_DT);
const LOCK_COS = cos(SIM.seekerLockAngle);

/** A ship that could be locked on to: its id and where it is. */
export interface Candidate {
  readonly id: number;
  readonly ship: ShipState;
}

/**
 * Launches from the nose of `ship`. It locks on to the nearest live,
 * unprotected ship within range and within the cone ahead; with none, it
 * flies straight.
 */
export function launchSeeker(
  ownerId: number,
  tick: number,
  ship: ShipState,
  others: Iterable<Candidate>,
): Seeker {
  const cosPitch = cos(ship.pitch);
  const dx = sin(ship.yaw) * cosPitch;
  const dy = -sin(ship.pitch);
  const dz = cos(ship.yaw) * cosPitch;
  let targetId: number | null = null;
  let targetSpawnSeq = 0;
  let nearest: number = SIM.seekerLockRange;
  for (const { id, ship: other } of others) {
    if (id === ownerId || !other.alive || other.invulnTicks > 0) continue;
    const ox = other.x - ship.x;
    const oy = other.y - ship.y;
    const oz = other.z - ship.z;
    const distance = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (distance >= nearest || distance === 0) continue;
    if ((ox * dx + oy * dy + oz * dz) / distance < LOCK_COS) continue;
    nearest = distance;
    targetId = id;
    targetSpawnSeq = other.spawnSeq;
  }
  return {
    ownerId,
    spawnTick: tick,
    targetId,
    targetSpawnSeq,
    x: ship.x + dx * SIM.muzzleOffset,
    y: ship.y + dy * SIM.muzzleOffset,
    z: ship.z + dz * SIM.muzzleOffset,
    dx,
    dy,
    dz,
  };
}

export function seekerExpired(seeker: Seeker, tick: number): boolean {
  return tick - seeker.spawnTick >= SIM.seekerLifeTicks;
}

/**
 * One tick of flight. `target` is the ship it follows as it is now, or null
 * if that ship has gone. A target that has died, respawned or jumped is
 * dropped for good, and the shot flies on straight.
 */
export function stepSeeker(seeker: Seeker, target: ShipState | null): Seeker {
  let { dx, dy, dz, targetId } = seeker;
  if (targetId !== null && (!target?.alive || target.spawnSeq !== seeker.targetSpawnSeq)) {
    targetId = null;
  }
  if (targetId !== null && target) {
    let ux = target.x - seeker.x;
    let uy = target.y - seeker.y;
    let uz = target.z - seeker.z;
    const distance = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (distance > 0) {
      ux /= distance;
      uy /= distance;
      uz /= distance;
      const along = dx * ux + dy * uy + dz * uz;
      if (along >= TURN_COS) {
        // Within one tick's turn of the target: point straight at it.
        dx = ux;
        dy = uy;
        dz = uz;
      } else {
        // Turn by the most allowed, toward the target: the part of the way
        // to it that is square to the flight says which way that is.
        let px = ux - dx * along;
        let py = uy - dy * along;
        let pz = uz - dz * along;
        const across = Math.sqrt(px * px + py * py + pz * pz);
        // Dead astern there is no "toward"; fly on until there is.
        if (across > 1e-9) {
          px /= across;
          py /= across;
          pz /= across;
          dx = dx * TURN_COS + px * TURN_SIN;
          dy = dy * TURN_COS + py * TURN_SIN;
          dz = dz * TURN_COS + pz * TURN_SIN;
          const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
          dx /= length;
          dy /= length;
          dz /= length;
        }
      }
    }
  }
  return {
    ...seeker,
    targetId,
    x: seeker.x + dx * SEEKER_STEP,
    y: seeker.y + dy * SEEKER_STEP,
    z: seeker.z + dz * SEEKER_STEP,
    dx,
    dy,
    dz,
  };
}

/**
 * The path `after` covered in the tick that produced it, as a bullet one
 * tick old, so that the bullet tests for ships and rocks apply to it.
 */
export function seekerPath(after: Seeker, tick: number): Bullet {
  return {
    ownerId: after.ownerId,
    spawnTick: tick - 1,
    ox: after.x - after.dx * SEEKER_STEP,
    oy: after.y - after.dy * SEEKER_STEP,
    oz: after.z - after.dz * SEEKER_STEP,
    dx: after.dx,
    dy: after.dy,
    dz: after.dz,
    shot: 'seeker',
  };
}
