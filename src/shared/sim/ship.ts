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
  viewDelay: number,
): Input | null {
  if (!Number.isInteger(yaw) || yaw < -AXIS_MAX || yaw > AXIS_MAX) return null;
  if (!Number.isInteger(pitch) || pitch < -AXIS_MAX || pitch > AXIS_MAX) return null;
  if (throttle !== -1 && throttle !== 0 && throttle !== 1) return null;
  if (!Number.isInteger(viewDelay) || viewDelay < 0) return null;
  return { yaw, pitch, throttle, fire, viewDelay: Math.min(viewDelay, MAX_VIEW_DELAY) } as Input;
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
  /** Ticks of spawn protection left. The ship cannot be damaged while above 0. */
  readonly invulnTicks: number;
  /** Ticks until the gun can fire again. */
  readonly fireCooldown: number;
}

export const SPAWN_SEQ_MODULO = 256;

const PITCH_LIMIT = HALF_PI - SIM.pitchLimitMargin;
const KILL_RADIUS = SIM.planetRadius + SIM.planetKillMargin;
const KILL_RADIUS_SQ = KILL_RADIUS * KILL_RADIUS;

const SPEED_FOLLOW = Math.min(1, SIM.speedFollow * TICK_DT);
const SPEED_FOLLOW_BOOST = Math.min(1, SIM.speedFollowBoost * TICK_DT);
const BANK_FOLLOW = Math.min(1, SIM.bankFollow * TICK_DT);
const THROTTLE_STEP = SIM.throttleRate * TICK_DT;
const YAW_STEP = SIM.yawRate * TICK_DT;
const PITCH_STEP = SIM.pitchRate * TICK_DT;

/** Top speed for a ship in this state (main.js:8697-8702). */
export function maxSpeedOf(boosting: boolean): number {
  return boosting ? SIM.maxSpeed * SIM.boostMultiplier : SIM.maxSpeed;
}

export function stepShip(s: ShipState, input: Input): ShipState {
  if (!s.alive) {
    return s.respawnTicks > 0 ? { ...s, respawnTicks: s.respawnTicks - 1 } : s;
  }

  const invulnTicks = s.invulnTicks > 0 ? s.invulnTicks - 1 : 0;

  // Gun (main.js:8837-8841): the cooldown runs down, and holding fire shoots
  // the moment it reaches zero. The caller spawns the bullet; see firedThisTick.
  let fireCooldown = s.fireCooldown > 0 ? s.fireCooldown - 1 : 0;
  if (input.fire && fireCooldown === 0) fireCooldown = SIM.fireCooldownTicks;

  // Boost timer (main.js:8690).
  const boosting = s.boostTicks > 0;
  const boostTicks = boosting ? s.boostTicks - 1 : 0;

  // Target speed (main.js:8697-8721).
  const maxSpeed = maxSpeedOf(boosting);
  let targetSpeed = s.targetSpeed;
  if (!boosting) targetSpeed = Math.min(targetSpeed, maxSpeed);
  if (input.throttle > 0) targetSpeed = Math.min(maxSpeed, targetSpeed + THROTTLE_STEP);
  if (input.throttle < 0) targetSpeed = Math.max(SIM.minSpeed, targetSpeed - THROTTLE_STEP);
  if (boosting) targetSpeed = maxSpeed;

  // Speed follows the target (main.js:8723).
  const speed = s.speed + (targetSpeed - s.speed) * (boosting ? SPEED_FOLLOW_BOOST : SPEED_FOLLOW);

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
    invulnTicks,
    fireCooldown,
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
    invulnTicks: 0,
    fireCooldown: 0,
  };
}

/** True if the step that produced `after` fired the gun. */
export function firedThisTick(after: ShipState): boolean {
  // The cooldown holds its full value only on the tick it was set.
  return after.alive && after.fireCooldown === SIM.fireCooldownTicks;
}

/** Takes hit points off a ship. Spawn protection and death both make it a no-op. */
export function damageShip(s: ShipState, amount: number): ShipState {
  if (!s.alive || s.invulnTicks > 0) return s;
  const hp = Math.max(0, s.hp - amount);
  return hp === 0 ? destroyed(s) : { ...s, hp };
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
    invulnTicks: SIM.invulnerableTicks,
    fireCooldown: 0,
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
    a.invulnTicks === b.invulnTicks &&
    a.fireCooldown === b.fireCooldown
  );
}
