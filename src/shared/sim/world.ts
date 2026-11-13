// One ship's tick in the world: the flight step, then what the ship ran
// into. The server and every client run this same function, so a client
// predicts its own crashes exactly and is not corrected for them.

import { SIM } from '../constants.ts';
import { hash3 } from '../math.ts';
import { asteroidTouching } from './belt.ts';
import type { Belt, GoneView } from './belt.ts';
import { damageShip, stepShip } from './ship.ts';
import type { Input, ShipState } from './ship.ts';

/** The parts of the world that never change while a room runs. */
export interface World {
  readonly seed: number;
  readonly belt: Belt;
}

/** Something a ship did to the world during a tick. The caller applies it. */
export interface WorldEffect {
  readonly kind: 'asteroid';
  /** The rock the ship crashed into, which is destroyed. */
  readonly id: number;
}

/**
 * What a crash costs: 45 to 75 (main.js:8496), decided by the room, the rock
 * and the tick, so the server and the client that predicts it agree.
 */
export function crashDamage(seed: number, asteroidId: number, tick: number): number {
  return SIM.crashDamageMin + (hash3(seed, asteroidId, tick) % (SIM.crashDamageSpread + 1));
}

/**
 * Steps a ship one tick and adds what it did to the world to `effects`.
 *
 * A crash (main.js:8956-8980, 8492-8509) needs the ship to be alive, past
 * its spawn protection and past the pause after its last crash. It destroys
 * the rock.
 */
export function stepPlayer(
  ship: ShipState,
  input: Input,
  tick: number,
  world: World,
  gone: GoneView,
  effects: WorldEffect[],
): ShipState {
  const moved = stepShip(ship, input);
  if (!moved.alive || moved.invulnTicks > 0 || moved.crashTicks > 0) return moved;

  const id = asteroidTouching(
    world.belt,
    gone,
    tick,
    moved.x,
    moved.y,
    moved.z,
    SIM.shipCrashRadius,
  );
  if (id < 0) return moved;
  effects.push({ kind: 'asteroid', id });
  const hurt = damageShip(moved, crashDamage(world.seed, id, tick));
  return hurt.alive ? { ...hurt, crashTicks: SIM.crashCooldownTicks } : hurt;
}
