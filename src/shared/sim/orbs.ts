// Orbs. They sit still on the ring, placed from the room's seed, so server
// and clients each build the same field and never send an orb's position.
// Which orbs have been taken is server state (see Depleted in belt.ts).
//
// v1 scattered its orbs around the solo player and topped them up as the
// player moved (main.js:8335-8370). A shared room has no single player to
// scatter them around, so v2 keeps v1's caps as fixed counts on the ring.

import { SIM } from '../constants.ts';
import { TWO_PI, cos, hash3, sin } from '../math.ts';
import { Rng } from '../rng.ts';
import {
  BULLET_RADIUS_MAX,
  BULLET_STEP_MAX,
  bulletHit,
  bulletRadius,
  bulletStep,
} from './bullets.ts';
import type { Bullet } from './bullets.ts';

export const ORB_KINDS = [
  'shield',
  'pink',
  'fenix',
  'zaphire',
  'wormhole',
  'boost',
  'miner',
  'hunter',
] as const;
export type OrbKind = (typeof ORB_KINDS)[number];

const COUNTS: Record<OrbKind, number> = {
  shield: SIM.shieldOrbs,
  pink: SIM.pinkOrbs,
  fenix: SIM.fenixOrbs,
  zaphire: SIM.zaphireOrbs,
  wormhole: SIM.wormholeOrbs,
  boost: SIM.boostOrbs,
  miner: SIM.minerOrbs,
  hunter: SIM.hunterOrbs,
};

const RADII: Record<OrbKind, number> = {
  shield: SIM.shieldOrbRadius,
  pink: SIM.pinkOrbRadius,
  fenix: SIM.fenixOrbRadius,
  zaphire: SIM.zaphireOrbRadius,
  wormhole: SIM.wormholeOrbRadius,
  boost: SIM.boostOrbRadius,
  miner: SIM.multiplierOrbRadius,
  hunter: SIM.multiplierOrbRadius,
};

const MAX_ORB_RADIUS = Math.max(...Object.values(RADII));

export const ORB_COUNT = Object.values(COUNTS).reduce((sum, count) => sum + count, 0);

export interface Orb {
  readonly kind: OrbKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Collision radius. */
  readonly radius: number;
}

export interface OrbField {
  readonly orbs: readonly Orb[];
  /** Orb ids by square of the XZ plane, ids ascending. */
  readonly cells: ReadonlyMap<number, readonly number[]>;
  /**
   * For each wormhole, the wormholes far enough away to be its exit, ids
   * ascending. Empty for any other orb.
   */
  readonly exits: readonly (readonly number[])[];
}

const CELL = 32;
const CELL_OFFSET = 512;
const cellKey = (cx: number, cz: number): number =>
  (cx + CELL_OFFSET) * 2 * CELL_OFFSET + (cz + CELL_OFFSET);
const cellOf = (value: number): number => Math.floor(value / CELL);

/** The orb field for a seed, or an empty one for tests that want empty space. */
export function createOrbs(seed: number, enabled: boolean): OrbField {
  const rng = new Rng(seed ^ 0x0b5c0de5);
  const orbs: Orb[] = [];
  const cells = new Map<number, number[]>();
  if (enabled) {
    for (const kind of ORB_KINDS) {
      for (let i = 0; i < COUNTS[kind]; i++) {
        // main.js:5133-5141: a random point of the ring, within 20 units of its plane.
        const angle = rng.next() * TWO_PI;
        const radial = SIM.beltInner + rng.next() * (SIM.beltOuter - SIM.beltInner);
        const orb: Orb = {
          kind,
          x: cos(angle) * radial,
          y: (rng.next() - 0.5) * SIM.orbYSpread,
          z: sin(angle) * radial,
          radius: RADII[kind],
        };
        const key = cellKey(cellOf(orb.x), cellOf(orb.z));
        const cell = cells.get(key);
        if (cell) cell.push(orbs.length);
        else cells.set(key, [orbs.length]);
        orbs.push(orb);
      }
    }
  }

  const minJumpSq = SIM.wormholeMinJump * SIM.wormholeMinJump;
  const exits = orbs.map((from) => {
    if (from.kind !== 'wormhole') return [];
    const far: number[] = [];
    for (const [id, to] of orbs.entries()) {
      if (to.kind !== 'wormhole') continue;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      if (dx * dx + dy * dy + dz * dz >= minJumpSq) far.push(id);
    }
    return far;
  });
  return { orbs, cells, exits };
}

/** Which orbs are taken at a tick. The server knows; a client predicts. */
export interface OrbsGoneView {
  orbGone(id: number, tick: number): boolean;
}

/**
 * The lowest-numbered orb present whose centre is within its own radius plus
 * `extra` of the point, or −1. Fenix orbs are left out: flying through one
 * does nothing, it has to be shot (main.js:9188-9229).
 */
export function orbTouching(
  field: OrbField,
  gone: OrbsGoneView,
  tick: number,
  x: number,
  y: number,
  z: number,
  extra: number,
): number {
  if (field.orbs.length === 0) return -1;
  const reachMax = MAX_ORB_RADIUS + extra;
  let found = -1;
  for (let cx = cellOf(x - reachMax); cx <= cellOf(x + reachMax); cx++) {
    for (let cz = cellOf(z - reachMax); cz <= cellOf(z + reachMax); cz++) {
      const ids = field.cells.get(cellKey(cx, cz));
      if (!ids) continue;
      for (const id of ids) {
        if (found >= 0 && id > found) break;
        const orb = field.orbs[id];
        if (!orb || orb.kind === 'fenix') continue;
        const reach = orb.radius + extra;
        const dx = orb.x - x;
        const dy = orb.y - y;
        const dz = orb.z - z;
        if (dx * dx + dy * dy + dz * dz >= reach * reach) continue;
        if (gone.orbGone(id, tick)) continue;
        found = id;
      }
    }
  }
  return found;
}

export interface OrbHit {
  id: number;
  /** How far along the bullet's path this tick the contact is, 0 to 1. */
  at: number;
}

/** The first orb present that a bullet meets on the path it covers during `tick`, or null. */
export function bulletOrbHit(
  field: OrbField,
  gone: OrbsGoneView,
  bullet: Bullet,
  tick: number,
): OrbHit | null {
  if (field.orbs.length === 0) return null;
  // Where the bullet is at the end of the tick; its path this tick lies
  // within one step of there.
  const travel = (tick - bullet.spawnTick) * bulletStep(bullet);
  const x = bullet.ox + bullet.dx * travel;
  const z = bullet.oz + bullet.dz * travel;
  const reachMax = MAX_ORB_RADIUS + BULLET_RADIUS_MAX + BULLET_STEP_MAX;
  const hitRadius = bulletRadius(bullet);
  let hit: OrbHit | null = null;
  for (let cx = cellOf(x - reachMax); cx <= cellOf(x + reachMax); cx++) {
    for (let cz = cellOf(z - reachMax); cz <= cellOf(z + reachMax); cz++) {
      const ids = field.cells.get(cellKey(cx, cz));
      if (!ids) continue;
      for (const id of ids) {
        const orb = field.orbs[id];
        if (!orb) continue;
        const at = bulletHit(bullet, tick, orb.x, orb.y, orb.z, orb.radius + hitRadius);
        if (at < 0 || gone.orbGone(id, tick)) continue;
        // The nearer contact wins; on a tie, the lower id, so every machine agrees.
        if (!hit || at < hit.at || (at === hit.at && id < hit.id)) hit = { id, at };
      }
    }
  }
  return hit;
}

/**
 * Where a ship comes out after entering a wormhole (decision D9): near
 * another wormhole at least 5,000 units away, 150 to 400 units from it
 * (main.js:9530-9537). Which one, and where around it, is fixed by the room,
 * the wormhole and the tick, so server and client agree. Null if the
 * wormhole has no exit.
 */
export function wormholeExit(
  field: OrbField,
  seed: number,
  orbId: number,
  tick: number,
): { x: number; y: number; z: number } | null {
  const exits = field.exits[orbId];
  if (!exits || exits.length === 0) return null;
  const exit = field.orbs[exits[hash3(seed, orbId, tick) % exits.length] ?? -1];
  if (!exit) return null;
  const scatter = hash3(seed ^ 0x5ca77e4, orbId, tick);
  const angle = ((scatter & 0xffff) / 65536) * TWO_PI;
  const distance = SIM.wormholeScatterMin + ((scatter >>> 16) / 65536) * SIM.wormholeScatterSpread;
  return { x: exit.x + cos(angle) * distance, y: exit.y, z: exit.z + sin(angle) * distance };
}
