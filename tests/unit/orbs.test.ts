import { describe, expect, it } from 'vitest';
import { SIM, TICK_DT } from '../../src/shared/constants.ts';
import { CAUSE_EDGE, NO_PLAYER } from '../../src/shared/protocol.ts';
import type { BulletEvent, OrbEvent } from '../../src/shared/protocol.ts';
import { Rng } from '../../src/shared/rng.ts';
import { asteroidPosition } from '../../src/shared/sim/belt.ts';
import { bulletFrom, bulletHit, bulletRadius } from '../../src/shared/sim/bullets.ts';
import type { Bullet } from '../../src/shared/sim/bullets.ts';
import {
  ORB_COUNT,
  ORB_KINDS,
  bulletOrbHit,
  createOrbs,
  orbTouching,
  wormholeExit,
} from '../../src/shared/sim/orbs.ts';
import type { OrbKind, OrbsGoneView } from '../../src/shared/sim/orbs.ts';
import type { Controls, ShipState } from '../../src/shared/sim/ship.ts';
import { boostTicksFrom, crashDamage } from '../../src/shared/sim/world.ts';
import { TestWorld, profileLink } from '../support/harness.ts';
import type { TestClient } from '../support/harness.ts';

const NOTHING_GONE: OrbsGoneView = { orbGone: () => false };

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

const orbEvents = (client: TestClient): OrbEvent[] =>
  client.events.filter((e): e is OrbEvent => e.kind === 'orb');

describe('the orb field', () => {
  const field = createOrbs(77, true);

  it("has v1's caps of each kind, all on the ring within 20 units of its plane", () => {
    expect(field.orbs).toHaveLength(1360);
    expect(ORB_COUNT).toBe(1360);
    const count = (kind: OrbKind): number => field.orbs.filter((o) => o.kind === kind).length;
    expect(ORB_KINDS.map(count)).toEqual([160, 120, 120, 120, 120, 120, 300, 300]);
    for (const orb of field.orbs) {
      const radial = Math.hypot(orb.x, orb.z);
      expect(radial).toBeGreaterThanOrEqual(SIM.beltInner - 1e-6);
      expect(radial).toBeLessThan(SIM.beltOuter);
      expect(Math.abs(orb.y)).toBeLessThanOrEqual(20);
    }
  });

  it('is the same for the same seed, different for another, and empty when asked', () => {
    expect(createOrbs(77, true).orbs).toEqual(field.orbs);
    expect(createOrbs(78, true).orbs[0]).not.toEqual(field.orbs[0]);
    expect(createOrbs(77, false).orbs).toHaveLength(0);
  });

  it('finding the orb a ship touches agrees with checking every orb, and never finds a Fenix orb', () => {
    const rng = new Rng(8);
    let touching = 0;
    for (let i = 0; i < 6000; i++) {
      const orb = field.orbs[Math.floor(rng.next() * field.orbs.length)];
      if (!orb) continue;
      const x = orb.x + (rng.next() - 0.5) * 20;
      const y = orb.y + (rng.next() - 0.5) * 8;
      const z = orb.z + (rng.next() - 0.5) * 20;
      const expected = field.orbs.findIndex(
        (o) =>
          o.kind !== 'fenix' && Math.hypot(o.x - x, o.y - y, o.z - z) < o.radius + SIM.pickupRadius,
      );
      expect(orbTouching(field, NOTHING_GONE, 0, x, y, z, SIM.pickupRadius)).toBe(expected);
      if (expected >= 0) touching++;
    }
    expect(touching).toBeGreaterThan(1000);
  });

  it('finding the orb a bullet or a beam meets agrees with checking every orb', () => {
    const rng = new Rng(9);
    const bruteForce = (bullet: Bullet, tick: number): { id: number; at: number } | null => {
      let best: { id: number; at: number } | null = null;
      for (const [id, orb] of field.orbs.entries()) {
        const at = bulletHit(bullet, tick, orb.x, orb.y, orb.z, orb.radius + bulletRadius(bullet));
        if (at >= 0 && (!best || at < best.at)) best = { id, at };
      }
      return best;
    };
    let hits = 0;
    for (let i = 0; i < 6000; i++) {
      const orb = field.orbs[Math.floor(rng.next() * field.orbs.length)];
      if (!orb) continue;
      const age = Math.floor(rng.next() * 5);
      const bullet = bulletFrom(
        0,
        1000 - age,
        orb.x + (rng.next() - 0.5) * 40,
        orb.y + (rng.next() - 0.5) * 6,
        orb.z + (rng.next() - 0.5) * 40,
        (rng.next() - 0.5) * 6,
        (rng.next() - 0.5) * 0.3,
        i % 2 === 0,
      );
      const expected = bruteForce(bullet, 1000);
      expect(bulletOrbHit(field, NOTHING_GONE, bullet, 1000)).toEqual(expected);
      if (expected) hits++;
    }
    expect(hits).toBeGreaterThan(150);
  });

  it('every wormhole has exits, each at least 5,000 units away (decision D9)', () => {
    for (const [id, orb] of field.orbs.entries()) {
      if (orb.kind !== 'wormhole') {
        expect(field.exits[id]).toEqual([]);
        continue;
      }
      expect(field.exits[id]?.length).toBeGreaterThan(10);
      for (let tick = 0; tick < 40; tick++) {
        const out = wormholeExit(field, 77, id, tick);
        if (!out) throw new Error('no exit');
        // 150 to 400 from an exit that is itself 5,000 away.
        expect(Math.hypot(out.x - orb.x, out.z - orb.z)).toBeGreaterThan(5000 - 400 - 40);
        const nearest = Math.min(
          ...field.orbs
            .filter((o) => o.kind === 'wormhole')
            .map((o) => Math.hypot(o.x - out.x, o.z - out.z)),
        );
        expect(nearest).toBeLessThanOrEqual(400);
      }
    }
  });
});

/** A thin belt, so that one orb decides each result, with every orb in place. */
const SPARSE = 150;

/** An orb of a kind with no other orb within 100 units and no rock within 300 just now. */
function loneOrb(world: TestWorld, kind: OrbKind, skip = 0): number {
  const orbs = world.room.world.orbs.orbs;
  const rocks = world.room.world.belt.asteroids;
  let skipped = 0;
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
    if (crowded) continue;
    if (skipped++ < skip) continue;
    return id;
  }
  throw new Error(`no lone ${kind} orb`);
}

/** Puts a ship 20 units short of an orb, flying at it at 20 u/s: one second away. */
function flyAt(world: TestWorld, playerId: number, orbId: number, change: Partial<ShipState> = {}) {
  const orb = world.room.world.orbs.orbs[orbId];
  if (!orb) throw new Error('no orb');
  world.place(playerId, { ...STILL, x: orb.x, y: orb.y, z: orb.z - 20, ...change });
  return orb;
}

/** Two players in a thin belt: a pilot, and one far away who must still be told. */
function pilotAndFar(profile: 'clean' | '100ms' | '200ms-lossy') {
  const world = new TestWorld(31, SPARSE);
  const pilot = world.addClient({ link: profileLink(profile, 3) });
  const far = world.addClient({ link: profileLink(profile, 5) });
  world.run(1500);
  world.place(far.core.playerId, { ...STILL, x: -7000, y: 300, z: 0, speed: 5, targetSpeed: 5 });
  return { world, pilot, far };
}

describe('flying through an orb', () => {
  it.each(['clean', '100ms'] as const)(
    'shield orb on the %s profile: +25 shield, the orb goes for everyone, and the pilot predicted it',
    (profile) => {
      const { world, pilot, far } = pilotAndFar(profile);
      const orbId = loneOrb(world, 'shield');
      flyAt(world, pilot.core.playerId, orbId);
      world.run(300);
      const correctionsBefore = pilot.corrections.length;
      world.run(1500);

      expect(world.room.stats.orbsTaken).toBe(1);
      expect(world.room.shipOf(pilot.core.playerId)?.shield).toBe(25);
      expect(world.room.ledger.orbGone(orbId, world.room.tick)).toBe(true);
      const told = orbEvents(far);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ orbId, playerId: pilot.core.playerId, byBullet: false });
      expect(far.core.orbGone(orbId, far.core.tick)).toBe(true);

      // The pilot's client took it on the same tick, with no correction.
      const tick = told[0]?.tick ?? 0;
      expect(pilot.core.predictedAt(tick)?.shield).toBe(25);
      expect(pilot.core.predictedAt(tick - 1)?.shield).toBe(0);
      expect(pilot.corrections.length - correctionsBefore).toBe(0);
    },
  );

  it('a shield never goes past 100', () => {
    const { world, pilot } = pilotAndFar('clean');
    flyAt(world, pilot.core.playerId, loneOrb(world, 'shield'), { shield: 90 });
    world.run(1500);
    expect(world.room.shipOf(pilot.core.playerId)?.shield).toBe(100);
  });

  it.each(['clean', '100ms'] as const)(
    'boost orb on the %s profile: 3 to 6 s at 3.08 times the speed, predicted with no correction',
    (profile) => {
      const { world, pilot } = pilotAndFar(profile);
      const orbId = loneOrb(world, 'boost');
      flyAt(world, pilot.core.playerId, orbId, { speed: 60, targetSpeed: 60, z: 0 });
      // Start 40 units short: the boost orb is a big target.
      const orb = world.room.world.orbs.orbs[orbId];
      if (!orb) throw new Error('no orb');
      world.place(pilot.core.playerId, { z: orb.z - 40 });
      world.run(300);
      const correctionsBefore = pilot.corrections.length;
      world.run(1200);

      const event = orbEvents(pilot).find((e) => e.orbId === orbId);
      if (!event) throw new Error('boost orb not taken');
      const ticks = boostTicksFrom(world.room.world.seed, orbId, event.tick);
      expect(ticks).toBeGreaterThanOrEqual(180);
      expect(ticks).toBeLessThanOrEqual(360);
      expect(world.truth.get(pilot.core.playerId)?.get(event.tick)?.boostTicks).toBe(ticks);
      const fastest = Math.max(
        ...[...(world.truth.get(pilot.core.playerId)?.values() ?? [])].map((s) => s.speed),
      );
      expect(fastest).toBeGreaterThan(170);
      expect(fastest).toBeLessThanOrEqual(60 * 3.08 + 1e-9);
      expect(pilot.core.predictedAt(event.tick)?.boostTicks).toBe(ticks);
      expect(pilot.corrections.length - correctionsBefore).toBe(0);
    },
  );

  it.each(['clean', '100ms'] as const)(
    'wormhole on the %s profile: the ship comes out near another one 5,000 units away, and nobody sees it slide there',
    (profile) => {
      const world = new TestWorld(31, SPARSE);
      const pilot = world.addClient({ link: profileLink(profile, 3) });
      // The watcher flies alongside and records where it draws the pilot.
      const drawn: { x: number; z: number; spawnSeq: number }[] = [];
      const watcher = world.addClient({
        link: profileLink(profile, 5),
        onFrame: (core) => {
          const view = core.remoteViews().find((r) => r.id === pilot.core.playerId);
          if (view?.alive) drawn.push({ x: view.x, z: view.z, spawnSeq: view.spawnSeq });
        },
      });
      world.run(1500);
      const orbId = loneOrb(world, 'wormhole');
      const orb = flyAt(world, pilot.core.playerId, orbId);
      world.place(watcher.core.playerId, {
        ...STILL,
        x: orb.x + 60,
        y: orb.y + 30,
        z: orb.z - 20,
      });
      world.run(300);
      const seqBefore = world.room.shipOf(pilot.core.playerId)?.spawnSeq ?? -1;
      const correctionsBefore = pilot.corrections.length;
      drawn.length = 0;
      world.run(1500);

      const ship = world.room.shipOf(pilot.core.playerId);
      if (!ship) throw new Error('no ship');
      expect(ship.alive).toBe(true);
      expect(ship.spawnSeq).toBe(seqBefore + 1);
      expect(Math.hypot(ship.x - orb.x, ship.z - orb.z)).toBeGreaterThan(4500);
      expect(world.deaths).toHaveLength(0);
      // The pilot predicted the jump to the bit: no correction, not even a "teleport".
      expect(pilot.corrections.length - correctionsBefore).toBe(0);
      expect(pilot.core.state).toMatchObject({ spawnSeq: seqBefore + 1 });

      // The watcher drew the pilot near the wormhole, then far away, and
      // never anywhere in between.
      const before = drawn.filter((d) => d.spawnSeq === seqBefore);
      const after = drawn.filter((d) => d.spawnSeq === seqBefore + 1);
      expect(before.length).toBeGreaterThan(10);
      expect(after.length).toBeGreaterThan(10);
      // (Being put in place by the test is itself smoothed for a moment.)
      for (const d of before) expect(Math.hypot(d.x - orb.x, d.z - orb.z)).toBeLessThan(150);
      for (const d of after) expect(Math.hypot(d.x - orb.x, d.z - orb.z)).toBeGreaterThan(4500);
    },
  );

  it.each(['pink', 'zaphire', 'miner', 'hunter'] as const)(
    '%s orb: taken, and the ship itself is unchanged',
    (kind) => {
      const { world, pilot } = pilotAndFar('clean');
      const orbId = loneOrb(world, kind);
      flyAt(world, pilot.core.playerId, orbId);
      world.run(1500);
      expect(world.room.ledger.orbGone(orbId, world.room.tick)).toBe(true);
      expect(world.room.shipOf(pilot.core.playerId)).toMatchObject({
        hp: 100,
        shield: 0,
        boostTicks: 0,
        fenix: false,
      });
    },
  );

  it('Fenix orb: flying through it does nothing; it has to be shot', () => {
    const { world, pilot } = pilotAndFar('clean');
    const orbId = loneOrb(world, 'fenix');
    flyAt(world, pilot.core.playerId, orbId);
    world.run(1500);
    expect(world.room.stats.orbsTaken).toBe(0);
    expect(world.room.ledger.orbGone(orbId, world.room.tick)).toBe(false);
    expect(world.room.shipOf(pilot.core.playerId)?.fenix).toBe(false);
  });

  it('a late joiner is told which orbs are taken, and an orb comes back after 30 s', () => {
    const { world, pilot } = pilotAndFar('clean');
    const orbId = loneOrb(world, 'pink');
    flyAt(world, pilot.core.playerId, orbId);
    world.run(1500);
    world.place(pilot.core.playerId, { ...STILL, x: 0, y: 400, z: 7000, speed: 5, targetSpeed: 5 });
    const late = world.addClient({});
    world.run(500);
    expect(late.core.world?.orbs.orbs).toEqual(world.room.world.orbs.orbs);
    expect(late.core.orbGone(orbId, late.core.tick)).toBe(true);
    expect(orbEvents(late).find((e) => e.orbId === orbId)).toMatchObject({
      playerId: NO_PLAYER,
      byBullet: false,
    });
    world.run(SIM.orbRespawnTicks * (1000 / 60));
    expect(world.room.ledger.orbGone(orbId, world.room.tick)).toBe(false);
    expect(late.core.orbGone(orbId, late.core.tick)).toBe(false);
  });
});

describe('shooting an orb', () => {
  /** A shooter parked 60 units short of an orb, facing it, who fires once. */
  function shootAt(kind: OrbKind, profile: 'clean' | '100ms', change: Partial<ShipState> = {}) {
    const world = new TestWorld(31, SPARSE);
    let fire = false;
    const shooter = world.addClient({
      controls: (): Controls => ({ yaw: 0, pitch: 0, throttle: 0, fire }),
      link: profileLink(profile, 3),
    });
    const other = world.addClient({ link: profileLink(profile, 5) });
    world.run(1500);
    world.place(other.core.playerId, { ...STILL, x: -7000, y: 300, z: 0, speed: 5 });
    const orbId = loneOrb(world, kind);
    const orb = world.room.world.orbs.orbs[orbId];
    if (!orb) throw new Error('no orb');
    const parked = { ...STILL, speed: 0, targetSpeed: 0, x: orb.x, y: orb.y, z: orb.z - 60 };
    world.place(shooter.core.playerId, { ...parked, ...change });
    const fireTick = world.room.tick + 60;
    world.clock.every(1, () => {
      fire = shooter.core.tick >= fireTick && shooter.core.counters.shotsFired === 0;
      // Hold the ship still until the orb has done its work.
      if (world.room.stats.orbsShot === 0) {
        world.place(shooter.core.playerId, { speed: 0, targetSpeed: 0 });
      }
    });
    return { world, shooter, other, orbId, orb };
  }

  it.each(['clean', '100ms'] as const)(
    'shield orb on the %s profile: gone at once, the shield arrives half a second later on a tick both sides know',
    (profile) => {
      const { world, shooter, other, orbId } = shootAt('shield', profile);
      world.run(1200);
      const correctionsBefore = shooter.corrections.length;
      world.run(2500);

      expect(world.room.stats.bulletsFired).toBe(1);
      expect(world.room.stats.orbsShot).toBe(1);
      expect(world.room.bulletCount).toBe(0);
      const told = orbEvents(other);
      expect(told).toHaveLength(1);
      const event = told[0];
      if (!event) throw new Error('no event');
      expect(event).toMatchObject({ orbId, playerId: shooter.core.playerId, byBullet: true });

      // On the server the shield arrives exactly 30 ticks after the hit.
      const truth = world.truth.get(shooter.core.playerId);
      const applied = event.tick + SIM.shotEffectDelayTicks;
      expect(truth?.get(applied - 1)?.shield).toBe(0);
      expect(truth?.get(applied)?.shield).toBe(25);
      // And on the shooter's own client on the very same tick, uncorrected.
      expect(shooter.core.predictedAt(applied - 1)?.shield).toBe(0);
      expect(shooter.core.predictedAt(applied)?.shield).toBe(25);
      expect(shooter.corrections.length - correctionsBefore).toBe(0);
      expect(shooter.core.orbGone(orbId, shooter.core.tick)).toBe(true);
      expect(shooter.core.bulletViews()).toHaveLength(0);
    },
  );

  it.each(['clean', '100ms'] as const)(
    'Fenix orb on the %s profile: the ship becomes a Fenix, is made whole, flies at 80 and fires beams',
    (profile) => {
      const { world, shooter } = shootAt('fenix', profile, { hp: 40 });
      world.run(3000);
      const ship = world.room.shipOf(shooter.core.playerId);
      expect(ship).toMatchObject({ fenix: true, hp: 100, alive: true });
      expect(shooter.core.state).toMatchObject({ fenix: true, hp: 100 });
      expect(shooter.core.view()?.fenix).toBe(true);

      // Full throttle: a Fenix tops out at 80, not 60.
      world.clock.every(1, () => {
        world.place(shooter.core.playerId, { targetSpeed: 500, fireCooldown: 0 });
      });
      world.run(3000);
      const speed = world.room.shipOf(shooter.core.playerId)?.speed ?? 0;
      expect(speed).toBeGreaterThan(79);
      expect(speed).toBeLessThanOrEqual(80);
    },
  );

  it('a Fenix fires beams, and the other players are told so', () => {
    const world = new TestWorld(31, SPARSE, false);
    const shooter = world.addClient({
      controls: (): Controls => ({ yaw: 0, pitch: 0, throttle: 0, fire: true }),
    });
    const other = world.addClient({});
    world.run(600);
    world.place(shooter.core.playerId, { ...STILL, x: 0, y: 300, z: 6000, fenix: true });
    world.place(other.core.playerId, { ...STILL, x: 50, y: 300, z: 6000 });
    world.run(1000);
    const bullets = other.events.filter((e): e is BulletEvent => e.kind === 'bullet');
    expect(bullets.length).toBeGreaterThan(5);
    expect(bullets.every((b) => b.beam)).toBe(true);
    expect(other.core.bulletViews().every((b) => b.beam)).toBe(true);
  });

  it('an orb in the way takes the bullet: the ship behind it is not hit', () => {
    const { world, shooter, other, orb } = shootAt('pink', '100ms');
    world.place(other.core.playerId, {
      ...STILL,
      speed: 0,
      targetSpeed: 0,
      x: orb.x,
      y: orb.y,
      z: orb.z + 10,
    });
    world.clock.every(1, () => {
      world.place(other.core.playerId, { speed: 0, targetSpeed: 0 });
    });
    world.run(3000);
    expect(world.room.stats.bulletsFired).toBe(1);
    expect(world.room.stats.orbsShot).toBe(1);
    expect(world.hits).toHaveLength(0);
    expect(shooter.viewHits).toHaveLength(0);
  });
});

describe('a Fenix', () => {
  it('takes half from a crash, and is an ordinary ship again after it is destroyed', () => {
    const world = new TestWorld(31, SPARSE, false);
    const pilot = world.addClient({});
    world.run(600);
    const belt = world.room.world.belt;
    const rockId = belt.asteroids.findIndex((rock, id) => {
      if (rock.radius < 6) return false;
      const p = asteroidPosition(rock, world.room.tick);
      return !belt.asteroids.some((other, otherId) => {
        if (otherId === id) return false;
        const q = asteroidPosition(other, world.room.tick);
        return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < 400;
      });
    });
    const rock = belt.asteroids[rockId];
    if (!rock) throw new Error('no lone rock');
    const ahead = asteroidPosition(rock, world.room.tick + 30);
    world.place(pilot.core.playerId, {
      ...STILL,
      speed: 5,
      targetSpeed: 5,
      x: ahead.x,
      y: ahead.y,
      z: ahead.z,
      fenix: true,
    });
    world.run(1500);
    const event = pilot.events.find((e) => e.kind === 'asteroid');
    if (event?.kind !== 'asteroid') throw new Error('no crash');
    const full = crashDamage(world.room.world.seed, rockId, event.tick);
    expect(world.room.shipOf(pilot.core.playerId)?.hp).toBe(100 - Math.ceil(full / 2));
    expect(pilot.core.state?.hp).toBe(100 - Math.ceil(full / 2));

    world.place(pilot.core.playerId, { hp: 1, crashTicks: 0 });
    world.clock.every(1, () => {
      const ship = world.room.shipOf(pilot.core.playerId);
      if (ship?.alive && ship.fenix && ship.invulnTicks === 0) {
        world.place(pilot.core.playerId, { x: 0, y: 0, z: 0 }); // into the planet
      }
    });
    world.run(5000);
    expect(world.deaths.length).toBeGreaterThanOrEqual(1);
    expect(world.room.shipOf(pilot.core.playerId)).toMatchObject({ alive: true, fenix: false });
  });
});

describe('the edge of the combat zone (decision D11)', () => {
  it.each(['clean', '100ms'] as const)(
    'on the %s profile: outside 9,000 units the ship loses 10 points a second and dies of it, predicted',
    (profile) => {
      const world = new TestWorld(31, SPARSE, false);
      const pilot = world.addClient({ link: profileLink(profile, 3) });
      world.run(1500);
      // Just inside, flying out along +X at 60 u/s.
      world.place(pilot.core.playerId, {
        ...STILL,
        x: 8940,
        y: 0,
        z: 0,
        yaw: Math.PI / 2,
        speed: 60,
        targetSpeed: 60,
      });
      world.run(900);
      expect(world.room.shipOf(pilot.core.playerId)?.hp).toBe(100);
      const correctionsBefore = pilot.corrections.length;
      world.run(4000);
      // About 4 s outside by now: 8 lots of 5.
      const hp = world.room.shipOf(pilot.core.playerId)?.hp ?? 0;
      expect(hp).toBeGreaterThanOrEqual(55);
      expect(hp).toBeLessThanOrEqual(65);
      expect(pilot.core.ackState?.hp).toBeLessThan(100);
      expect(pilot.corrections.length - correctionsBefore).toBe(0);

      world.run(8000);
      expect(world.deaths).toHaveLength(1);
      expect(world.deaths[0]).toMatchObject({ cause: CAUSE_EDGE, killerId: null });
    },
  );

  it('the planet and the belt are well inside it', () => {
    expect(SIM.combatZoneRadius).toBeGreaterThan(SIM.beltOuter + 3000);
    expect(SIM.bulletSpeed * SIM.bulletLifeTicks * TICK_DT).toBeLessThan(SIM.combatZoneRadius);
  });
});
