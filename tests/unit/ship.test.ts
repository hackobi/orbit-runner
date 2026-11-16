import { describe, expect, it } from 'vitest';
import { SIM, TICK_DT } from '../../src/shared/constants.ts';
import { HALF_PI } from '../../src/shared/math.ts';
import { decodeShipState, encodeShipState } from '../../src/shared/protocol.ts';
import { Rng } from '../../src/shared/rng.ts';
import { SIM_FINGERPRINT, fusedMultiplyProbe, runTrace } from '../../src/shared/sim/fingerprint.ts';
import {
  NEUTRAL_INPUT,
  inputFromWire,
  quantiseControls,
  shipStatesEqual,
  spawnShip,
  stepShip,
} from '../../src/shared/sim/ship.ts';
import type { Input, ShipState } from '../../src/shared/sim/ship.ts';

const controls = (yaw: number, pitch: number, throttle: number): Input =>
  quantiseControls({ yaw, pitch, throttle, fire: false });

function fresh(overrides: Partial<ShipState> = {}): ShipState {
  return { ...spawnShip(new Rng(1), 0), x: 0, y: 0, z: 4000, ...overrides };
}

function run(ship: ShipState, input: Input, ticks: number): ShipState {
  let s = ship;
  for (let i = 0; i < ticks; i++) s = stepShip(s, input);
  return s;
}

describe('flight model (v1 main.js:8690-8809)', () => {
  it('cruises straight along +Z at 20 u/s with no input', () => {
    const s = run(fresh(), NEUTRAL_INPUT, 60);
    expect(s.x).toBe(0);
    expect(s.y).toBe(0);
    expect(s.z).toBeCloseTo(4020, 9);
    expect(s.speed).toBe(20);
  });

  it('throttle moves the target at 22 u/s² and stops at 60 and at 5', () => {
    const up = run(fresh(), controls(0, 0, 1), 60);
    expect(up.targetSpeed).toBeCloseTo(42, 9);
    expect(run(fresh(), controls(0, 0, 1), 600).targetSpeed).toBe(SIM.maxSpeed);
    expect(run(fresh(), controls(0, 0, -1), 600).targetSpeed).toBe(SIM.minSpeed);
  });

  it('speed follows the target by 6·dt of the gap per tick', () => {
    const s = stepShip(fresh({ targetSpeed: 60 }), NEUTRAL_INPUT);
    expect(s.speed).toBeCloseTo(20 + 40 * 6 * TICK_DT, 12);
  });

  it('yaws at 2 rad/s and pitches at 1.35 rad/s', () => {
    const s = run(fresh(), controls(1, 1, 0), 30);
    expect(s.yaw).toBeCloseTo(1.0, 12);
    expect(s.pitch).toBeCloseTo(0.675, 12);
  });

  it('positive yaw turns toward +X and positive pitch dives toward −Y (decision D10)', () => {
    const turned = run(fresh(), controls(1, 0, 0), 30);
    expect(turned.x).toBeGreaterThan(0);
    const dived = run(fresh(), controls(0, 1, 0), 30);
    expect(dived.y).toBeLessThan(0);
  });

  it('clamps pitch at ±(π/2 − 0.05)', () => {
    expect(run(fresh(), controls(0, 1, 0), 600).pitch).toBe(HALF_PI - 0.05);
    expect(run(fresh(), controls(0, -1, 0), 600).pitch).toBe(-(HALF_PI - 0.05));
  });

  it('banks against the turn, to at most 0.7 rad', () => {
    const s = run(fresh(), controls(1, 0, 0), 600);
    expect(s.roll).toBeCloseTo(-0.7, 6);
    expect(run(s, NEUTRAL_INPUT, 600).roll).toBeCloseTo(0, 6);
  });

  it('boost holds the target at 184.8 u/s, then the target falls back to 60', () => {
    const boosted = run(fresh({ boostTicks: 120 }), NEUTRAL_INPUT, 120);
    expect(boosted.targetSpeed).toBeCloseTo(60 * 3.08, 9);
    expect(boosted.speed).toBeGreaterThan(180);
    expect(boosted.boostTicks).toBe(0);
    const after = stepShip(boosted, NEUTRAL_INPUT);
    expect(after.targetSpeed).toBe(60);
  });

  it('a half turn takes 1.57 s: the number to tune if dogfights need it', () => {
    const ticks = Math.ceil(Math.PI / (SIM.yawRate * TICK_DT));
    expect(ticks / SIM.tickRate).toBeCloseTo(1.57, 1);
    const turned = run(fresh(), controls(1, 0, 0), ticks);
    expect(Math.abs(turned.yaw)).toBeGreaterThan(Math.PI - 0.05);
  });

  it('clamps Y at ±500', () => {
    const s = run(fresh({ y: 490 }), controls(0, -1, 1), 1200);
    expect(s.y).toBe(SIM.maxY);
  });

  it('keeps yaw in (−π, π] through many turns', () => {
    let s = fresh();
    for (let i = 0; i < 2000; i++) {
      s = stepShip(s, controls(1, 0, 0));
      expect(s.yaw).toBeGreaterThan(-Math.PI);
      expect(s.yaw).toBeLessThanOrEqual(Math.PI);
    }
  });
});

describe('energy, boost and brake (decision D21)', () => {
  const boost = quantiseControls({ yaw: 0, pitch: 0, throttle: 0, fire: false, boost: true });
  const brake = quantiseControls({ yaw: 0, pitch: 0, throttle: 0, fire: false, brake: true });

  it('a ship spawns with a full tank, and an empty one fills in 20 s', () => {
    expect(fresh().energy).toBe(SIM.maxEnergy);
    const filling = run(fresh({ energy: 0 }), NEUTRAL_INPUT, 20 * SIM.tickRate - 1);
    expect(filling.energy).toBeLessThan(SIM.maxEnergy);
    expect(stepShip(filling, NEUTRAL_INPUT).energy).toBe(SIM.maxEnergy);
    expect(run(filling, NEUTRAL_INPUT, 100).energy).toBe(SIM.maxEnergy);
  });

  it('the boost button reaches 120 u/s and a full tank lasts 2.5 s', () => {
    const ticks = SIM.maxEnergy / SIM.thrustCost;
    expect(ticks / SIM.tickRate).toBe(2.5);
    const boosted = run(fresh({ speed: 60, targetSpeed: 60 }), boost, ticks);
    expect(boosted.thrusting).toBe(true);
    expect(boosted.energy).toBe(0);
    expect(boosted.targetSpeed).toBe(120);
    expect(boosted.speed).toBeGreaterThan(115);
    // Out of energy: the boost stops and the target falls back to top speed.
    const after = stepShip(boosted, boost);
    expect(after.thrusting).toBe(false);
    expect(after.targetSpeed).toBe(60);
    expect(after.energy).toBe(SIM.energyRegen);
  });

  it('the button adds nothing to an orb boost and costs nothing during one', () => {
    const s = stepShip(fresh({ boostTicks: 100 }), boost);
    expect(s.thrusting).toBe(false);
    expect(s.energy).toBe(SIM.maxEnergy);
    expect(s.targetSpeed).toBeCloseTo(60 * 3.08, 9);
  });

  it('the brake sheds speed far faster than the throttle, and is free once slow', () => {
    const fast = fresh({ speed: 60, targetSpeed: 60 });
    const braked = run(fast, brake, 60);
    const throttled = run(fast, controls(0, 0, -1), 60);
    expect(braked.speed).toBeLessThan(7);
    expect(throttled.speed).toBeGreaterThan(35);
    expect(braked.energy).toBeLessThan(SIM.maxEnergy);
    // At its lowest speed the brake has nothing to do, so the tank fills.
    const slow = run(braked, brake, 300);
    expect(slow.energy).toBeGreaterThan(braked.energy);
  });

  it('with an empty tank the buttons do nothing', () => {
    const empty = fresh({ energy: 0, speed: 60, targetSpeed: 60 });
    expect(stepShip(empty, boost).targetSpeed).toBe(60);
    expect(stepShip(empty, brake).targetSpeed).toBe(60);
  });

  it('a destroyed ship has no energy and respawns full', () => {
    const dead = run(fresh({ x: 0, y: 0, z: 1225, yaw: Math.PI }), NEUTRAL_INPUT, 30);
    expect(dead.alive).toBe(false);
    expect(dead.energy).toBe(0);
  });
});

describe('planet and respawn', () => {
  it('kills the ship inside radius 1220 and starts a 3 s respawn timer', () => {
    const s = run(fresh({ z: -1225 }), NEUTRAL_INPUT, 30);
    expect(s.alive).toBe(false);
    expect(s.respawnTicks).toBeLessThanOrEqual(SIM.respawnTicks);
    expect(Math.hypot(s.x, s.y, s.z)).toBeLessThan(1220);
  });

  it('a dead ship does not move and counts down to zero', () => {
    const dead = run(fresh({ z: -1221 }), NEUTRAL_INPUT, 5);
    expect(dead.alive).toBe(false);
    const later = run(dead, controls(1, 1, 1), 500);
    expect(later.respawnTicks).toBe(0);
    expect([later.x, later.y, later.z]).toEqual([dead.x, dead.y, dead.z]);
  });

  it('spawns in the belt, level, at cruise speed', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 500; i++) {
      const s = spawnShip(rng, i);
      const r = Math.hypot(s.x, s.z);
      expect(r).toBeGreaterThanOrEqual(SIM.beltInner - 1e-9);
      expect(r).toBeLessThanOrEqual(SIM.beltOuter + 1e-9);
      expect(Math.abs(s.y)).toBeLessThanOrEqual(50);
      expect([s.yaw, s.pitch, s.roll, s.speed]).toEqual([0, 0, 0, 20]);
      expect(s.spawnSeq).toBe(i % 256);
    }
  });
});

describe('inputs', () => {
  it('quantise to integers and clamp to ±127', () => {
    expect(controls(5, -5, 9)).toMatchObject({ yaw: 127, pitch: -127, throttle: 1, fire: false });
    expect(controls(0.5, 0, -0.2)).toMatchObject({ yaw: 64, pitch: 0, throttle: -1, fire: false });
    expect(controls(Number.NaN, 0, 0).yaw).toBe(0);
  });

  it('no control value turns faster than the full axis', () => {
    const full = stepShip(fresh(), controls(1, 0, 0));
    const over = stepShip(fresh(), controls(50, 0, 0));
    expect(over.yaw).toBe(full.yaw);
  });

  it('wire values out of range are refused', () => {
    expect(inputFromWire(128, 0, 0, false, false, false, false, false, 0)).toBeNull();
    expect(inputFromWire(0, -128, 0, false, false, false, false, false, 0)).toBeNull();
    expect(inputFromWire(0.5, 0, 0, false, false, false, false, false, 0)).toBeNull();
    expect(inputFromWire(0, 0, 2, false, false, false, false, false, 0)).toBeNull();
    expect(inputFromWire(0, 0, 0, true, false, false, false, false, -1)).toBeNull();
    expect(inputFromWire(0, 0, 0, true, false, false, false, false, 1.5)).toBeNull();
    expect(inputFromWire(127, -127, -1, true, false, false, false, false, 100)).not.toBeNull();
  });
});

describe('determinism', () => {
  it('two runs of 10,000 ticks give byte-identical state at every tick', () => {
    const a = runTrace(20261113, 10_000);
    const b = runTrace(20261113, 10_000);
    expect(a.hash).toBe(b.hash);
    expect(Array.from(encodeShipState(a.final))).toEqual(Array.from(encodeShipState(b.final)));
  });

  it.each([
    ['the pinned 10,000-tick trace', 20261113, 10_000],
    // The one the handshake compares: 2,000 ticks from the fingerprint's own seed.
    ['the 2,000-tick handshake trace', 0x0b17, 2000],
  ])(
    '%s reaches every branch of the step: death, crash, orb, jump, boost, Fenix, edge',
    (_n, seed, ticks) => {
      const t = runTrace(seed, ticks);
      expect(t.deaths).toBeGreaterThan(0);
      expect(t.crashes).toBeGreaterThan(2);
      expect(t.pickups).toBeGreaterThan(4);
      expect(t.jumps).toBeGreaterThan(0);
      expect(t.boostTicks).toBeGreaterThan(100);
      expect(t.fenixTicks).toBeGreaterThan(100);
      expect(t.edgeHits).toBeGreaterThan(2);
      expect(t.final.spawnSeq).toBeGreaterThan(0);
    },
  );

  it('gives the pinned hash on this machine', () => {
    // Recorded on an ARM64 Mac (Node 22; Chromium, WebKit and Firefox are
    // checked against Node by tests/e2e/determinism.spec.ts).
    // If this fails on another CPU with no change to the simulation, the
    // simulation is not portable and prediction will not match the server.
    // If the simulation or a constant changed on purpose, update the number.
    expect(runTrace(20261113, 10_000).hash).toBe(2128846202);
  });

  it('never fuses a multiply and an add, even in optimised code', () => {
    expect(fusedMultiplyProbe(2_000_000)).toBe(0);
  });

  it('the handshake fingerprint is stable and non-trivial', () => {
    expect(SIM_FINGERPRINT).toBeGreaterThan(0);
    expect(Number.isInteger(SIM_FINGERPRINT)).toBe(true);
  });

  it('a different seed gives a different run', () => {
    expect(runTrace(1, 2000).hash).not.toBe(runTrace(2, 2000).hash);
  });

  it('a state that went over the wire steps to the same bits', () => {
    const rng = new Rng(7);
    let s = spawnShip(rng, 0);
    for (let i = 0; i < 3000; i++) {
      const input = controls(
        rng.next() * 2 - 1,
        rng.next() * 2 - 1,
        Math.floor(rng.next() * 3) - 1,
      );
      if (i === 100) s = { ...s, boostTicks: 200 };
      const decoded = decodeShipState(encodeShipState(s));
      expect(decoded).not.toBeNull();
      if (!decoded) return;
      const direct = stepShip(s, input);
      expect(shipStatesEqual(stepShip(decoded, input), direct)).toBe(true);
      s = direct;
    }
  });
});
