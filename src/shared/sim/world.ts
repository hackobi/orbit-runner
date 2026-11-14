// One ship's tick in the world: the flight step, then what the ship ran
// into. The server and every client run this same function, so a client
// predicts its own crashes and pickups exactly and is not corrected for them.

import { SIM } from '../constants.ts';
import { hash3 } from '../math.ts';
import { Depleted, asteroidTouching, createBelt } from './belt.ts';
import type { Belt } from './belt.ts';
import { createOrbs, orbTouching, wormholeExit } from './orbs.ts';
import type { OrbField } from './orbs.ts';
import { SPAWN_SEQ_MODULO, damageShip, stepShip } from './ship.ts';
import type { Input, ShipState } from './ship.ts';

/** The parts of the world that never change while a room runs. */
export interface World {
  readonly seed: number;
  readonly belt: Belt;
  readonly orbs: OrbField;
}

/**
 * The world for a seed. A real room has the full belt and every orb; a test
 * of one mechanism can ask for fewer rocks or no orbs.
 */
export function createWorld(seed: number, asteroidCount: number, withOrbs: boolean): World {
  return {
    seed,
    belt: createBelt(seed, asteroidCount),
    orbs: createOrbs(seed, withOrbs),
  };
}

/** Which rocks are destroyed and which orbs are taken at a tick. */
export interface WorldState {
  asteroidGone(id: number, tick: number): boolean;
  orbGone(id: number, tick: number): boolean;
}

/** The server's record of the world, and a client's record of what it has been told. */
export class WorldLedger implements WorldState {
  readonly asteroids: Depleted;
  readonly orbs: Depleted;

  constructor(world: World) {
    this.asteroids = new Depleted(world.belt.asteroids.length, SIM.asteroidRespawnTicks);
    this.orbs = new Depleted(world.orbs.orbs.length, SIM.orbRespawnTicks);
  }

  asteroidGone(id: number, tick: number): boolean {
    return this.asteroids.gone(id, tick);
  }

  orbGone(id: number, tick: number): boolean {
    return this.orbs.gone(id, tick);
  }
}

/**
 * Something a ship did to the world during a tick: the rock it crashed into,
 * which is destroyed, or the orb it flew through, which is taken. The caller
 * records it.
 */
export interface WorldEffect {
  readonly kind: 'asteroid' | 'orb';
  readonly id: number;
}

/**
 * What a crash costs: 45 to 75 (main.js:8496), decided by the room, the rock
 * and the tick, so the server and the client that predicts it agree.
 */
export function crashDamage(seed: number, asteroidId: number, tick: number): number {
  return SIM.crashDamageMin + (hash3(seed, asteroidId, tick) % (SIM.crashDamageSpread + 1));
}

/** How long the boost from an orb lasts: 3 to 6 s (main.js:9332), fixed the same way. */
export function boostTicksFrom(seed: number, orbId: number, tick: number): number {
  return SIM.boostTicksMin + (hash3(seed ^ 0xb0057, orbId, tick) % (SIM.boostTicksSpread + 1));
}

/** True if the ship is past the edge of the combat zone (decision D11). */
export function outsideCombatZone(ship: ShipState): boolean {
  return ship.x * ship.x + ship.z * ship.z > SIM.combatZoneRadius * SIM.combatZoneRadius;
}

/**
 * What taking an orb does to the ship that took it. Pink, Zaphire and the
 * two multiplier orbs change nothing about the ship; what they are worth is
 * the server's business.
 */
export function applyOrb(ship: ShipState, orbId: number, tick: number, world: World): ShipState {
  const orb = world.orbs.orbs[orbId];
  if (!orb || !ship.alive) return ship;
  switch (orb.kind) {
    case 'shield': // main.js:9099
      return { ...ship, shield: Math.min(SIM.maxShield, ship.shield + SIM.shieldOrbGain) };
    case 'boost': // main.js:9331. A second boost replaces the first.
      return { ...ship, boostTicks: boostTicksFrom(world.seed, orbId, tick) };
    case 'fenix': // main.js:5095-5106. Nothing for a ship that is one already.
      return ship.fenix ? ship : { ...ship, fenix: true, hp: SIM.maxHp };
    case 'wormhole': {
      const exit = wormholeExit(world.orbs, world.seed, orbId, tick);
      if (!exit) return ship;
      // A new spawn number marks the jump: nothing draws a line across it,
      // and nobody who was aiming at the ship where it was can still hit it.
      return {
        ...ship,
        x: exit.x,
        y: exit.y,
        z: exit.z,
        spawnSeq: (ship.spawnSeq + 1) % SPAWN_SEQ_MODULO,
      };
    }
    default:
      return ship;
  }
}

/**
 * Steps a ship one tick and adds what it did to the world to `effects`.
 *
 * - A crash (main.js:8956-8980, 8492-8509) needs the ship to be alive, past
 *   its spawn protection and past the pause after its last crash. It
 *   destroys the rock. A Fenix takes half.
 * - Flying through an orb takes it (main.js:9085-9100). One orb a tick.
 * - Outside the combat zone the ship loses 5 points twice a second.
 */
export function stepPlayer(
  ship: ShipState,
  input: Input,
  tick: number,
  world: World,
  state: WorldState,
  effects: WorldEffect[],
): ShipState {
  let s = stepShip(ship, input);
  if (!s.alive) return s;

  if (s.invulnTicks === 0 && s.crashTicks === 0) {
    const id = asteroidTouching(world.belt, state, tick, s.x, s.y, s.z, SIM.shipCrashRadius);
    if (id >= 0) {
      effects.push({ kind: 'asteroid', id });
      const full = crashDamage(world.seed, id, tick);
      const damage = s.fenix ? Math.ceil(full / SIM.fenixCrashDivisor) : full;
      s = damageShip(s, damage);
      if (!s.alive) return s;
      s = { ...s, crashTicks: SIM.crashCooldownTicks };
    }
  }

  const orbId = orbTouching(world.orbs, state, tick, s.x, s.y, s.z, SIM.pickupRadius);
  if (orbId >= 0) {
    effects.push({ kind: 'orb', id: orbId });
    s = applyOrb(s, orbId, tick, world);
  }

  if (tick % SIM.edgeDamageEveryTicks === 0 && outsideCombatZone(s)) {
    s = damageShip(s, SIM.edgeDamage);
  }
  return s;
}
