// A fingerprint of the simulation as this engine actually computes it.
//
// It runs a short fixed flight and hashes every state it passes through, so
// it changes if a constant changes, if the step function changes, or if the
// JavaScript engine rounds anything differently. Client and server exchange
// it in the handshake: a client that would not predict the same bits as the
// server is turned away instead of being left to desync.

import { CONSTANTS_HASH, SIM } from '../constants.ts';
import { encodeShipState } from '../protocol.ts';
import { Rng } from '../rng.ts';
import { cos, sin } from '../math.ts';
import { DestroyedAsteroids, asteroidAngle, createBelt } from './belt.ts';
import { damageShip, quantiseControls, spawnShip } from './ship.ts';
import type { Input, ShipState } from './ship.ts';
import { stepPlayer } from './world.ts';
import type { World, WorldEffect } from './world.ts';

export interface TraceResult {
  hash: number;
  deaths: number;
  boostTicks: number;
  crashes: number;
  final: ShipState;
}

const scratch = new DataView(new ArrayBuffer(8));
const scratchBytes = new Uint8Array(scratch.buffer);

function mixNumber(hash: number, value: number): number {
  scratch.setFloat64(0, value, true);
  return mix(hash, scratchBytes);
}

function mix(hash: number, bytes: Uint8Array): number {
  let h = hash;
  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A fixed, seeded flight. It covers turning, pitching against the clamp,
 * throttle, boost, firing, damage, death on the planet and by damage,
 * respawn with its protection, the orbits of the belt far into a room's
 * life, and crashes into its rocks.
 */
export function runTrace(seed: number, ticks: number): TraceResult {
  const rng = new Rng(seed);
  // Start 400 units above the kill radius, flying at the planet, so the run
  // reaches a death and a respawn early.
  let ship: ShipState = { ...spawnShip(rng, 0), x: 0, y: 0, z: -1620 };
  let input: Input = quantiseControls({ yaw: 0, pitch: 0, throttle: 1, fire: true });
  let hash = 0x811c9dc5;
  let deaths = 0;
  let boostTicks = 0;
  let crashes = 0;

  // The clock starts weeks into a room's life, where the orbit angles are large.
  const world: World = { seed, belt: createBelt(seed, SIM.asteroidCount) };
  const destroyed = new DestroyedAsteroids(SIM.asteroidCount);
  const effects: WorldEffect[] = [];

  for (let step = 1; step <= ticks; step++) {
    const tick = TRACE_START_TICK + step;
    // Hold each input for a random while, as a player would.
    if (step > 600 && rng.next() < 0.05) {
      input = quantiseControls({
        yaw: rng.next() * 2.4 - 1.2,
        pitch: rng.next() * 2.4 - 1.2,
        throttle: Math.floor(rng.next() * 3) - 1,
        fire: rng.next() < 0.5,
      });
    }
    if (ship.alive && step % 1500 === 0) ship = { ...ship, boostTicks: 180 + (step % 181) };

    // Take a bullet's worth of damage now and then, and one fatal blow.
    if (step % 700 === 0) ship = damageShip(ship, SIM.bulletDamage);
    if (step === 1900) ship = damageShip(ship, SIM.maxHp + SIM.maxShield);
    // A shield now and then, so damage is seen coming off it first.
    if (ship.alive && step % 900 === 450) ship = { ...ship, shield: 40 };
    // Put the ship on a rock now and then, so that it crashes.
    const target = world.belt.asteroids[step % SIM.asteroidCount];
    if (ship.alive && target && step % 400 === 300) {
      const angle = asteroidAngle(target, tick);
      ship = {
        ...ship,
        x: cos(angle) * target.orbitRadius,
        y: target.y,
        z: sin(angle) * target.orbitRadius,
        invulnTicks: 0,
        crashTicks: 0,
      };
    }

    const wasAlive = ship.alive;
    effects.length = 0;
    ship = stepPlayer(ship, input, tick, world, destroyed, effects);
    for (const effect of effects) {
      destroyed.destroy(effect.id, tick);
      crashes++;
      hash = mix(hash, Uint8Array.of(effect.id & 255, effect.id >> 8));
    }
    if (wasAlive && !ship.alive) deaths++;
    if (ship.boostTicks > 0) boostTicks++;
    if (!ship.alive && ship.respawnTicks === 0) ship = spawnShip(rng, ship.spawnSeq + 1);

    hash = mix(hash, encodeShipState(ship));
    // One rock's angle each tick, a different rock every time.
    const rock = world.belt.asteroids[(step * 7) % SIM.asteroidCount];
    if (rock) hash = mixNumber(hash, asteroidAngle(rock, tick));
  }
  return { hash, deaths, boostTicks, crashes, final: ship };
}

/** Thirty days at 60 ticks a second. */
const TRACE_START_TICK = 30 * 24 * 3600 * 60;

const TWO_POW_MINUS_30 = 1 / 1073741824;

/**
 * Counts how often this engine merges a multiply and an add into one fused
 * operation. That is legal on some CPUs but rounds differently, and would
 * make two machines disagree. For a = 1 + k·2⁻³⁰ the product a·a rounds to
 * exactly 1 + 2k·2⁻³⁰, so a·a − c is 0 when the steps are separate and
 * k²·2⁻⁶⁰ when they are fused. The loop is long enough to reach the
 * optimising compiler. JavaScript requires the answer to be 0.
 */
export function fusedMultiplyProbe(iterations: number): number {
  let fused = 0;
  for (let i = 0; i < iterations; i++) {
    const k = (i % 7) + 1;
    const a = 1 + k * TWO_POW_MINUS_30;
    const c = 1 + 2 * k * TWO_POW_MINUS_30;
    if (a * a - c !== 0) fused++;
  }
  return fused;
}

const FINGERPRINT_SEED = 0x0b17;
const FINGERPRINT_TICKS = 2000;

function computeFingerprint(): number {
  const trace = runTrace(FINGERPRINT_SEED, FINGERPRINT_TICKS);
  const probe = fusedMultiplyProbe(20_000);
  return (Math.imul(trace.hash ^ CONSTANTS_HASH, 0x01000193) ^ probe) >>> 0;
}

/** Computed once when the module loads. About a millisecond. */
export const SIM_FINGERPRINT = computeFingerprint();
