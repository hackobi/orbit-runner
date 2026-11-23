import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_MS, DoubleTaps, stickPress } from '../../src/client/input.ts';
import { SIM } from '../../src/shared/constants.ts';
import { TWO_PI } from '../../src/shared/math.ts';
import {
  decodeClientMessage,
  decodeShipState,
  encodeInput,
  encodeShipState,
} from '../../src/shared/protocol.ts';
import { sampleOf, sampleTrack } from '../../src/shared/remote.ts';
import { Rng } from '../../src/shared/rng.ts';
import { bulletHit, shipHitDistance } from '../../src/shared/sim/bullets.ts';
import { launchSeeker, seekerPath, stepSeeker } from '../../src/shared/sim/seeker.ts';
import type { Seeker } from '../../src/shared/sim/seeker.ts';
import {
  NEUTRAL_INPUT,
  STUNT_FLIP,
  STUNT_NONE,
  STUNT_ROLL_LEFT,
  STUNT_ROLL_RIGHT,
  inputFromWire,
  quantiseControls,
  shotThisTick,
  spawnShip,
  stepShip,
  stuntAngles,
} from '../../src/shared/sim/ship.ts';
import type { Controls, Input, ShipState, Stunt } from '../../src/shared/sim/ship.ts';

/** A ship at top speed flying straight along +Z, out of spawn protection. */
function flying(overrides: Partial<ShipState> = {}): ShipState {
  return {
    ...spawnShip(new Rng(1), 0),
    x: 0,
    y: 0,
    z: 4000,
    yaw: 0,
    invulnTicks: 0,
    speed: SIM.maxSpeed,
    targetSpeed: SIM.maxSpeed,
    ...overrides,
  };
}

const controls = (overrides: Partial<Controls>): Input =>
  quantiseControls({ yaw: 0, pitch: 0, throttle: 0, fire: false, ...overrides });
const ask = (stunt: Stunt): Input => controls({ stunt });

function run(ship: ShipState, input: Input, ticks: number): ShipState {
  let s = ship;
  for (let i = 0; i < ticks; i++) s = stepShip(s, input);
  return s;
}

describe('a barrel roll (decision D38)', () => {
  it('slides the ship to the side a turn that way goes, and leaves its heading and travel ahead alone', () => {
    const start = flying();
    const plain = run(start, NEUTRAL_INPUT, SIM.rollTicks);
    const left = run(stepShip(start, ask(STUNT_ROLL_LEFT)), NEUTRAL_INPUT, SIM.rollTicks - 1);
    const right = run(stepShip(start, ask(STUNT_ROLL_RIGHT)), NEUTRAL_INPUT, SIM.rollTicks - 1);

    // A left turn swings the nose toward +X from this heading.
    const turned = run(start, controls({ yaw: 1 }), 10);
    expect(turned.x).toBeGreaterThan(0);
    expect(left.x).toBeCloseTo(SIM.rollSlide, 9);
    expect(right.x).toBeCloseTo(-SIM.rollSlide, 9);
    for (const rolled of [left, right]) {
      expect(rolled.z).toBeCloseTo(plain.z, 9);
      expect(rolled.y).toBe(0);
      expect(rolled.yaw).toBe(0);
      expect(rolled.pitch).toBe(0);
      expect(rolled.stunt).toBe(STUNT_NONE);
      expect(rolled.stuntCooldown).toBe(SIM.stuntCooldownTicks);
    }
  });

  it('is paid for once, when it starts, and the ship can still steer and fire through it', () => {
    const started = stepShip(flying(), ask(STUNT_ROLL_LEFT));
    expect(started.stunt).toBe(STUNT_ROLL_LEFT);
    expect(started.energy).toBe(SIM.maxEnergy - SIM.rollCost + SIM.energyRegen);
    const next = stepShip(started, controls({ yaw: 1, fire: true }));
    expect(next.energy).toBe(started.energy + SIM.energyRegen);
    expect(next.yaw).toBeGreaterThan(0);
    expect(shotThisTick(next)).toBe('bullet');
  });

  it('turns the drawn ship once about its nose, to the left for a left roll', () => {
    const started = stepShip(flying(), ask(STUNT_ROLL_LEFT));
    const halfway = run(started, NEUTRAL_INPUT, SIM.rollTicks / 2 - 1);
    expect(stuntAngles(halfway).roll).toBeCloseTo(-Math.PI, 9);
    expect(stuntAngles(halfway).pitch).toBe(0);
    // A left turn banks to negative roll, so the roll starts the way the bank leans.
    expect(run(flying(), controls({ yaw: 1 }), 5).roll).toBeLessThan(0);
    expect(stuntAngles(run(started, NEUTRAL_INPUT, SIM.rollTicks)).roll).toBe(0);
  });
});

describe('a backflip (decision D38)', () => {
  it('is a loop: the ship comes out on its heading, where it went in but higher, having gone nowhere ahead', () => {
    const start = flying();
    const started = stepShip(start, ask(STUNT_FLIP));
    const top = run(started, NEUTRAL_INPUT, SIM.flipTicks / 2 - 1);
    expect(top.y).toBeCloseTo(2 * SIM.flipRadius + SIM.flipRise / 2, 9);
    expect(stuntAngles(top).pitch).toBeCloseTo(-Math.PI, 9);

    const out = run(started, NEUTRAL_INPUT, SIM.flipTicks - 1);
    expect(out.stunt).toBe(STUNT_NONE);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.z).toBeCloseTo(start.z, 9);
    expect(out.y).toBeCloseTo(SIM.flipRise, 9);
    expect(out.yaw).toBe(0);
    expect(out.pitch).toBe(0);
    expect(out.speed).toBeCloseTo(start.speed, 9);
    // A ship that flew straight on is a second's flight ahead by now.
    expect(run(start, NEUTRAL_INPUT, SIM.flipTicks).z - out.z).toBeCloseTo(SIM.maxSpeed, 6);
  });

  it('holds its heading whatever the stick does, and climbs along the ship’s own up when pitched', () => {
    const start = flying({ pitch: 0.5, yaw: 1 });
    const out = run(
      stepShip(start, ask(STUNT_FLIP)),
      controls({ yaw: 1, pitch: -1 }),
      SIM.flipTicks - 1,
    );
    expect(out.yaw).toBe(1);
    expect(out.pitch).toBe(0.5);
    // Up for a ship pitched nose down by 0.5 leans forward along its heading.
    expect(out.y - start.y).toBeCloseTo(SIM.flipRise * Math.cos(0.5), 9);
    expect(out.x - start.x).toBeCloseTo(SIM.flipRise * Math.sin(1) * Math.sin(0.5), 9);
  });

  it('fires nothing while it lasts, and keeps a homing charge for afterwards', () => {
    const charged = run(flying(), controls({ seek: true }), SIM.seekerChargeTicks);
    expect(charged.charge).toBe(SIM.seekerChargeTicks);
    let ship = stepShip(charged, controls({ stunt: STUNT_FLIP, fire: true, heavy: true }));
    expect(ship.stunt).toBe(STUNT_FLIP);
    for (let i = 1; i < SIM.flipTicks; i++) {
      expect(shotThisTick(ship)).toBeNull();
      ship = stepShip(ship, controls({ fire: true, heavy: true }));
    }
    expect(shotThisTick(ship)).toBeNull();
    expect(ship.heavyAmmo).toBe(SIM.heavyAmmo);
    expect(ship.charge).toBe(SIM.seekerChargeTicks);
    // The button was let go during the flip: the shot leaves on the first tick after it.
    expect(shotThisTick(stepShip(ship, NEUTRAL_INPUT))).toBe('seeker');
  });

  it('costs what a homing shot costs, and a ship short of that does not flip', () => {
    const started = stepShip(flying(), ask(STUNT_FLIP));
    expect(started.energy).toBe(SIM.maxEnergy - SIM.flipCost + SIM.energyRegen);
    const dry = stepShip(flying({ energy: SIM.flipCost - 1 }), ask(STUNT_FLIP));
    expect(dry.stunt).toBe(STUNT_NONE);
    expect(dry.energy).toBe(SIM.flipCost - 1 + SIM.energyRegen);
  });
});

describe('stunts: one at a time (decision D38)', () => {
  it('asking again during a stunt or in the pause after it does nothing', () => {
    let ship = stepShip(flying(), ask(STUNT_ROLL_LEFT));
    // Held down, as a lost packet makes the server repeat the last input.
    for (let i = 1; i < SIM.rollTicks + SIM.stuntCooldownTicks - 1; i++) {
      const before = ship;
      ship = stepShip(ship, ask(STUNT_FLIP));
      expect(ship.stunt === STUNT_FLIP).toBe(false);
      expect(ship.energy).toBe(Math.min(SIM.maxEnergy, before.energy + SIM.energyRegen));
    }
    // The pause has one tick left; on the next the flip asked for all along starts.
    expect(ship.stuntCooldown).toBe(1);
    expect(stepShip(ship, ask(STUNT_FLIP)).stunt).toBe(STUNT_FLIP);
  });

  it('a ship destroyed mid stunt comes back without one', () => {
    const ship = stepShip(
      flying({ x: 0, y: 0, z: SIM.planetRadius + 1, yaw: Math.PI }),
      ask(STUNT_FLIP),
    );
    const dead = run(ship, NEUTRAL_INPUT, 30);
    expect(dead.alive).toBe(false);
    expect(dead.stunt).toBe(STUNT_NONE);
    expect(dead.stuntTicks).toBe(0);
  });
});

describe('a homing shot against a backflip (decision D38)', () => {
  /** A shot dead astern of `ship`, locked on to it, `behind` units back on its track. */
  function astern(ship: ShipState, behind: number): Seeker {
    return {
      ownerId: 2,
      spawnTick: 0,
      targetId: 1,
      targetSpawnSeq: ship.spawnSeq,
      x: ship.x,
      y: ship.y,
      z: ship.z - behind,
      dx: 0,
      dy: 0,
      dz: 1,
    };
  }

  /** Flies the shot at the ship for its whole life. True if it hits. */
  function chase(behind: number, first: Input, then: Input = NEUTRAL_INPUT): boolean {
    let ship = flying();
    let seeker = astern(ship, behind);
    for (let tick = 1; tick <= SIM.seekerLifeTicks; tick++) {
      ship = stepShip(ship, tick === 1 ? first : then);
      seeker = stepSeeker(seeker, ship);
      const path = seekerPath(seeker, tick);
      if (bulletHit(path, tick, ship.x, ship.y, ship.z, shipHitDistance(path)) >= 0) return true;
    }
    return false;
  }

  const RANGES = [30, 60, 120, 240, 400, 550];

  it('hits a ship that flies straight on, from every range', () => {
    for (const behind of RANGES) expect(chase(behind, NEUTRAL_INPUT), `${behind}`).toBe(true);
  });

  it('misses a ship that flips and then flies straight on, from every range', () => {
    for (const behind of RANGES) expect(chase(behind, ask(STUNT_FLIP)), `${behind}`).toBe(false);
  });

  it('is not shaken off by a roll alone', () => {
    for (const behind of [120, 400]) {
      expect(chase(behind, ask(STUNT_ROLL_LEFT)), `${behind}`).toBe(true);
    }
  });

  it('a flip begun with the shot about to arrive is too late', () => {
    expect(chase(6, ask(STUNT_FLIP))).toBe(true);
  });

  it('loses its lock for good, and cannot lock on to a ship in a flip', () => {
    const flipping = stepShip(flying(), ask(STUNT_FLIP));
    const dropped = stepSeeker(astern(flipping, 100), flipping);
    expect(dropped.targetId).toBeNull();
    const shooter = flying({ z: 3800 });
    const others = [{ id: 1, ship: flipping }];
    expect(launchSeeker(2, 0, shooter, others).targetId).toBeNull();
    expect(launchSeeker(2, 0, shooter, [{ id: 1, ship: flying() }]).targetId).toBe(1);
  });
});

describe('stunts on the wire (protocol 15)', () => {
  it('an input carries the stunt asked for, and a stunt that does not exist is refused', () => {
    for (const stunt of [STUNT_NONE, STUNT_ROLL_LEFT, STUNT_ROLL_RIGHT, STUNT_FLIP] as const) {
      const sent = controls({ yaw: 0.5, fire: true, stunt });
      expect(decodeClientMessage(encodeInput(7, [sent]))).toEqual({
        type: 'input',
        tick: 7,
        inputs: [sent],
      });
    }
    expect(inputFromWire(0, 0, 0, false, false, false, false, false, 4, 0)).toBeNull();
    const bytes = encodeInput(7, [ask(STUNT_FLIP)]);
    // One input: type, tick, count, yaw, pitch, buttons, then the stunt.
    expect(bytes[9]).toBe(STUNT_FLIP);
    bytes[9] = 4;
    expect(decodeClientMessage(bytes)).toBeNull();
  });

  it('a ship mid stunt survives the wire, and a stunt that does not exist is refused', () => {
    const ship = run(stepShip(flying(), ask(STUNT_FLIP)), NEUTRAL_INPUT, 7);
    const bytes = encodeShipState(ship);
    expect(decodeShipState(bytes)).toEqual(ship);
    bytes[bytes.length - 3] = 9;
    expect(decodeShipState(bytes)).toBeNull();
  });

  it('other pilots are sent the ship as it is drawn, and it turns the short way between samples', () => {
    let ship = stepShip(flying(), ask(STUNT_ROLL_RIGHT));
    const samples = [sampleOf(1, ship)];
    for (let tick = 2; tick <= SIM.rollTicks; tick++) {
      ship = stepShip(ship, NEUTRAL_INPUT);
      if (tick % 2 === 1) samples.push(sampleOf(tick, ship));
    }
    for (const sample of samples) expect(Math.abs(sample.roll)).toBeLessThanOrEqual(Math.PI + 1e-3);
    // Across the half-way point the angle wraps from +π to −π; drawn, it must not swing back through zero.
    let previous = 0;
    let turned = 0;
    for (let tick = 1; tick <= SIM.rollTicks - 1; tick += 0.5) {
      const roll = sampleTrack(samples, tick, 0)?.roll ?? 0;
      let step = roll - previous;
      if (step > Math.PI) step -= TWO_PI;
      if (step < -Math.PI) step += TWO_PI;
      expect(step).toBeGreaterThan(-1e-3);
      expect(step).toBeLessThan(0.5);
      turned += step;
      previous = roll;
    }
    expect(turned).toBeGreaterThan(TWO_PI * 0.95);
  });
});

describe('asking for a stunt (decision D38)', () => {
  it('the second of two quick presses one way is the stunt; slow or mixed presses are not', () => {
    const taps = new DoubleTaps();
    expect(taps.press(STUNT_ROLL_LEFT, 1000)).toBe(STUNT_NONE);
    expect(taps.press(STUNT_ROLL_LEFT, 1000 + DOUBLE_TAP_MS)).toBe(STUNT_ROLL_LEFT);
    // The pair is spent: a third press starts again.
    expect(taps.press(STUNT_ROLL_LEFT, 1100 + DOUBLE_TAP_MS)).toBe(STUNT_NONE);
    expect(taps.press(STUNT_ROLL_LEFT, 1200 + 2 * DOUBLE_TAP_MS + 1)).toBe(STUNT_NONE);
    expect(taps.press(STUNT_ROLL_RIGHT, 3000)).toBe(STUNT_NONE);
    expect(taps.press(STUNT_ROLL_LEFT, 3100)).toBe(STUNT_NONE);
    expect(taps.press(STUNT_ROLL_LEFT, 3200)).toBe(STUNT_ROLL_LEFT);
    taps.press(STUNT_FLIP, 5000);
    taps.clear();
    expect(taps.press(STUNT_FLIP, 5100)).toBe(STUNT_NONE);
  });

  it('a stick pushed most of the way left, right or back is a press; anything less is not', () => {
    expect(stickPress(0.9, 0)).toBe(STUNT_ROLL_LEFT);
    expect(stickPress(-0.9, 0)).toBe(STUNT_ROLL_RIGHT);
    expect(stickPress(0, 0.9)).toBe(STUNT_FLIP);
    expect(stickPress(0.85, 0.95)).toBe(STUNT_FLIP);
    expect(stickPress(0.95, 0.85)).toBe(STUNT_ROLL_LEFT);
    expect(stickPress(0.7, 0.7)).toBe(STUNT_NONE);
    // Forward is not a stunt.
    expect(stickPress(0, -1)).toBe(STUNT_NONE);
  });
});
