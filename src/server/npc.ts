// The ships the server flies itself: raiders that patrol the belt, and the
// Warlord. A brain reads the true state of the room and returns controls,
// which go through the same step as a player's. Nothing here is shared with
// clients: to them these are ships like any other, drawn from snapshots.

import { SIM } from '../shared/constants.ts';
import type { NpcKind } from '../shared/progress.ts';
import type { Rng } from '../shared/rng.ts';
import { NEUTRAL_CONTROLS } from '../shared/sim/ship.ts';
import type { Controls, ShipState } from '../shared/sim/ship.ts';

/** A raider comes back this long after it is destroyed. */
export const RAIDER_RESPAWN_TICKS = 15 * 60;
/** The Warlord first arrives this long after the room opens, and returns this long after it falls. */
export const WARLORD_FIRST_TICKS = 45 * 60;
export const WARLORD_RETURN_TICKS = 240 * 60;

interface Temper {
  /** A ship this close is attacked. */
  readonly engageRange: number;
  /** A ship that shot it is chased from this far. */
  readonly provokedRange: number;
  readonly fireRange: number;
  /** The most its aim is off by, in radians. Renewed every so often, so it misses in runs. */
  readonly aimError: number;
  readonly burstTicks: number;
  readonly restTicks: number;
  readonly cruiseSpeed: number;
  /** Uses the heavy shot and the homing shot. */
  readonly heavyWeapons: boolean;
}

const TEMPERS: Record<NpcKind, Temper> = {
  raider: {
    engageRange: 650,
    provokedRange: 1400,
    fireRange: 480,
    aimError: 0.035,
    burstTicks: 40,
    restTicks: 55,
    cruiseSpeed: 38,
    heavyWeapons: false,
  },
  warlord: {
    engageRange: 1000,
    provokedRange: 2000,
    fireRange: 600,
    aimError: 0.02,
    burstTicks: 70,
    restTicks: 40,
    cruiseSpeed: 26,
    heavyWeapons: true,
  },
};

/** How long a ship stays angry at whoever shot it. */
const PROVOKED_TICKS = 20 * 60;
const AIM_RENEW_TICKS = 45;
/** Outside these it stops chasing and goes back to its patrol, so it cannot be led into the planet. */
const LEASH_INNER = SIM.planetRadius + 1400;
const LEASH_OUTER = SIM.beltOuter + 900;
const LEASH_HEIGHT = 320;

export interface NpcBrain {
  readonly kind: NpcKind;
  /** The patrol: a circle round the planet, just clear of the rocks. */
  readonly orbitRadius: number;
  readonly orbitHeight: number;
  readonly clockwise: boolean;
  aimYaw: number;
  aimPitch: number;
  aimUntilTick: number;
  burstUntilTick: number;
  restUntilTick: number;
  provokedBy: number | null;
  provokedUntilTick: number;
}

export function createBrain(kind: NpcKind, rng: Rng): NpcBrain {
  const band = SIM.beltOuter - SIM.beltInner;
  return {
    kind,
    orbitRadius: SIM.beltInner + band * (0.2 + rng.next() * 0.6),
    // Rocks lie within 60 of the plane and orbs within 20.
    orbitHeight: (rng.next() < 0.5 ? -1 : 1) * (85 + rng.next() * 40),
    clockwise: rng.next() < 0.5,
    aimYaw: 0,
    aimPitch: 0,
    aimUntilTick: 0,
    burstUntilTick: 0,
    restUntilTick: 0,
    provokedBy: null,
    provokedUntilTick: 0,
  };
}

/** Tells a ship who shot it. */
export function provoke(brain: NpcBrain, byId: number, tick: number): void {
  brain.provokedBy = byId;
  brain.provokedUntilTick = tick + PROVOKED_TICKS;
}

export interface NpcTarget {
  readonly id: number;
  readonly ship: ShipState;
}

const clampAxis = (value: number): number => Math.max(-1, Math.min(1, value));

function wrap(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** The stick positions that turn `me` toward a point, and how far off it is. */
function steer(
  me: ShipState,
  x: number,
  y: number,
  z: number,
): { yaw: number; pitch: number; yawError: number; pitchError: number } {
  const dx = x - me.x;
  const dy = y - me.y;
  const dz = z - me.z;
  const yawError = wrap(Math.atan2(dx, dz) - me.yaw);
  // Forward y is −sin(pitch), so a point above needs negative pitch.
  const pitchError = -Math.atan2(dy, Math.hypot(dx, dz)) - me.pitch;
  return {
    yaw: clampAxis(yawError * 6),
    pitch: clampAxis(pitchError * 6),
    yawError,
    pitchError,
  };
}

function patrol(brain: NpcBrain, me: ShipState, temper: Temper): Controls {
  // Aim at a point a little further round the circle.
  const angle = Math.atan2(me.z, me.x) + (brain.clockwise ? -0.12 : 0.12);
  const to = steer(
    me,
    Math.cos(angle) * brain.orbitRadius,
    brain.orbitHeight,
    Math.sin(angle) * brain.orbitRadius,
  );
  const throttle =
    me.targetSpeed < temper.cruiseSpeed - 2 ? 1 : me.targetSpeed > temper.cruiseSpeed + 2 ? -1 : 0;
  return { yaw: to.yaw, pitch: to.pitch, throttle, fire: false };
}

/** The controls for this tick. `targets` are the players' ships it may attack. */
export function npcControls(
  brain: NpcBrain,
  me: ShipState,
  targets: readonly NpcTarget[],
  tick: number,
  rng: Rng,
): Controls {
  if (!me.alive) return NEUTRAL_CONTROLS;
  const temper = TEMPERS[brain.kind];
  if (brain.provokedBy !== null && tick >= brain.provokedUntilTick) brain.provokedBy = null;

  const radius = Math.hypot(me.x, me.z);
  const onLeash = radius > LEASH_INNER && radius < LEASH_OUTER && Math.abs(me.y) < LEASH_HEIGHT;

  let prey: ShipState | null = null;
  let preyDistance = Infinity;
  if (onLeash) {
    for (const { id, ship } of targets) {
      if (!ship.alive || ship.invulnTicks > 0) continue;
      const distance = Math.hypot(ship.x - me.x, ship.y - me.y, ship.z - me.z);
      const range = id === brain.provokedBy ? temper.provokedRange : temper.engageRange;
      if (distance < range && distance < preyDistance) {
        prey = ship;
        preyDistance = distance;
      }
    }
  }
  if (!prey) return patrol(brain, me, temper);

  if (tick >= brain.aimUntilTick) {
    brain.aimYaw = (rng.next() * 2 - 1) * temper.aimError;
    brain.aimPitch = (rng.next() * 2 - 1) * temper.aimError;
    brain.aimUntilTick = tick + AIM_RENEW_TICKS;
  }

  // Aim ahead of the ship by the bullet's flight time, as a player learns to.
  const flightSeconds = preyDistance / SIM.bulletSpeed;
  const cosPitch = Math.cos(prey.pitch);
  const lead = prey.speed * flightSeconds;
  const to = steer(
    me,
    prey.x + Math.sin(prey.yaw) * cosPitch * lead,
    prey.y - Math.sin(prey.pitch) * lead,
    prey.z + Math.cos(prey.yaw) * cosPitch * lead,
  );
  const yaw = clampAxis((to.yawError + brain.aimYaw) * 6);
  const pitch = clampAxis((to.pitchError + brain.aimPitch) * 6);
  const linedUp = Math.abs(to.yawError) < 0.07 && Math.abs(to.pitchError) < 0.07;

  // Fire in bursts with a rest between, which leaves a player room to answer.
  let fire = false;
  if (linedUp && preyDistance < temper.fireRange) {
    if (tick >= brain.restUntilTick) {
      if (tick >= brain.burstUntilTick) {
        brain.burstUntilTick = tick + temper.burstTicks;
        brain.restUntilTick = brain.burstUntilTick + temper.restTicks;
      }
    }
    fire = tick < brain.burstUntilTick;
  }

  const inLock =
    temper.heavyWeapons &&
    preyDistance < SIM.seekerLockRange * 0.9 &&
    Math.abs(to.yawError) < SIM.seekerLockAngle * 0.8 &&
    Math.abs(to.pitchError) < SIM.seekerLockAngle * 0.8;
  return {
    yaw,
    pitch,
    throttle: preyDistance > 260 ? 1 : preyDistance < 110 ? -1 : 0,
    fire,
    heavy: temper.heavyWeapons && linedUp && preyDistance < 350,
    // Hold to charge; letting go of a full charge fires it.
    seek:
      inLock &&
      me.seekerCooldown === 0 &&
      me.energy >= SIM.seekerCost &&
      me.charge < SIM.seekerChargeTicks,
  };
}
