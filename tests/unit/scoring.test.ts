import { describe, expect, it } from 'vitest';
import { SIM, TICK_MS } from '../../src/shared/constants.ts';
import {
  SCORE,
  STORE_PRICES,
  asteroidScore,
  inBelt,
  killScore,
  orbScore,
} from '../../src/shared/scoring.ts';
import { asteroidPosition } from '../../src/shared/sim/belt.ts';
import type { OrbKind } from '../../src/shared/sim/orbs.ts';
import type { ShipState } from '../../src/shared/sim/ship.ts';
import { hunter } from '../../src/net/behaviours.ts';
import { TestWorld, profileLink } from '../support/harness.ts';
import type { TestClient } from '../support/harness.ts';

const STILL: Partial<ShipState> = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  speed: 20,
  targetSpeed: 20,
  invulnTicks: 0,
  crashTicks: 0,
  boostTicks: 0,
  hp: SIM.maxHp,
  shield: 0,
  fenix: false,
};

describe('what things are worth (v1 main.js:4605-4655)', () => {
  it('a rock is 160, doubled in the belt, doubled again by the miner orb', () => {
    expect(asteroidScore(false)).toBe(320);
    expect(asteroidScore(true)).toBe(640);
  });

  it('orbs are 110 times their kind, with the same doublings', () => {
    expect(orbScore('shield', false)).toBe(1100);
    expect(orbScore('pink', false)).toBe(2200);
    expect(orbScore('boost', false)).toBe(1100);
    expect(orbScore('zaphire', false)).toBe(220);
    expect(orbScore('pink', true)).toBe(4400);
    for (const kind of ['fenix', 'wormhole', 'miner', 'hunter'] as const) {
      expect(orbScore(kind, true)).toBe(0);
    }
  });

  it('a kill is 330, doubled over the belt, doubled again by the hunter orb', () => {
    expect(killScore(0, 8000, false)).toBe(330);
    expect(killScore(0, 4000, false)).toBe(660);
    expect(killScore(0, 4000, true)).toBe(1320);
  });

  it('the belt is 3,600 to 5,200 units from the axis, at any height', () => {
    expect(inBelt(3599, 0)).toBe(false);
    expect(inBelt(3600, 0)).toBe(true);
    expect(inBelt(0, -5200)).toBe(true);
    expect(inBelt(0, 5201)).toBe(false);
  });
});

/** A thin belt with every orb, so one thing at a time decides the score. */
const SPARSE = 150;

/** An orb of a kind with nothing else near it just now. */
function loneOrb(world: TestWorld, kind: OrbKind): number {
  const orbs = world.room.world.orbs.orbs;
  const rocks = world.room.world.belt.asteroids;
  for (const [id, orb] of orbs.entries()) {
    if (orb.kind !== kind) continue;
    const crowded =
      orbs.some(
        (other, otherId) =>
          otherId !== id && Math.hypot(other.x - orb.x, other.y - orb.y, other.z - orb.z) < 100,
      ) ||
      rocks.some((rock) => {
        const p = asteroidPosition(rock, world.room.tick);
        return Math.hypot(p.x - orb.x, p.z - orb.z) < 300;
      });
    if (!crowded) return id;
  }
  throw new Error(`no lone ${kind} orb`);
}

function flyAt(world: TestWorld, playerId: number, kind: OrbKind): void {
  const orb = world.room.world.orbs.orbs[loneOrb(world, kind)];
  if (!orb) throw new Error('no orb');
  world.place(playerId, { ...STILL, x: orb.x, y: orb.y, z: orb.z - 20 });
}

/** High above the belt's plane but over it; or far outside it. Nothing to run into either way. */
const OVER_THE_BELT = { ...STILL, x: 0, y: 400, z: 4400, speed: 5, targetSpeed: 5 };
const OUTSIDE_THE_BELT = { ...STILL, x: 0, y: 400, z: 7000, speed: 5, targetSpeed: 5 };

/**
 * Every jump in a player's score, as the server made it. The belt's trickle
 * of a point or two is left out, also when it lands on the tick of a jump:
 * everything else is worth a multiple of ten.
 */
function watchScore(world: TestWorld, playerId: number): number[] {
  const jumps: number[] = [];
  let last = world.room.scoreOf(playerId);
  world.clock.every(TICK_MS / 2, () => {
    const now = world.room.scoreOf(playerId);
    if (Math.abs(now - last) > 2) jumps.push(Math.floor((now - last) / 10) * 10);
    last = now;
  });
  return jumps;
}

function solo(): { world: TestWorld; pilot: TestClient } {
  const world = new TestWorld(31, SPARSE);
  const pilot = world.addClient({});
  world.run(1500);
  world.place(pilot.core.playerId, OUTSIDE_THE_BELT);
  world.room.addScore(pilot.core.playerId, -world.room.scoreOf(pilot.core.playerId));
  return { world, pilot };
}

describe('scoring on the server', () => {
  it('orbs pay on pickup; the miner orb doubles the next ones for 30 s', () => {
    const { world, pilot } = solo();
    const id = pilot.core.playerId;
    const jumps = watchScore(world, id);

    flyAt(world, id, 'shield');
    world.run(1500);
    expect(jumps).toEqual([1100]);

    flyAt(world, id, 'miner');
    world.run(1500);
    expect(jumps).toEqual([1100]);
    expect(pilot.core.asteroidMultTicks).toBeGreaterThan(SCORE.multiplierTicks - 200);
    expect(pilot.core.asteroidMultTicks).toBeLessThanOrEqual(SCORE.multiplierTicks);

    flyAt(world, id, 'pink');
    world.run(1500);
    expect(jumps).toEqual([1100, 4400]);

    // Thirty seconds on, the doubling has run out.
    world.place(id, OUTSIDE_THE_BELT);
    world.run(31_000);
    expect(pilot.core.asteroidMultTicks).toBe(0);
    flyAt(world, id, 'zaphire');
    world.run(1500);
    expect(jumps).toEqual([1100, 4400, 220]);
    // The client's own figure is the server's.
    world.place(id, OUTSIDE_THE_BELT);
    world.run(500);
    expect(pilot.core.score).toBe(world.room.scoreOf(id));
  });

  it('being in the belt pays 1 a second, 2 for 10 s after firing, and nothing outside it', () => {
    const world = new TestWorld(31, SPARSE, false);
    let fire = false;
    const pilot = world.addClient({
      controls: () => ({ yaw: 0, pitch: 0, throttle: 0, fire }),
    });
    world.run(1500);
    const id = pilot.core.playerId;
    const earned = (ms: number): number => {
      const before = world.room.scoreOf(id);
      world.run(ms);
      return world.room.scoreOf(id) - before;
    };

    world.place(id, OUTSIDE_THE_BELT);
    expect(earned(10_000)).toBe(0);

    world.place(id, OVER_THE_BELT);
    world.run(200);
    expect(earned(10_000)).toBe(10);

    // One shot, then ten seconds at the double rate and back to the single.
    fire = true;
    world.run(100);
    fire = false;
    world.run(100);
    const afterShot = earned(9000);
    expect(afterShot).toBeGreaterThanOrEqual(17);
    expect(afterShot).toBeLessThanOrEqual(19);
    world.run(2000);
    expect(earned(10_000)).toBe(10);
  });

  it('a hit pays 500 and a kill over the belt 660 on top', () => {
    {
      const world = new TestWorld(4, SIM.asteroidCount, false);
      const victim = world.addClient({ link: profileLink('100ms', 1) });
      const shooter = world.addClient({ controls: hunter(), link: profileLink('100ms', 3) });
      world.run(600);
      // High over the belt, so no rock gets in the way.
      world.place(shooter.core.playerId, { ...STILL, x: 0, y: 300, z: 4000 });
      world.place(victim.core.playerId, { ...STILL, x: 0, y: 300, z: 4200 });
      const jumps = watchScore(world, shooter.core.playerId);
      world.clock.every(TICK_MS, () => {
        if (world.deaths.length > 0) world.place(shooter.core.playerId, { fireCooldown: 250 });
      });
      world.run(8000);
      expect(world.deaths).toHaveLength(1);
      // Seven hits; the seventh also kills.
      expect(jumps).toEqual([500, 500, 500, 500, 500, 500, 500 + 660]);
      // The death record carries the victim's points as they stood then:
      // the few it had earned from the belt, and none since.
      expect(world.deaths[0]?.score).toBeGreaterThan(0);
      expect(world.deaths[0]?.score).toBeLessThanOrEqual(world.room.scoreOf(victim.core.playerId));
      world.run(1100);
      expect(
        shooter.core.scoreboard.find((e) => e.playerId === shooter.core.playerId),
      ).toMatchObject({ playerId: shooter.core.playerId, kills: 1 });
    }
  });

  it('the hunter orb doubles kill points for 30 s', () => {
    const world = new TestWorld(31, SPARSE);
    const victim = world.addClient({});
    const shooter = world.addClient({ controls: hunter() });
    world.run(1500);
    world.place(victim.core.playerId, OUTSIDE_THE_BELT);
    world.clock.every(TICK_MS, () => {
      if (world.deaths.length > 0) world.place(shooter.core.playerId, { fireCooldown: 250 });
    });
    // The shooter picks up a hunter orb, then meets the victim over the belt.
    flyAt(world, shooter.core.playerId, 'hunter');
    world.place(shooter.core.playerId, { fireCooldown: 200 });
    world.run(1500);
    expect(shooter.core.killMultTicks).toBeGreaterThan(SCORE.multiplierTicks - 200);
    const jumps = watchScore(world, shooter.core.playerId);
    world.place(shooter.core.playerId, { ...STILL, x: 0, y: 300, z: 4000, fireCooldown: 0 });
    world.place(victim.core.playerId, { ...STILL, x: 0, y: 300, z: 4200 });
    world.run(8000);
    expect(world.deaths).toHaveLength(1);
    expect(jumps[jumps.length - 1]).toBe(500 + 1320);
  });

  it('points outlive the ship, and the scoreboard reaches everyone', () => {
    const { world, pilot } = solo();
    const other = world.addClient({});
    const id = pilot.core.playerId;
    world.room.addScore(id, 777);
    world.place(id, { x: 0, y: 0, z: 0 }); // into the planet
    world.run(5000);
    expect(world.deaths).toHaveLength(1);
    expect(world.room.shipOf(id)?.alive).toBe(true);
    expect(world.room.scoreOf(id)).toBeGreaterThanOrEqual(777);
    world.run(1200);
    for (const client of [pilot, other]) {
      const board = client.core.scoreboard;
      expect(board).toHaveLength(2);
      // The board is up to a second old, and the belt pays a point a second.
      const shown = board.find((e) => e.playerId === id)?.score ?? 0;
      expect(world.room.scoreOf(id) - shown).toBeGreaterThanOrEqual(0);
      expect(world.room.scoreOf(id) - shown).toBeLessThanOrEqual(2);
    }
  });
});

describe('the store (v1 main.js:8011-8032, 8250-8255)', () => {
  /** A pilot who has just flown through a Zaphire orb, with `points` to spend. */
  function atTheStore(points: number, ship: Partial<ShipState> = {}) {
    const world = new TestWorld(31, SPARSE);
    const pilot = world.addClient({ link: profileLink('100ms', 3) });
    world.run(1500);
    const id = pilot.core.playerId;
    flyAt(world, id, 'zaphire');
    world.run(1500);
    world.place(id, { ...OUTSIDE_THE_BELT, ...ship });
    world.room.addScore(id, points - world.room.scoreOf(id));
    world.run(400);
    return { world, pilot, id };
  }

  it('a Zaphire orb opens it for 20 s; without one it is shut and sells nothing', () => {
    const { world, pilot, id } = atTheStore(5000, { hp: 40 });
    expect(pilot.core.storeTicks).toBeGreaterThan(0);
    expect(pilot.core.storeTicks).toBeLessThanOrEqual(SCORE.storeTicks);
    world.run(21_000);
    expect(pilot.core.storeTicks).toBe(0);
    pilot.core.buy('hp');
    world.run(1500);
    expect(world.room.scoreOf(id)).toBe(5000);
    expect(world.room.shipOf(id)?.hp).toBe(40);
  });

  it('hull repair: 1,500 points, the hull whole half a second later, on a tick the client knew', () => {
    const { world, pilot, id } = atTheStore(1600, { hp: 40 });
    const correctionsBefore = pilot.corrections.length;
    pilot.core.buy('hp');
    world.run(1500);
    expect(world.room.scoreOf(id)).toBe(100);
    expect(world.room.shipOf(id)?.hp).toBe(100);
    const grant = pilot.events.find((e) => e.kind === 'grant');
    if (grant?.kind !== 'grant') throw new Error('no grant');
    expect(grant.item).toBe('hp');
    const truth = world.truth.get(id);
    expect(truth?.get(grant.applyTick - 1)?.hp).toBe(40);
    expect(truth?.get(grant.applyTick)?.hp).toBe(100);
    expect(pilot.core.predictedAt(grant.applyTick - 1)?.hp).toBe(40);
    expect(pilot.core.predictedAt(grant.applyTick)?.hp).toBe(100);
    expect(pilot.corrections.length - correctionsBefore).toBe(0);
    // One purchase shuts the store.
    expect(pilot.core.storeTicks).toBe(0);
    pilot.core.buy('shield');
    world.run(1500);
    expect(world.room.scoreOf(id)).toBe(100);
    expect(world.room.shipOf(id)?.shield).toBe(0);
  });

  it('shield for 1,000 and Fenix for 2,000', () => {
    const shield = atTheStore(1000);
    shield.pilot.core.buy('shield');
    shield.world.run(1500);
    expect(shield.world.room.shipOf(shield.id)?.shield).toBe(100);
    expect(shield.world.room.scoreOf(shield.id)).toBe(0);

    const fenix = atTheStore(2500, { hp: 30 });
    fenix.pilot.core.buy('fenix');
    fenix.world.run(1500);
    expect(fenix.world.room.shipOf(fenix.id)).toMatchObject({ fenix: true, hp: 100 });
    expect(fenix.world.room.scoreOf(fenix.id)).toBe(500);
    expect(fenix.pilot.core.state?.fenix).toBe(true);
  });

  it('refuses a player who cannot pay, and does not charge for what would change nothing', () => {
    const poor = atTheStore(STORE_PRICES.hp - 1, { hp: 40 });
    poor.pilot.core.buy('hp');
    poor.world.run(1500);
    expect(poor.world.room.shipOf(poor.id)?.hp).toBe(40);
    expect(poor.world.room.scoreOf(poor.id)).toBe(STORE_PRICES.hp - 1);
    // The store is still open: nothing was sold.
    expect(poor.pilot.core.storeTicks).toBeGreaterThan(0);

    // v1 took 2,000 points from a Fenix for a second Fenix, and 1,500 for a full hull.
    const whole = atTheStore(9000, { fenix: true });
    whole.pilot.core.buy('fenix');
    whole.pilot.core.buy('hp');
    whole.world.run(1500);
    expect(whole.world.room.scoreOf(whole.id)).toBe(9000);
  });
});
