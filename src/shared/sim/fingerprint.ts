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
import { asteroidAngle } from './belt.ts';
import { ORB_KINDS } from './orbs.ts';
import { damageShip, quantiseControls, spawnShip } from './ship.ts';
import type { Input, ShipState } from './ship.ts';
import { WorldLedger, applyOrb, createWorld, outsideCombatZone, stepPlayer } from './world.ts';
import type { WorldEffect } from './world.ts';

export interface TraceResult {
  hash: number;
  deaths: number;
  boostTicks: number;
  crashes: number;
  pickups: number;
  /** Wormhole jumps: the spawn number rose without a death. */
  jumps: number;
  /** Ticks flown as a Fenix, and ticks flown faster than an ordinary ship can without a boost. */
  fenixTicks: number;
  /** Times the hull or shield dropped outside the combat zone. */
  edgeHits: number;
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
 * throttle, boost, the boost and brake buttons and their energy, firing, the heavy shot, damage, death on the planet and by damage,
 * respawn with its protection, the orbits of the belt far into a room's
 * life, crashes into its rocks, every kind of orb, a wormhole jump, flight
 * as a Fenix, and the edge of the combat zone.
 */
export function runTrace(seed: number, ticks: number): TraceResult {
  const rng = new Rng(seed);
  // Start just above the kill radius, flying at the planet, so the run
  // begins with a death and a respawn.
  let ship: ShipState = { ...spawnShip(rng, 0), x: 0, y: 0, z: -1235 };
  let input: Input = quantiseControls({ yaw: 0, pitch: 0, throttle: 1, fire: true });
  let hash = 0x811c9dc5;
  let deaths = 0;
  let boostTicks = 0;
  let crashes = 0;

  // The clock starts weeks into a room's life, where the orbit angles are large.
  const world = createWorld(seed, SIM.asteroidCount, true);
  const ledger = new WorldLedger(world);
  const orbsByKind = ORB_KINDS.map((kind) =>
    [...world.orbs.orbs.keys()].filter((id) => world.orbs.orbs[id]?.kind === kind),
  );
  let pickups = 0;
  let visits = 0;
  let jumps = 0;
  let fenixTicks = 0;
  let edgeHits = 0;
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
        heavy: rng.next() < 0.2,
        boost: rng.next() < 0.25,
        brake: rng.next() < 0.25,
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
    // And on an orb of each kind in turn, so that it takes it: every kind
    // that changes a ship within the first 2,000 steps. Fenix orbs can only
    // be shot, which the trace does by applying one directly.
    if (ship.alive && step % 250 === 125) {
      const visit = visits++;
      const ofKind = orbsByKind[visit % ORB_KINDS.length] ?? [];
      const orbId = ofKind[(visit * 7) % Math.max(1, ofKind.length)] ?? 0;
      const orb = world.orbs.orbs[orbId];
      if (orb) {
        ship = { ...ship, x: orb.x, y: orb.y, z: orb.z };
        if (orb.kind === 'fenix') ship = applyOrb(ship, orbId, tick, world);
      }
    }
    // Out past the edge of the combat zone for a while.
    if (ship.alive && step % 2500 === 1150) ship = { ...ship, x: 9500, y: 0, z: 0, yaw: 1.5 };

    const wasAlive = ship.alive;
    const before = ship;
    effects.length = 0;
    ship = stepPlayer(ship, input, tick, world, ledger, effects);
    if (before.alive && ship.alive && ship.spawnSeq !== before.spawnSeq) jumps++;
    if (ship.alive && ship.fenix) fenixTicks++;
    if (
      effects.length === 0 &&
      outsideCombatZone(ship) &&
      ship.hp + ship.shield < before.hp + before.shield
    ) {
      edgeHits++;
    }
    for (const effect of effects) {
      if (effect.kind === 'asteroid') {
        ledger.asteroids.remove(effect.id, tick);
        crashes++;
      } else {
        ledger.orbs.remove(effect.id, tick);
        pickups++;
      }
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
  return { hash, deaths, boostTicks, crashes, pickups, jumps, fenixTicks, edgeHits, final: ship };
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
