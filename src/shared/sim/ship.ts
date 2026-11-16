// The ship simulation: one fixed step, a pure function of (state, input).
// The server, the browser client and the bots all run exactly this code.
//
// The flight model is v1's update (main.js:8690-8809) with its order of
// operations kept, and the frame dt replaced by a fixed 1/60 s.

import { SIM, TICK_DT } from '../constants.ts';
import { HALF_PI, TWO_PI, clamp, cos, sin, wrapAngle } from '../math.ts';
import type { Rng } from '../rng.ts';

export const AXIS_MAX = 127;

declare const inputBrand: unique symbol;

/**
 * One tick of controls, exactly as it travels on the wire. The only ways to
 * make one are quantiseControls and inputFromWire, so nothing can step the
 * simulation from raw floating-point controls by accident.
 */
export interface Input {
  /** Turn axis, −127..127. Positive turns left, as v1's A / Left key does. */
  readonly yaw: number;
  /** Pitch axis, −127..127. Positive is v1's I / Up key (decision D10). */
  readonly pitch: number;
  readonly throttle: -1 | 0 | 1;
  readonly fire: boolean;
  /** Fires a heavy shot if one is left and the launcher is ready. */
  readonly heavy: boolean;
  /** Held to charge the homing shot; letting go of a full charge fires it. */
  readonly seek: boolean;
  /** Held: fly faster than top speed while the energy lasts. */
  readonly boost: boolean;
  /** Held: shed speed fast while the energy lasts. */
  readonly brake: boolean;
  /**
   * How far behind this tick the player was seeing the other ships, in
   * sixteenths of a tick. The server rewinds targets by this much when it
   * tests this player's bullets (lag compensation), up to a cap.
   */
  readonly viewDelay: number;
  readonly [inputBrand]: true;
}

export const VIEW_DELAY_STEPS_PER_TICK = 16;
export const MAX_VIEW_DELAY = SIM.maxViewDelayTicks * VIEW_DELAY_STEPS_PER_TICK;

/** Controls as an input device produces them. Axes are nominally −1..1. */
export interface Controls {
  yaw: number;
  pitch: number;
  throttle: number;
  fire: boolean;
  heavy?: boolean;
  seek?: boolean;
  boost?: boolean;
  brake?: boolean;
}

/**
 * Builds an Input from wire values. Returns null unless the controls are in
 * range. A view delay above the cap is not an error: it is clamped, so a
 * client gains nothing by claiming to be further behind than allowed.
 */
export function inputFromWire(
  yaw: number,
  pitch: number,
  throttle: number,
  fire: boolean,
  heavy: boolean,
  seek: boolean,
  boost: boolean,
  brake: boolean,
  viewDelay: number,
): Input | null {
  if (!Number.isInteger(yaw) || yaw < -AXIS_MAX || yaw > AXIS_MAX) return null;
  if (!Number.isInteger(pitch) || pitch < -AXIS_MAX || pitch > AXIS_MAX) return null;
  if (throttle !== -1 && throttle !== 0 && throttle !== 1) return null;
  if (!Number.isInteger(viewDelay) || viewDelay < 0) return null;
  return {
    yaw,
    pitch,
    throttle,
    fire,
    heavy,
    seek,
    boost,
    brake,
    viewDelay: Math.min(viewDelay, MAX_VIEW_DELAY),
  } as Input;
}

function quantiseAxis(value: number): number {
  if (!(value === value)) return 0; // NaN
  return Math.round(clamp(value, -1, 1) * AXIS_MAX);
}

/** `viewDelayTicks` is how far behind this tick the other ships are being drawn. */
export function quantiseControls(controls: Controls, viewDelayTicks = 0): Input {
  const throttle = controls.throttle > 0 ? 1 : controls.throttle < 0 ? -1 : 0;
  const delay = viewDelayTicks === viewDelayTicks ? viewDelayTicks : 0;
  return {
    yaw: quantiseAxis(controls.yaw),
    pitch: quantiseAxis(controls.pitch),
    throttle,
    fire: controls.fire,
    heavy: controls.heavy === true,
    seek: controls.seek === true,
    boost: controls.boost === true,
    brake: controls.brake === true,
    viewDelay: Math.round(clamp(delay, 0, SIM.maxViewDelayTicks) * VIEW_DELAY_STEPS_PER_TICK),
  } as Input;
}

export const NEUTRAL_CONTROLS: Controls = { yaw: 0, pitch: 0, throttle: 0, fire: false };
export const NEUTRAL_INPUT: Input = quantiseControls(NEUTRAL_CONTROLS);

/** Everything the step function reads or writes for one ship. */
export interface ShipState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Radians, kept in (−π, π]. */
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly speed: number;
  readonly targetSpeed: number;
  /** Ticks of boost left. 0 means no boost. */
  readonly boostTicks: number;
  readonly alive: boolean;
  /** While dead: ticks until the server respawns the ship. */
  readonly respawnTicks: number;
  /** Goes up by one at every spawn. A change means the ship teleported. */
  readonly spawnSeq: number;
  readonly hp: number;
  /** 0 to 100. Damage comes off the shield first and only the rest off the hull (decision D8). */
  readonly shield: number;
  /** Ticks of spawn protection left. The ship cannot be damaged while above 0. */
  readonly invulnTicks: number;
  /** Ticks until the gun can fire again. */
  readonly fireCooldown: number;
  /** Ticks until the ship can crash into another asteroid (main.js:8509). */
  readonly crashTicks: number;
  /**
   * The ship has become a Fenix (main.js:5095): faster, fires beams, and
   * takes half from a crash. It lasts until the ship is destroyed.
   */
  readonly fenix: boolean;
  /** Heavy shots left in this life. */
  readonly heavyAmmo: number;
  /** Ticks until the next heavy shot can be fired. */
  readonly heavyCooldown: number;
  /** Ticks the homing shot has been charging, up to SIM.seekerChargeTicks. */
  readonly charge: number;
  /** Ticks until another homing shot can be charged. */
  readonly seekerCooldown: number;
  /** 0 to SIM.maxEnergy. Fills by itself; the boost and brake buttons spend it. */
  readonly energy: number;
  /** The boost button drove the ship on this tick. */
  readonly thrusting: boolean;
}

/** True while the ship flies above its top speed, by an orb or by the button. */
export const isBoosting = (s: ShipState): boolean => s.boostTicks > 0 || s.thrusting;

export const SPAWN_SEQ_MODULO = 256;

const PITCH_LIMIT = HALF_PI - SIM.pitchLimitMargin;
const KILL_RADIUS = SIM.planetRadius + SIM.planetKillMargin;
const KILL_RADIUS_SQ = KILL_RADIUS * KILL_RADIUS;

const SPEED_FOLLOW = Math.min(1, SIM.speedFollow * TICK_DT);
const SPEED_FOLLOW_BOOST = Math.min(1, SIM.speedFollowBoost * TICK_DT);
const BANK_FOLLOW = Math.min(1, SIM.bankFollow * TICK_DT);
const THROTTLE_STEP = SIM.throttleRate * TICK_DT;
const BRAKE_STEP = SIM.brakeRate * TICK_DT;
/** Braking costs nothing once the ship is this close to its lowest speed. */
const BRAKE_FLOOR = SIM.minSpeed + 1;
const YAW_STEP = SIM.yawRate * TICK_DT;
const PITCH_STEP = SIM.pitchRate * TICK_DT;

/** Top speed for a ship in this state (main.js:8697-8702). */
export function maxSpeedOf(boosting: boolean, fenix = false): number {
  const base = fenix ? SIM.fenixMaxSpeed : SIM.maxSpeed;
  return boosting ? base * SIM.boostMultiplier : base;
}

export function stepShip(s: ShipState, input: Input): ShipState {
  if (!s.alive) {
    return s.respawnTicks > 0 ? { ...s, respawnTicks: s.respawnTicks - 1 } : s;
  }

  const invulnTicks = s.invulnTicks > 0 ? s.invulnTicks - 1 : 0;

  // Homing shot (decision D23): the button charges it, and letting go of a
  // full charge fires it if the energy is there. The caller launches it; see
  // shotThisTick. A ship fires one thing a tick, and this comes first.
  let seekerCooldown = s.seekerCooldown > 0 ? s.seekerCooldown - 1 : 0;
  let charge = 0;
  let seekerFired = false;
  if (seekerCooldown === 0) {
    if (input.seek) charge = Math.min(SIM.seekerChargeTicks, s.charge + 1);
    else seekerFired = s.charge >= SIM.seekerChargeTicks && s.energy >= SIM.seekerCost;
  }
  if (seekerFired) seekerCooldown = SIM.seekerCooldownTicks;
  const energyLeft = seekerFired ? s.energy - SIM.seekerCost : s.energy;

  // Heavy shot (decision D22).
  let heavyAmmo = s.heavyAmmo;
  let heavyCooldown = s.heavyCooldown > 0 ? s.heavyCooldown - 1 : 0;
  const heavyFired = !seekerFired && input.heavy && heavyAmmo > 0 && heavyCooldown === 0;
  if (heavyFired) {
    heavyAmmo -= 1;
    heavyCooldown = SIM.heavyCooldownTicks;
  }

  // Gun (main.js:8837-8841): the cooldown runs down, and holding fire shoots
  // the moment it reaches zero. A ship fires one thing a tick, so the gun
  // waits for a heavy shot.
  let fireCooldown = s.fireCooldown > 0 ? s.fireCooldown - 1 : 0;
  if (input.fire && fireCooldown === 0 && !heavyFired && !seekerFired) {
    fireCooldown = SIM.fireCooldownTicks;
  }
  const crashTicks = s.crashTicks > 0 ? s.crashTicks - 1 : 0;

  // Boost timer (main.js:8690).
  const orbBoost = s.boostTicks > 0;
  const boostTicks = orbBoost ? s.boostTicks - 1 : 0;

  // The boost and brake buttons (decision D21). Each needs a tick's worth of
  // energy. An orb's boost is the stronger, so the button adds nothing to it;
  // boost wins over brake.
  const canThrust = energyLeft >= SIM.thrustCost;
  const thrusting = input.boost && !orbBoost && canThrust;
  const braking = input.brake && !orbBoost && !thrusting && canThrust && s.speed > BRAKE_FLOOR;
  const energy =
    thrusting || braking
      ? energyLeft - SIM.thrustCost
      : Math.min(SIM.maxEnergy, energyLeft + SIM.energyRegen);
  const boosting = orbBoost || thrusting;

  // Target speed (main.js:8697-8721).
  const topSpeed = s.fenix ? SIM.fenixMaxSpeed : SIM.maxSpeed;
  const maxSpeed = orbBoost
    ? topSpeed * SIM.boostMultiplier
    : thrusting
      ? topSpeed * SIM.thrustBoostMultiplier
      : topSpeed;
  let targetSpeed = s.targetSpeed;
  if (!boosting) targetSpeed = Math.min(targetSpeed, maxSpeed);
  if (input.throttle > 0) targetSpeed = Math.min(maxSpeed, targetSpeed + THROTTLE_STEP);
  if (input.throttle < 0) targetSpeed = Math.max(SIM.minSpeed, targetSpeed - THROTTLE_STEP);
  if (braking) targetSpeed = Math.max(SIM.minSpeed, targetSpeed - BRAKE_STEP);
  if (boosting) targetSpeed = maxSpeed;

  // Speed follows the target (main.js:8723), faster under boost or brake.
  const speed =
    s.speed + (targetSpeed - s.speed) * (boosting || braking ? SPEED_FOLLOW_BOOST : SPEED_FOLLOW);

  // Turning (main.js:8769-8774).
  const yawAxis = input.yaw / AXIS_MAX;
  const pitchAxis = input.pitch / AXIS_MAX;
  const yaw = wrapAngle(s.yaw + yawAxis * YAW_STEP);
  const pitch = clamp(s.pitch + pitchAxis * PITCH_STEP, -PITCH_LIMIT, PITCH_LIMIT);

  // Bank into the turn (main.js:8786-8791).
  const targetRoll = clamp(-yawAxis * SIM.bankPerYaw, -SIM.bankLimit, SIM.bankLimit);
  const roll = s.roll + (targetRoll - s.roll) * BANK_FOLLOW;

  // Move along the nose. Roll does not affect the heading (main.js:8800-8805).
  const cosPitch = cos(pitch);
  const distance = speed * TICK_DT;
  const x = s.x + sin(yaw) * cosPitch * distance;
  const z = s.z + cos(yaw) * cosPitch * distance;
  const y = clamp(s.y - sin(pitch) * distance, -SIM.maxY, SIM.maxY); // main.js:8809

  const moved: ShipState = {
    x,
    y,
    z,
    yaw,
    pitch,
    roll,
    speed,
    targetSpeed,
    boostTicks,
    alive: true,
    respawnTicks: 0,
    spawnSeq: s.spawnSeq,
    hp: s.hp,
    shield: s.shield,
    invulnTicks,
    fireCooldown,
    crashTicks,
    fenix: s.fenix,
    heavyAmmo,
    heavyCooldown,
    charge,
    seekerCooldown,
    energy,
    thrusting,
  };
  // The planet is at the origin and kills on contact (main.js:9620-9624).
  return x * x + y * y + z * z < KILL_RADIUS_SQ ? destroyed(moved) : moved;
}

/** The ship where it is, dead, with the respawn timer started. */
function destroyed(s: ShipState): ShipState {
  return {
    ...s,
    speed: 0,
    targetSpeed: 0,
    boostTicks: 0,
    alive: false,
    respawnTicks: SIM.respawnTicks,
    hp: 0,
    shield: 0,
    invulnTicks: 0,
    fireCooldown: 0,
    crashTicks: 0,
    fenix: false,
    heavyAmmo: 0,
    heavyCooldown: 0,
    charge: 0,
    seekerCooldown: 0,
    energy: 0,
    thrusting: false,
  };
}

/** What a ship can fire: the gun's bullet, a Fenix's beam, a heavy shot, or a homing shot. */
export type ShotKind = 'bullet' | 'beam' | 'heavy' | 'seeker';

/** What the step that produced `after` fired, or null. Never two things in a tick. */
export function shotThisTick(after: ShipState): ShotKind | null {
  if (!after.alive) return null;
  // A cooldown holds its full value only on the tick it was set.
  if (after.seekerCooldown === SIM.seekerCooldownTicks) return 'seeker';
  if (after.heavyCooldown === SIM.heavyCooldownTicks) return 'heavy';
  if (after.fireCooldown === SIM.fireCooldownTicks) return after.fenix ? 'beam' : 'bullet';
  return null;
}

/**
 * Damages a ship: the shield takes what it can and the hull takes the rest
 * (decision D8). Spawn protection and death both make it a no-op.
 */
export function damageShip(s: ShipState, amount: number): ShipState {
  if (!s.alive || s.invulnTicks > 0) return s;
  const absorbed = Math.min(s.shield, amount);
  const hp = Math.max(0, s.hp - (amount - absorbed));
  return hp === 0 ? destroyed(s) : { ...s, hp, shield: s.shield - absorbed };
}

/** Kills a ship outright, whatever its protection. */
export function destroyShip(s: ShipState): ShipState {
  return s.alive ? destroyed(s) : s;
}

/**
 * A fresh ship at a random point in the belt, facing +Z at cruise speed
 * (main.js:4608-4615 and 8615-8621). Only the server calls this: spawn points
 * come from the room's generator, so clients receive them.
 */
export function spawnShip(rng: Rng, spawnSeq: number): ShipState {
  const angle = rng.next() * TWO_PI;
  const radius = SIM.beltInner + rng.next() * (SIM.beltOuter - SIM.beltInner);
  return {
    x: cos(angle) * radius,
    y: (rng.next() - 0.5) * SIM.spawnYSpread,
    z: sin(angle) * radius,
    yaw: 0,
    pitch: 0,
    roll: 0,
    speed: SIM.startSpeed,
    targetSpeed: SIM.startSpeed,
    boostTicks: 0,
    alive: true,
    respawnTicks: 0,
    spawnSeq: spawnSeq % SPAWN_SEQ_MODULO,
    hp: SIM.maxHp,
    shield: 0,
    invulnTicks: SIM.invulnerableTicks,
    fireCooldown: 0,
    crashTicks: 0,
    fenix: false,
    heavyAmmo: SIM.heavyAmmo,
    heavyCooldown: 0,
    charge: 0,
    seekerCooldown: 0,
    energy: SIM.maxEnergy,
    thrusting: false,
  };
}

/** Exact comparison of every field. No tolerance: any bit of drift counts. */
export function shipStatesEqual(a: ShipState, b: ShipState): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.z === b.z &&
    a.yaw === b.yaw &&
    a.pitch === b.pitch &&
    a.roll === b.roll &&
    a.speed === b.speed &&
    a.targetSpeed === b.targetSpeed &&
    a.boostTicks === b.boostTicks &&
    a.alive === b.alive &&
    a.respawnTicks === b.respawnTicks &&
    a.spawnSeq === b.spawnSeq &&
    a.hp === b.hp &&
    a.shield === b.shield &&
    a.invulnTicks === b.invulnTicks &&
    a.fireCooldown === b.fireCooldown &&
    a.crashTicks === b.crashTicks &&
    a.fenix === b.fenix &&
    a.heavyAmmo === b.heavyAmmo &&
    a.heavyCooldown === b.heavyCooldown &&
    a.charge === b.charge &&
    a.seekerCooldown === b.seekerCooldown &&
    a.energy === b.energy &&
    a.thrusting === b.thrusting
  );
}
