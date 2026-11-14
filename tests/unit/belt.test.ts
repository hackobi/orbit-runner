import { describe, expect, it } from 'vitest';
import { SIM, TICK_DT } from '../../src/shared/constants.ts';
import { CAUSE_ASTEROID, NO_PLAYER } from '../../src/shared/protocol.ts';
import type { AsteroidEvent } from '../../src/shared/protocol.ts';
import { Rng } from '../../src/shared/rng.ts';
import {
  Depleted,
  asteroidPosition,
  asteroidTouching,
  bulletAsteroidHit,
  createBelt,
} from '../../src/shared/sim/belt.ts';
import type { Belt, GoneView } from '../../src/shared/sim/belt.ts';
import { bulletFrom, bulletHit, bulletRadius } from '../../src/shared/sim/bullets.ts';
import type { Bullet } from '../../src/shared/sim/bullets.ts';
import type { Controls, ShipState } from '../../src/shared/sim/ship.ts';
import { crashDamage } from '../../src/shared/sim/world.ts';
import { TestWorld, profileLink } from '../support/harness.ts';
import type { TestClient } from '../support/harness.ts';

const NOTHING_GONE: GoneView = { asteroidGone: () => false };

const STILL: Partial<ShipState> = {
  pitch: 0,
  roll: 0,
  speed: SIM.minSpeed,
  targetSpeed: SIM.minSpeed,
  invulnTicks: 0,
  crashTicks: 0,
  hp: SIM.maxHp,
  shield: 0,
};

const asteroidEvents = (client: TestClient): AsteroidEvent[] =>
  client.events.filter((e): e is AsteroidEvent => e.kind === 'asteroid');

describe('the belt', () => {
  const belt = createBelt(1234, SIM.asteroidCount);

  it('is v1 belt: 2,000 rocks between 3,600 and 5,200 units, sized 2 to 9, within 60 units of the plane', () => {
    expect(belt.asteroids).toHaveLength(2000);
    for (const rock of belt.asteroids) {
      expect(rock.orbitRadius).toBeGreaterThanOrEqual(SIM.beltInner);
      expect(rock.orbitRadius).toBeLessThan(SIM.beltOuter);
      expect(Math.abs(rock.y)).toBeLessThanOrEqual(60);
      expect(rock.scale).toBeGreaterThanOrEqual(2);
      expect(rock.scale).toBeLessThan(9);
      expect(rock.radius).toBeCloseTo(rock.scale * 0.95, 12);
      const perSecond = rock.anglePerTick / TICK_DT;
      expect(perSecond).toBeGreaterThanOrEqual(0.012 - 1e-12);
      expect(perSecond).toBeLessThan(0.042);
    }
    expect(belt.maxRadius).toBeLessThan(8.55);
  });

  it('is the same for the same seed and different for another', () => {
    expect(createBelt(1234, 2000).asteroids).toEqual(belt.asteroids);
    expect(createBelt(1235, 2000).asteroids[0]).not.toEqual(belt.asteroids[0]);
  });

  it('a rock stays on its circle and moves at its own rate, also a month into a room', () => {
    const rock = belt.asteroids[17];
    if (!rock) throw new Error('no rock');
    const month = 30 * 24 * 3600 * 60;
    for (const tick of [0, 1, 600, month, month + 1]) {
      const p = asteroidPosition(rock, tick);
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(rock.orbitRadius, 6);
      expect(p.y).toBe(rock.y);
    }
    const a = asteroidPosition(rock, month);
    const b = asteroidPosition(rock, month + 1);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(rock.anglePerTick * rock.orbitRadius, 5);
  });

  it('finding the rock a point touches agrees with checking every rock', () => {
    const rng = new Rng(5);
    const bruteForce = (tick: number, x: number, y: number, z: number, extra: number): number => {
      for (const [id, rock] of belt.asteroids.entries()) {
        const p = asteroidPosition(rock, tick);
        if (Math.hypot(p.x - x, p.y - y, p.z - z) <= rock.radius + extra) return id;
      }
      return -1;
    };
    let touching = 0;
    for (let i = 0; i < 4000; i++) {
      const tick = Math.floor(rng.next() * 1e6);
      // Half the points are near a rock; half are anywhere in or around the belt.
      const rock = belt.asteroids[Math.floor(rng.next() * belt.asteroids.length)];
      if (!rock) continue;
      const near = asteroidPosition(rock, tick);
      const spread = i % 2 === 0 ? 14 : 4000;
      const x = near.x + (rng.next() - 0.5) * spread;
      const y = near.y + (rng.next() - 0.5) * Math.min(spread, 200);
      const z = near.z + (rng.next() - 0.5) * spread;
      const expected = bruteForce(tick, x, y, z, SIM.shipCrashRadius);
      expect(asteroidTouching(belt, NOTHING_GONE, tick, x, y, z, SIM.shipCrashRadius)).toBe(
        expected,
      );
      if (expected >= 0) touching++;
    }
    expect(touching).toBeGreaterThan(500);
  });

  it('finding the rock a bullet meets agrees with checking every rock', () => {
    const rng = new Rng(6);
    const bruteForce = (bullet: Bullet, tick: number): { id: number; at: number } | null => {
      let best: { id: number; at: number } | null = null;
      for (const [id, rock] of belt.asteroids.entries()) {
        const p = asteroidPosition(rock, tick);
        const at = bulletHit(bullet, tick, p.x, p.y, p.z, rock.radius + bulletRadius(bullet));
        if (at >= 0 && (!best || at < best.at)) best = { id, at };
      }
      return best;
    };
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const tick = 1000 + Math.floor(rng.next() * 1e6);
      const rock = belt.asteroids[Math.floor(rng.next() * belt.asteroids.length)];
      if (!rock) continue;
      const at = asteroidPosition(rock, tick);
      // A bullet fired a few ticks ago from near the rock, in any direction.
      const age = Math.floor(rng.next() * 4);
      const bullet = bulletFrom(
        0,
        tick - age,
        at.x + (rng.next() - 0.5) * 30,
        at.y + (rng.next() - 0.5) * 10,
        at.z + (rng.next() - 0.5) * 30,
        (rng.next() - 0.5) * 6,
        (rng.next() - 0.5) * 0.4,
        i % 3 === 0,
      );
      const expected = bruteForce(bullet, tick);
      expect(bulletAsteroidHit(belt, NOTHING_GONE, bullet, tick)).toEqual(expected);
      if (expected) hits++;
    }
    expect(hits).toBeGreaterThan(300);
  });

  it('a destroyed rock is gone for 30 s and then back', () => {
    const destroyed = new Depleted(10, SIM.asteroidRespawnTicks);
    expect(destroyed.gone(3, 100)).toBe(false);
    destroyed.remove(3, 100);
    expect(destroyed.gone(3, 99)).toBe(false);
    expect(destroyed.gone(3, 100)).toBe(true);
    expect(destroyed.gone(3, 100 + SIM.asteroidRespawnTicks - 1)).toBe(true);
    expect(destroyed.gone(3, 100 + SIM.asteroidRespawnTicks)).toBe(false);
    expect(destroyed.goneAt(150)).toEqual([{ id: 3, tick: 100 }]);
    expect(destroyed.goneAt(100 + SIM.asteroidRespawnTicks)).toEqual([]);
  });
});

/**
 * These tests each need one rock with nothing else nearby, so that only
 * that rock decides the result. A thin belt with no orbs has plenty of those.
 */
const SPARSE = 150;

/** The id of a large rock with clear space around it at the time of the test. */
function loneRock(belt: Belt, tick: number): number {
  for (const [id, rock] of belt.asteroids.entries()) {
    if (rock.radius < 6) continue;
    const p = asteroidPosition(rock, tick);
    const crowded = belt.asteroids.some((other, otherId) => {
      if (otherId === id) return false;
      const q = asteroidPosition(other, tick);
      return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < 400;
    });
    if (!crowded) return id;
  }
  throw new Error('no lone rock in this belt');
}

/** Puts a slow ship where a rock will be in half a second, so the rock runs into it. */
function placeInPathOf(world: TestWorld, playerId: number, rockId: number, change = {}): void {
  const rock = world.room.world.belt.asteroids[rockId];
  if (!rock) throw new Error('no rock');
  const ahead = asteroidPosition(rock, world.room.tick + 30);
  world.place(playerId, { ...STILL, x: ahead.x, y: ahead.y, z: ahead.z, yaw: 0, ...change });
}

describe('crashing into a rock', () => {
  it.each(['clean', '100ms', '200ms-lossy'] as const)(
    'on the %s profile: the server decides it, everyone hears of it, and the pilot predicted it',
    (profile) => {
      const world = new TestWorld(31, SPARSE, false);
      const pilot = world.addClient({ link: profileLink(profile, 3) });
      // A second player on the far side of the planet still has to be told.
      const far = world.addClient({ link: profileLink(profile, 5) });
      world.run(1500);
      world.place(far.core.playerId, { ...STILL, x: -4400, y: 300, z: 0 });
      const rockId = loneRock(world.room.world.belt, world.room.tick);
      placeInPathOf(world, pilot.core.playerId, rockId);
      // Being moved by the test is a correction; count from after it.
      world.run(250);
      const correctionsBefore = pilot.corrections.length;
      const crashedBefore = world.room.stats.asteroidsCrashed;
      world.run(1500);

      expect(world.room.stats.asteroidsCrashed - crashedBefore).toBe(1);
      const told = asteroidEvents(far).filter((e) => e.playerId === pilot.core.playerId);
      expect(told).toHaveLength(1);
      const event = told[0];
      if (!event) throw new Error('no event');
      expect(event).toMatchObject({ asteroidId: rockId, byBullet: false });

      // 45 to 75 off the hull, the amount fixed by the room, the rock and the tick.
      const damage = crashDamage(world.room.world.seed, rockId, event.tick);
      expect(damage).toBeGreaterThanOrEqual(45);
      expect(damage).toBeLessThanOrEqual(75);
      const ship = world.room.shipOf(pilot.core.playerId);
      expect(ship).toMatchObject({ alive: true, hp: SIM.maxHp - damage });
      expect(world.room.ledger.asteroidGone(rockId, world.room.tick)).toBe(true);

      // The pilot's client ran the same step: it lost the same hit points on
      // the same tick, saw the rock go, and was never corrected for it. Only
      // a bad link, where inputs arrive late, costs corrections at all.
      expect(pilot.core.predictedAt(event.tick)).toMatchObject({ hp: SIM.maxHp - damage });
      expect(pilot.core.predictedAt(event.tick - 1)).toMatchObject({ hp: SIM.maxHp });
      expect(pilot.core.state?.hp).toBe(SIM.maxHp - damage);
      expect(pilot.core.asteroidGone(rockId, pilot.core.tick)).toBe(true);
      expect(far.core.asteroidGone(rockId, far.core.tick)).toBe(true);
      if (profile !== '200ms-lossy') {
        expect(pilot.corrections.length - correctionsBefore).toBe(0);
      }
    },
  );

  it('kills a ship that is nearly finished, and the death says why', () => {
    const world = new TestWorld(31, SPARSE, false);
    const pilot = world.addClient({});
    world.run(600);
    const rockId = loneRock(world.room.world.belt, world.room.tick);
    placeInPathOf(world, pilot.core.playerId, rockId, { hp: 40 });
    world.run(1500);
    expect(world.deaths).toHaveLength(1);
    expect(world.deaths[0]).toMatchObject({
      victimId: pilot.core.playerId,
      killerId: null,
      cause: CAUSE_ASTEROID,
    });
  });

  it('the shield takes a crash first and the hull only what is left (decision D8)', () => {
    const world = new TestWorld(31, SPARSE, false);
    const pilot = world.addClient({});
    world.run(600);
    const rockId = loneRock(world.room.world.belt, world.room.tick);
    placeInPathOf(world, pilot.core.playerId, rockId, { shield: 50 });
    world.run(1500);
    const event = asteroidEvents(pilot).find((e) => e.playerId === pilot.core.playerId);
    if (!event) throw new Error('no crash');
    const damage = crashDamage(world.room.world.seed, rockId, event.tick);
    const ship = world.room.shipOf(pilot.core.playerId);
    expect(ship?.shield).toBe(Math.max(0, 50 - damage));
    expect(ship?.hp).toBe(SIM.maxHp - Math.max(0, damage - 50));
  });

  it('does nothing to a ship under spawn protection, and the rock survives', () => {
    const world = new TestWorld(31, SPARSE, false);
    const pilot = world.addClient({});
    world.run(600);
    const rockId = loneRock(world.room.world.belt, world.room.tick);
    placeInPathOf(world, pilot.core.playerId, rockId, { invulnTicks: 70 });
    world.run(1000);
    expect(world.room.stats.asteroidsCrashed).toBe(0);
    expect(world.room.shipOf(pilot.core.playerId)).toMatchObject({ alive: true, hp: SIM.maxHp });
    expect(world.room.ledger.asteroidGone(rockId, world.room.tick)).toBe(false);
  });

  it('cannot be skipped by a client that sends nothing: the server flies the ship into the rock', () => {
    const world = new TestWorld(31, SPARSE, false);
    const pilot = world.addClient({});
    world.run(600);
    const rockId = loneRock(world.room.world.belt, world.room.tick);
    pilot.pause();
    placeInPathOf(world, pilot.core.playerId, rockId);
    world.run(1500);
    expect(world.room.stats.asteroidsCrashed).toBe(1);
    expect(world.room.shipOf(pilot.core.playerId)?.hp).toBeLessThan(SIM.maxHp);
  });
});

describe('shooting a rock', () => {
  /** A shooter 60 units from a lone rock, flying alongside it and firing at it. */
  function shootAt(profile: 'clean' | '100ms', withTarget: boolean) {
    const world = new TestWorld(31, SPARSE, false);
    let fire = false;
    const shooter = world.addClient({
      controls: (): Controls => ({ yaw: 0, pitch: 0, throttle: 0, fire }),
      link: profileLink(profile, 3),
    });
    const target = world.addClient({ link: profileLink(profile, 5) });
    world.run(1500);
    const belt = world.room.world.belt;
    const rockId = loneRock(belt, world.room.tick);
    const rock = belt.asteroids[rockId];
    if (!rock) throw new Error('no rock');
    // Aim from further out along the radius, straight at where the rock will
    // be when the bullet gets there. The rock crosses the line of fire.
    const flightTicks = 60 / (SIM.bulletSpeed * TICK_DT);
    const fireTick = world.room.tick + 60;
    const meet = asteroidPosition(rock, fireTick + flightTicks);
    const outward = { x: meet.x / rock.orbitRadius, z: meet.z / rock.orbitRadius };
    world.place(shooter.core.playerId, {
      ...STILL,
      speed: 0,
      targetSpeed: 0,
      x: meet.x + outward.x * 61.8,
      y: meet.y,
      z: meet.z + outward.z * 61.8,
      yaw: Math.atan2(-outward.x, -outward.z),
    });
    // The other ship sits right behind the rock on the same line, or far away.
    const behind = withTarget ? 12 : 3000;
    world.place(target.core.playerId, {
      ...STILL,
      speed: 0,
      targetSpeed: 0,
      x: meet.x - outward.x * behind,
      y: meet.y + (withTarget ? 0 : 400),
      z: meet.z - outward.z * behind,
    });
    world.clock.every(1, () => {
      // One shot, timed so the bullet and the rock arrive together.
      fire = shooter.core.tick >= fireTick + 1 && shooter.core.counters.shotsFired === 0;
      world.place(shooter.core.playerId, { speed: 0, targetSpeed: 0 });
      world.place(target.core.playerId, { speed: 0, targetSpeed: 0 });
    });
    return { world, shooter, target, rockId };
  }

  it.each(['clean', '100ms'] as const)(
    'on the %s profile: the rock is destroyed, the bullet stops there, and the shooter saw it at once',
    (profile) => {
      const { world, shooter, target, rockId } = shootAt(profile, false);
      // Watch for the moment the shooter's own screen loses the rock.
      let goneOnScreenAtMs = -1;
      world.clock.every(1, () => {
        if (goneOnScreenAtMs < 0 && shooter.core.asteroidGone(rockId, shooter.core.tick)) {
          goneOnScreenAtMs = world.clock.now();
        }
      });
      world.run(3000);

      expect(world.room.stats.bulletsFired).toBe(1);
      expect(world.room.stats.asteroidsShot).toBe(1);
      expect(world.room.bulletCount).toBe(0);
      // 160 for a ring rock, doubled in the belt (main.js:9020, 4626), plus
      // a few points of belt income.
      const score = world.room.scoreOf(shooter.core.playerId);
      expect(score).toBeGreaterThanOrEqual(320);
      expect(score).toBeLessThan(340);
      const told = asteroidEvents(target).filter((e) => e.byBullet);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ asteroidId: rockId, playerId: shooter.core.playerId });
      // The shooter's client predicted the hit, so its rock vanished before
      // the server's word could have arrived, and its bullet is not drawn on.
      expect(goneOnScreenAtMs).toBeGreaterThan(0);
      const heard = shooter.events.find((e) => e.kind === 'asteroid' && e.byBullet);
      expect(heard).toBeDefined();
      expect(shooter.core.bulletViews()).toHaveLength(0);
      expect(shooter.core.counters.ghostBullets).toBe(0);
      expect(shooter.core.asteroidGone(rockId, shooter.core.tick)).toBe(true);
    },
  );

  it("a rock shields the ship behind it: no hit on the server and none on the shooter's screen", () => {
    const { world, shooter, target, rockId } = shootAt('100ms', true);
    world.run(3000);
    expect(world.room.stats.bulletsFired).toBe(1);
    expect(world.room.stats.asteroidsShot).toBe(1);
    expect(world.hits).toHaveLength(0);
    expect(shooter.viewHits).toHaveLength(0);
    expect(world.room.shipOf(target.core.playerId)?.hp).toBe(SIM.maxHp);
    expect(world.room.ledger.asteroidGone(rockId, world.room.tick)).toBe(true);
  });
});

describe('the belt for someone who was not there', () => {
  it('a late joiner is told which rocks are gone, and a rock comes back after 30 s for everyone', () => {
    const world = new TestWorld(31, SPARSE, false);
    const pilot = world.addClient({});
    world.run(600);
    const rockId = loneRock(world.room.world.belt, world.room.tick);
    placeInPathOf(world, pilot.core.playerId, rockId);
    world.run(1500);
    expect(world.room.ledger.asteroidGone(rockId, world.room.tick)).toBe(true);

    const late = world.addClient({});
    world.run(500);
    expect(late.core.world?.belt.asteroids).toEqual(world.room.world.belt.asteroids);
    expect(late.core.asteroidGone(rockId, late.core.tick)).toBe(true);
    const report = asteroidEvents(late).find((e) => e.asteroidId === rockId);
    expect(report).toMatchObject({ playerId: NO_PLAYER, byBullet: false });

    world.run(SIM.asteroidRespawnTicks * (1000 / 60));
    expect(world.room.ledger.asteroidGone(rockId, world.room.tick)).toBe(false);
    expect(late.core.asteroidGone(rockId, late.core.tick)).toBe(false);
    expect(pilot.core.asteroidGone(rockId, pilot.core.tick)).toBe(false);
  });
});
