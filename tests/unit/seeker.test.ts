import { describe, expect, it } from 'vitest';
import { SeekerTracks } from '../../src/net/seekers.ts';
import { SIM } from '../../src/shared/constants.ts';
import { NO_PLAYER } from '../../src/shared/protocol.ts';
import { Rng } from '../../src/shared/rng.ts';
import { bulletHit, shipHitDistance } from '../../src/shared/sim/bullets.ts';
import {
  SEEKER_STEP,
  launchSeeker,
  seekerExpired,
  seekerPath,
  stepSeeker,
} from '../../src/shared/sim/seeker.ts';
import {
  destroyShip,
  quantiseControls,
  shotThisTick,
  spawnShip,
  stepShip,
} from '../../src/shared/sim/ship.ts';
import type { Controls, ShipState } from '../../src/shared/sim/ship.ts';
import { TestWorld } from '../support/harness.ts';

function shipAt(x: number, z: number, overrides: Partial<ShipState> = {}): ShipState {
  return {
    ...spawnShip(new Rng(1), 0),
    x,
    y: 0,
    z,
    yaw: 0,
    invulnTicks: 0,
    speed: 60,
    targetSpeed: 60,
    ...overrides,
  };
}

const controls = (overrides: Partial<Controls>): ReturnType<typeof quantiseControls> =>
  quantiseControls({ yaw: 0, pitch: 0, throttle: 0, fire: false, ...overrides });

describe('charging the homing shot (decision D23)', () => {
  const HOLD = controls({ seek: true });
  const LET_GO = controls({});

  function hold(ship: ShipState, ticks: number): ShipState {
    let s = ship;
    for (let i = 0; i < ticks; i++) s = stepShip(s, HOLD);
    return s;
  }

  it('a second held and let go fires it, for two fifths of a tank', () => {
    const charged = hold(shipAt(0, 4000), SIM.seekerChargeTicks);
    expect(charged.charge).toBe(60);
    expect(shotThisTick(charged)).toBeNull();
    const fired = stepShip(charged, LET_GO);
    expect(shotThisTick(fired)).toBe('seeker');
    expect(fired.energy).toBe(SIM.maxEnergy - SIM.seekerCost + SIM.energyRegen);
    expect(fired.charge).toBe(0);
    expect(shotThisTick(stepShip(fired, LET_GO))).toBeNull();
  });

  it('holding longer keeps the charge; letting go early loses it', () => {
    expect(hold(shipAt(0, 4000), 500).charge).toBe(60);
    const early = stepShip(hold(shipAt(0, 4000), 59), LET_GO);
    expect(shotThisTick(early)).toBeNull();
    expect(early.charge).toBe(0);
    expect(early.energy).toBe(SIM.maxEnergy);
  });

  it('without the energy nothing leaves and nothing is spent', () => {
    const poor = hold(shipAt(0, 4000, { energy: 0 }), 60);
    const after = stepShip(poor, LET_GO);
    expect(shotThisTick(after)).toBeNull();
    expect(after.energy).toBeLessThan(SIM.seekerCost);
  });

  it('another cannot be charged until the first has had its 5 s', () => {
    let ship = stepShip(hold(shipAt(0, 4000), 60), LET_GO);
    ship = hold(ship, 298);
    expect(ship.charge).toBe(0);
    expect(hold(ship, 61).charge).toBe(60);
  });

  it('the gun and the heavy shot wait for it: one thing a tick', () => {
    const charged = hold(shipAt(0, 4000), 60);
    const fired = stepShip(charged, controls({ fire: true, heavy: true }));
    expect(shotThisTick(fired)).toBe('seeker');
    expect(fired.heavyAmmo).toBe(SIM.heavyAmmo);
    expect(shotThisTick(stepShip(fired, controls({ fire: true, heavy: true })))).toBe('heavy');
  });
});

describe('what it locks on to', () => {
  const shooter = shipAt(0, 4000);
  const lock = (...others: ShipState[]): number | null =>
    launchSeeker(
      0,
      100,
      shooter,
      others.map((ship, index) => ({ id: index + 1, ship })),
    ).targetId;

  it('the nearest ship in the cone ahead', () => {
    expect(lock(shipAt(0, 4800), shipAt(50, 4300), shipAt(0, 3990))).toBe(2);
  });

  it('not a ship behind, to the side, out of range, dead, protected, or itself', () => {
    expect(lock(shipAt(0, 3800))).toBeNull();
    expect(lock(shipAt(400, 4300))).toBeNull();
    expect(lock(shipAt(0, 4000 + SIM.seekerLockRange + 1))).toBeNull();
    expect(lock(destroyShip(shipAt(0, 4300)))).toBeNull();
    expect(lock(shipAt(0, 4300, { invulnTicks: 10 }))).toBeNull();
    expect(launchSeeker(1, 100, shooter, [{ id: 1, ship: shipAt(0, 4300) }]).targetId).toBeNull();
  });

  it('with nothing to follow it flies straight until its time is up', () => {
    let seeker = launchSeeker(0, 100, shooter, []);
    for (let tick = 101; tick <= 160; tick++) seeker = stepSeeker(seeker, null);
    expect(seeker.x).toBeCloseTo(0, 9);
    expect(seeker.z).toBeCloseTo(4000 + SIM.muzzleOffset + SIM.seekerSpeed, 6);
    expect(seekerExpired(seeker, 399)).toBe(false);
    expect(seekerExpired(seeker, 400)).toBe(true);
  });
});

/**
 * A homing shot is launched at a ship 400 units ahead that is flying at top
 * speed on `heading`. The ship turns as hard as it can from the moment the
 * shot is within `breakAt` units. Returns the tick of the hit, or null.
 */
function chase(heading: number, breakAt: number): number | null {
  const shooter = shipAt(0, 4000);
  let target = shipAt(0, 4400, { yaw: heading });
  let seeker = launchSeeker(1, 0, shooter, [{ id: 2, ship: target }]);
  let breaking = false;
  for (let tick = 1; !seekerExpired(seeker, tick); tick++) {
    const gap = Math.hypot(target.x - seeker.x, target.y - seeker.y, target.z - seeker.z);
    breaking ||= gap < breakAt;
    target = stepShip(target, controls({ yaw: breaking ? 1 : 0 }));
    seeker = stepSeeker(seeker, target);
    const path = seekerPath(seeker, tick);
    if (bulletHit(path, tick, target.x, target.y, target.z, shipHitDistance(path)) >= 0) {
      return tick;
    }
  }
  return null;
}

describe('the dodge is a choice with a right moment', () => {
  const AWAY = 0;
  const ACROSS = Math.PI / 2;
  const TOWARD = Math.PI;

  it.each([
    ['flying away', AWAY],
    ['crossing', ACROSS],
    ['head on', TOWARD],
  ])('a ship that flies straight is hit: %s', (_name, heading) => {
    expect(chase(heading, 0)).not.toBeNull();
  });

  it.each([
    ['flying away', AWAY],
    ['crossing', ACROSS],
    ['head on', TOWARD],
  ])('a hard turn with the shot 60 to 120 units off gets inside it: %s', (_name, heading) => {
    for (const breakAt of [60, 75, 90, 105, 120]) {
      // Head on, the two close at 200 u/s, so the turn has to start earlier.
      if (heading === TOWARD && breakAt < 90) continue;
      expect(chase(heading, breakAt), `turning at ${breakAt}`).toBeNull();
    }
  });

  it('turning at the last moment is too late', () => {
    expect(chase(AWAY, 30)).not.toBeNull();
    expect(chase(TOWARD, 30)).not.toBeNull();
  });

  it('it turns in a circle of 117 units, against a ship’s 30', () => {
    expect(SIM.seekerSpeed / SIM.seekerTurnRate).toBeCloseTo(116.7, 1);
    expect(SIM.maxSpeed / SIM.yawRate).toBe(30);
    // A quarter turn takes it a quarter of that circle.
    let seeker = launchSeeker(1, 0, shipAt(0, 4000), [{ id: 2, ship: shipAt(0, 4100) }]);
    const beside = shipAt(100_000, 4000, { speed: 0, targetSpeed: 0 });
    const ticks = Math.round((Math.PI / 2 / SIM.seekerTurnRate) * SIM.tickRate);
    for (let i = 0; i < ticks; i++) seeker = stepSeeker(seeker, beside);
    expect(seeker.dx).toBeGreaterThan(0.99);
    expect(Math.hypot(seeker.dx, seeker.dy, seeker.dz)).toBeCloseTo(1, 9);
  });

  it('a target that dies, respawns or jumps is let go of for good', () => {
    const target = shipAt(100, 4300);
    const seeker = launchSeeker(1, 0, shipAt(0, 4000), [{ id: 2, ship: target }]);
    expect(seeker.targetId).toBe(2);
    expect(stepSeeker(seeker, destroyShip(target)).targetId).toBeNull();
    const jumped = stepSeeker(seeker, { ...target, spawnSeq: target.spawnSeq + 1 });
    expect(jumped.targetId).toBeNull();
    expect(jumped.dx).toBe(seeker.dx);
    expect(stepSeeker(jumped, target).targetId).toBeNull();
  });
});

describe('through the room', () => {
  const STILL: Partial<ShipState> = {
    y: 0,
    pitch: 0,
    roll: 0,
    speed: 0,
    targetSpeed: 0,
    invulnTicks: 0,
    hp: SIM.maxHp,
  };

  it('charged, launched, seen coming by its target, and 40 off on arrival', () => {
    const world = new TestWorld(41, 0, false);
    let holding = false;
    const shooter = world.addClient({ controls: (): Controls => ({ ...IDLE, seek: holding }) });
    const target = world.addClient({ controls: (): Controls => IDLE });
    const watcher = world.addClient({ controls: (): Controls => IDLE });
    world.run(600);
    world.place(shooter.core.playerId, { ...STILL, x: 0, z: 4000, yaw: 0 });
    world.place(target.core.playerId, { ...STILL, x: 40, z: 4300, yaw: 0, shield: 25 });
    world.place(watcher.core.playerId, { ...STILL, x: -3000, z: -4000, yaw: Math.PI });
    world.run(1000);
    const correctionsBefore = shooter.corrections.length;
    const hitsBefore = world.hits.length;

    holding = true;
    world.run(1100);
    expect(shooter.core.state?.charge).toBe(SIM.seekerChargeTicks);
    expect(world.room.seekersInFlight).toHaveLength(0);
    holding = false;
    world.run(200);
    expect(world.room.seekersInFlight).toHaveLength(1);
    expect(world.room.seekersInFlight[0]?.targetId).toBe(target.core.playerId);

    let warned = false;
    let shooterSaw = false;
    let watcherSaw = false;
    for (let i = 0; i < 40 && world.hits.length === hitsBefore; i++) {
      world.run(100);
      warned ||= target.core.seekerViews().some((s) => s.targetId === target.core.playerId);
      shooterSaw ||= shooter.core.seekerViews().length > 0;
      watcherSaw ||= watcher.core.seekerViews().length > 0;
    }
    world.run(500);

    expect(world.hits.length - hitsBefore).toBe(1);
    expect(world.room.shipOf(target.core.playerId)).toMatchObject({ shield: 0, hp: 85 });
    expect(world.room.seekersInFlight).toHaveLength(0);
    expect(warned).toBe(true);
    expect(shooterSaw).toBe(true);
    // A ship far away with no part in it is not told.
    expect(watcherSaw).toBe(false);
    // Once it has landed, nobody goes on drawing it.
    expect(target.core.seekerViews()).toEqual([]);
    expect(shooter.core.seekerViews()).toEqual([]);
    expect(shooter.corrections.length).toBe(correctionsBefore);
  });

  const IDLE: Controls = { yaw: 0, pitch: 0, throttle: 0, fire: false };
});

describe('drawing between snapshots', () => {
  const entry = (
    z: number,
  ): { ownerId: number; targetId: number; x: number; y: number; z: number } => ({
    ownerId: 4,
    targetId: NO_PLAYER,
    x: 0,
    y: 0,
    z,
  });

  it('halfway between two samples is halfway along, pointing the way it flies', () => {
    const tracks = new SeekerTracks();
    tracks.arrived(100, [entry(0)]);
    expect(tracks.views(100)).toMatchObject([{ z: 0, dz: 0 }]);
    tracks.arrived(102, [entry(2 * SEEKER_STEP)]);
    const [view] = tracks.views(101);
    expect(view?.z).toBeCloseTo(SEEKER_STEP, 9);
    expect(view?.dz).toBeCloseTo(1, 9);
    expect(tracks.views(99)).toEqual([]);
  });

  it('one the newest snapshot leaves out is drawn to its last place, then dropped', () => {
    const tracks = new SeekerTracks();
    tracks.arrived(100, [entry(0)]);
    tracks.arrived(102, [entry(2 * SEEKER_STEP)]);
    tracks.arrived(104, []);
    expect(tracks.views(101)).toHaveLength(1);
    expect(tracks.views(102)).toEqual([]);
    expect(tracks.views(101)).toEqual([]);
  });

  it('the same owner’s next shot does not draw a line from the last one', () => {
    const tracks = new SeekerTracks();
    tracks.arrived(100, [entry(0)]);
    tracks.arrived(102, [entry(2 * SEEKER_STEP)]);
    tracks.arrived(104, [entry(900)]);
    expect(tracks.views(103)).toEqual([]);
    expect(tracks.views(104)).toMatchObject([{ z: 900 }]);
  });
});
