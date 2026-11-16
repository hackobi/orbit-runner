import { describe, expect, it } from 'vitest';
import { SIM, TICK_MS } from '../../src/shared/constants.ts';
import {
  CAUSE_DISCONNECT,
  CAUSE_PLAYER,
  FAR_ENTRY_BYTES,
  NEAR_ENTRY_BYTES,
  SNAPSHOT_HEADER_BYTES,
  encodeInput,
} from '../../src/shared/protocol.ts';
import { Rng } from '../../src/shared/rng.ts';
import {
  inputFromWire,
  isBoosting,
  maxSpeedOf,
  shipStatesEqual,
} from '../../src/shared/sim/ship.ts';
import type { Controls, ShipState } from '../../src/shared/sim/ship.ts';
import type { ClientCore } from '../../src/net/client.ts';
import { AWAY_GRACE_TICKS, SEAT_TICKS } from '../../src/server/room.ts';
import { THRESHOLDS } from '../thresholds.ts';
import { hunter, wanderer } from '../../src/net/behaviours.ts';
import { PROFILES, TestWorld, profileLink } from '../support/harness.ts';
import type { TestClient } from '../support/harness.ts';
import { distance, hitAgreement, percentile, snapExcess } from '../support/metrics.ts';
import { joined } from '../support/rawClient.ts';

const STILL: Partial<ShipState> = {
  y: 0,
  pitch: 0,
  roll: 0,
  speed: 0,
  targetSpeed: 0,
  invulnTicks: 0,
  hp: SIM.maxHp,
};

// --- Lag compensation, with inputs placed on exact ticks ---------------------

/**
 * A stationary shooter fires one bullet along +Z. A target crosses its line of
 * fire 200 units ahead at 60 u/s. The shot is timed so that the bullet arrives
 * exactly when the target, as it was `aimDelayTicks` ago, is on the line.
 * Returns the hits the server decided.
 */
function crossingShot(aimDelayTicks: number, claimedViewDelay: number): TestWorld['hits'] {
  const world = new TestWorld(3);
  world.run(1000);
  const shooter = joined(world);
  const target = joined(world);
  const startTick = world.room.tick;
  const fireTick = startTick + 90;
  // The bullet leaves z = 4001.8 and first touches a ship centred on
  // z = 4200 during its 52nd tick of flight.
  const arrivalTick = fireTick + 52;

  world.place(shooter.welcome.playerId, { ...STILL, x: 0, z: 4000, yaw: 0 });
  world.place(target.welcome.playerId, {
    ...STILL,
    // One unit per tick along +X from here.
    x: -(arrivalTick - aimDelayTicks - startTick),
    z: 4200,
    yaw: Math.PI / 2,
    speed: 60,
    targetSpeed: 60,
  });

  world.clock.every(TICK_MS, () => {
    const tick = world.room.tick + 3;
    const input = inputFromWire(0, 0, 0, tick === fireTick, false, false, false, 0);
    if (!input) throw new Error('bad input');
    const bytes = Uint8Array.from(encodeInput(tick, [input]));
    // Write the claimed view delay straight into the message, so a claim
    // above the cap really is sent.
    new DataView(bytes.buffer).setUint16(9, claimedViewDelay, true);
    shooter.client.send(bytes);
  });
  world.run(3500);

  expect(world.room.stats.bulletsFired).toBe(1);
  return world.hits;
}

describe('lag compensation', () => {
  it('a shot aimed at where the target was drawn 233 ms ago hits when the server rewinds', () => {
    const hits = crossingShot(14, 14 * 16);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ownerId: 0, targetId: 1 });
  });

  it('the same shot misses without the rewind: the target is 14 units further on', () => {
    expect(crossingShot(14, 0)).toEqual([]);
  });

  it('a shot aimed at the true position misses if the shooter claims a delay it does not have', () => {
    expect(crossingShot(0, 14 * 16)).toEqual([]);
  });

  it('a claimed delay above the cap is clamped to 350 ms', () => {
    // Claiming the largest value the wire can carry buys exactly 21 ticks.
    expect(crossingShot(SIM.maxViewDelayTicks, 0xffff)).toHaveLength(1);
    expect(crossingShot(40, 0xffff)).toEqual([]);
    expect(crossingShot(40, 40 * 16)).toEqual([]);
  });
});

// --- The heavy shot, through the room ------------------------------------------

describe('the heavy shot is fired, predicted and decided like any other (decision D22)', () => {
  it('two shots take 120 off a shielded target, with no correction for the shooter', () => {
    const world = new TestWorld(31, 0, false);
    let armed = false;
    const shooter = world.addClient({
      controls: (): Controls => ({ yaw: 0, pitch: 0, throttle: 0, fire: false, heavy: armed }),
    });
    const target = world.addClient({
      controls: (): Controls => ({ yaw: 0, pitch: 0, throttle: 0, fire: false }),
    });
    world.run(600);
    world.place(shooter.core.playerId, { ...STILL, x: 0, z: 4000, yaw: 0 });
    world.place(target.core.playerId, { ...STILL, x: 0, z: 4150, yaw: 0, shield: 50 });
    world.run(1000);
    const correctionsBefore = shooter.corrections.length;
    const hitsBefore = world.hits.length;

    armed = true;
    let sawHeavy = false;
    for (let i = 0; i < 40; i++) {
      world.run(100);
      sawHeavy ||= target.core.bulletViews().some((b) => b.shot === 'heavy');
    }

    expect(world.hits.length - hitsBefore).toBe(2);
    const struck = world.room.shipOf(target.core.playerId);
    // 60 and 60: the shield's 50 goes first, then 70 of the hull.
    expect(struck).toMatchObject({ alive: true, shield: 0, hp: 30 });
    expect(world.room.shipOf(shooter.core.playerId)?.heavyAmmo).toBe(0);
    expect(shooter.core.state?.heavyAmmo).toBe(0);
    expect(shooter.corrections.length).toBe(correctionsBefore);
    // The target's client was told of the shot and drew it coming.
    expect(sawHeavy).toBe(true);
  });
});

// --- Real clients against each other ------------------------------------------

interface Duel {
  world: TestWorld;
  shooter: TestClient;
  target: TestClient;
}

/**
 * A hunter and a target that flies a slow circle in front of it. The target's
 * hit points are topped up every second so the fight goes on. The belt is
 * there but its orbs are not: a boost or a wormhole would end the duel.
 */
function duel(
  profile: keyof typeof PROFILES,
  seed: number,
  onShooterFrame?: (core: ClientCore) => void,
): Duel {
  const world = new TestWorld(seed, SIM.asteroidCount, false);
  const target = world.addClient({
    controls: (): Controls => ({ yaw: 0.15, pitch: 0, throttle: 0, fire: false }),
    link: profileLink(profile, seed * 10 + 1),
  });
  const shooter = world.addClient({
    controls: hunter(),
    link: profileLink(profile, seed * 10 + 3),
    ...(onShooterFrame ? { onFrame: onShooterFrame } : {}),
  });
  world.run(600);
  world.place(shooter.core.playerId, {
    ...STILL,
    x: 0,
    z: 4000,
    yaw: 0,
    speed: 20,
    targetSpeed: 20,
  });
  world.place(target.core.playerId, {
    ...STILL,
    x: 20,
    z: 4220,
    yaw: 1,
    speed: 20,
    targetSpeed: 20,
  });
  // A bullet lands every 7 ticks at most, so topping up every 6 keeps it alive.
  world.clock.every(100, () => {
    world.place(target.core.playerId, { hp: SIM.maxHp });
  });
  return { world, shooter, target };
}

describe('two players', () => {
  it('see each other, each drawn at a moment in the past', () => {
    const { world, shooter, target } = duel('100ms', 5);
    world.run(5000);
    const seen = shooter.core.remoteViews();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: target.core.playerId, full: true, alive: true });
    expect(target.core.remoteViews()[0]?.id).toBe(shooter.core.playerId);
    // Two snapshot intervals plus the measured jitter, and behind the server.
    expect(shooter.core.remotes.delayTicks).toBeGreaterThanOrEqual(4);
    expect(shooter.core.remotes.delayTicks).toBeLessThanOrEqual(15);
    expect(shooter.core.remotes.viewTick).toBeLessThan(world.room.tick);
  });

  it.each(['clean', '100ms', '200ms'] as const)(
    'remote ship on the %s profile: drawn close to the truth, and never snapping',
    (profile) => {
      const errors: number[] = [];
      let worstSnap = -Infinity;
      let extrapolatedFrames = 0;
      let frames = 0;
      let previous: { x: number; y: number; z: number; atMs: number; spawnSeq: number } | null =
        null;
      const world = new TestWorld(9);
      const mover = world.addClient({
        controls: wanderer(77),
        link: profileLink(profile, 31),
      });
      // The watcher follows the mover around so it stays in view.
      const chase = hunter();
      const watcher = world.addClient({
        controls: (tick, core): Controls => ({ ...chase(tick, core), fire: false }),
        link: profileLink(profile, 41),
        onFrame: (core) => {
          const view = core.remoteViews()[0];
          const now = world.clock.now();
          if (!view?.full || now < 600 + THRESHOLDS.warmUpMs) {
            previous = null;
            return;
          }
          frames++;
          if (view.extrapolatedTicks > 0) extrapolatedFrames++;
          const truth = world.truthAt(view.id, view.viewTick);
          if (truth) errors.push(distance(view, truth));
          if (previous && previous.spawnSeq === view.spawnSeq && truth) {
            const limit = Math.max(maxSpeedOf(isBoosting(truth)), truth.speed);
            worstSnap = Math.max(
              worstSnap,
              snapExcess(
                distance(view, previous),
                now - previous.atMs,
                limit,
                THRESHOLDS.snapFactor,
              ),
            );
          }
          previous = { x: view.x, y: view.y, z: view.z, atMs: now, spawnSeq: view.spawnSeq };
        },
      });
      world.run(600);
      world.place(watcher.core.playerId, {
        ...STILL,
        x: 0,
        z: 4000,
        yaw: 0,
        speed: 20,
        targetSpeed: 20,
      });
      world.place(mover.core.playerId, {
        ...STILL,
        x: 30,
        z: 4150,
        yaw: 0.5,
        speed: 20,
        targetSpeed: 20,
      });
      world.run(60_000);

      expect(frames).toBeGreaterThan(3000);
      expect(errors.length).toBeGreaterThan(3000);
      const p95 = percentile(errors, 0.95);
      const max = Math.max(...errors);
      // The no-snap rule holds on every profile.
      expect(worstSnap).toBeLessThanOrEqual(0);
      // The position thresholds are set for the 100 ms profile; the clean one must meet them too.
      if (profile !== '200ms') {
        expect(p95).toBeLessThan(THRESHOLDS.remoteErrorP95);
        expect(max).toBeLessThan(THRESHOLDS.remoteErrorMax);
      }
      // On these links the ship is drawn between real samples nearly always.
      expect(extrapolatedFrames / frames).toBeLessThan(0.02);
      // The mover really moved about.
      const speeds = [...(world.truth.get(mover.core.playerId)?.values() ?? [])].map(
        (s) => s.speed,
      );
      expect(Math.max(...speeds)).toBeGreaterThan(50);
    },
  );

  it.each([
    ['clean', THRESHOLDS.hitAgreementMin],
    ['100ms', THRESHOLDS.hitAgreementMin],
  ] as const)(
    'hits on the %s profile: the server confirms what the shooter saw',
    (profile, minimum) => {
      const { world, shooter, target } = duel(profile, 7);
      world.run(60_000);

      const mine = world.hits.filter((h) => h.ownerId === shooter.core.playerId);
      const result = hitAgreement(shooter.viewHits, mine);
      expect(result.seen).toBeGreaterThan(60);
      expect(result.agreement).toBeGreaterThanOrEqual(minimum);
      // And the server did not decide many hits the shooter never saw.
      expect(result.unseen / mine.length).toBeLessThan(0.05);
      // Every predicted shot was a real shot. (The last one or two may still
      // be on their way to the server when the test stops.)
      expect(shooter.core.counters.ghostBullets).toBe(0);
      const inTransit = shooter.core.counters.shotsFired - world.room.stats.bulletsFired;
      expect(inTransit).toBeGreaterThanOrEqual(0);
      expect(inTransit).toBeLessThanOrEqual(2);
      // The target was hit on the server, not just on a screen.
      expect(world.truth.get(target.core.playerId)).toBeDefined();
      expect(mine.length).toBeGreaterThan(60);
    },
  );

  it('view delay reported on the 100 ms profile is about 230 ms and under the cap', () => {
    const { world, shooter } = duel('100ms', 7);
    world.run(20_000);
    const delayMs = shooter.core.viewDelayTicks * TICK_MS;
    expect(delayMs).toBeGreaterThan(150);
    expect(delayMs).toBeLessThan(SIM.maxViewDelayTicks * TICK_MS);
  });

  it('a kill: seven hits, a death with a unique id, a kill credited, a protected respawn', () => {
    const world = new TestWorld(4);
    const victim = world.addClient({ link: profileLink('100ms', 1) });
    const shooter = world.addClient({ controls: hunter(), link: profileLink('100ms', 3) });
    world.run(600);
    world.place(shooter.core.playerId, {
      ...STILL,
      x: 0,
      z: 4000,
      yaw: 0,
      speed: 20,
      targetSpeed: 20,
    });
    world.place(victim.core.playerId, {
      ...STILL,
      x: 0,
      z: 4200,
      yaw: 0,
      speed: 20,
      targetSpeed: 20,
    });
    // Long enough for the kill, the three-second wait and the respawn.
    world.run(7000);

    expect(world.deaths.length).toBeGreaterThanOrEqual(1);
    const death = world.deaths[0];
    expect(death).toMatchObject({
      victimId: victim.core.playerId,
      killerId: shooter.core.playerId,
      cause: CAUSE_PLAYER,
      kills: 0,
    });
    expect(death?.survivalTicks).toBeGreaterThan(60);
    const hitsBeforeDeath = world.hits.filter((h) => h.tick <= (death?.tick ?? 0));
    expect(hitsBeforeDeath).toHaveLength(7);
    expect(world.room.killsOf(shooter.core.playerId)).toBeGreaterThanOrEqual(1);
    expect(shooter.core.kills).toBe(world.room.killsOf(shooter.core.playerId));

    // Both clients were told, with the same id.
    for (const client of [victim, shooter]) {
      const told = client.events.filter((e) => e.kind === 'death');
      expect(told[0]).toMatchObject({ deathId: death?.deathId, killerId: shooter.core.playerId });
    }

    // The victim came back 180 ticks later, elsewhere, protected for 78 ticks.
    const truth = world.truth.get(victim.core.playerId);
    const respawnTick = (death?.tick ?? 0) + SIM.respawnTicks;
    expect(truth?.get(respawnTick - 1)?.alive).toBe(false);
    expect(truth?.get(respawnTick)).toMatchObject({
      alive: true,
      hp: 100,
      invulnTicks: 78,
      spawnSeq: 1,
    });
    expect(victim.core.counters.teleports).toBeGreaterThanOrEqual(1);
  });

  it('spawn protection: a freshly spawned ship cannot be hit for 78 ticks', () => {
    const world = new TestWorld(4);
    const victim = world.addClient({});
    const shooter = world.addClient({ controls: hunter() });
    world.run(600);
    world.place(shooter.core.playerId, {
      ...STILL,
      x: 0,
      z: 4000,
      yaw: 0,
      speed: 20,
      targetSpeed: 20,
    });
    const protectedFrom = world.room.tick;
    world.place(victim.core.playerId, {
      ...STILL,
      x: 0,
      z: 4150,
      yaw: 0,
      speed: 20,
      targetSpeed: 20,
      invulnTicks: 78,
    });
    world.run(6000);
    expect(world.hits.length).toBeGreaterThan(0);
    // The shooter's client applies the same rule, so it shows no early hit either.
    expect(Math.min(...world.hits.map((h) => h.tick))).toBeGreaterThanOrEqual(protectedFrom + 78);
    expect(Math.min(...shooter.viewHits.map((h) => h.tick))).toBeGreaterThanOrEqual(
      protectedFrom + 78,
    );
  });

  it('bullets are drawn: the shooter sees its own at once, a bystander sees them on the remote timeline', () => {
    const { world, shooter, target } = duel('100ms', 7);
    let ownSeen = 0;
    let remoteSeen = 0;
    world.clock.every(TICK_MS, () => {
      ownSeen = Math.max(ownSeen, shooter.core.bulletViews().length);
      remoteSeen = Math.max(remoteSeen, target.core.bulletViews().length);
    });
    world.run(15_000);
    expect(ownSeen).toBeGreaterThan(0);
    expect(remoteSeen).toBeGreaterThan(0);
    // The bystander fired nothing, so everything it draws came from the server.
    expect(target.core.counters.shotsFired).toBe(0);
  });
});

// --- Joining late, leaving, coming back -----------------------------------------

describe('late join', () => {
  it('a player who joins mid-fight sees the same ships, and the bullets already flying', () => {
    const { world, shooter, target } = duel('100ms', 7);
    world.run(10_000);
    const bulletsInFlight = world.room.bulletCount;
    const late = world.addClient({ link: profileLink('100ms', 9) });
    world.run(300);
    world.place(late.core.playerId, {
      ...STILL,
      x: 60,
      z: 4000,
      yaw: 0,
      speed: 20,
      targetSpeed: 20,
    });
    const announcedAtJoin = late.events.filter((e) => e.kind === 'bullet').length;
    world.run(3000);

    expect(bulletsInFlight).toBeGreaterThan(0);
    expect(announcedAtJoin).toBeGreaterThanOrEqual(bulletsInFlight - 2);
    const seen = late.core.remoteViews();
    expect(seen.map((v) => v.id).sort()).toEqual(
      [shooter.core.playerId, target.core.playerId].sort(),
    );
    for (const view of seen) {
      const truth = world.truthAt(view.id, view.viewTick);
      expect(truth && distance(view, truth)).toBeLessThan(THRESHOLDS.remoteErrorP95);
    }
    // And the others see the newcomer.
    expect(shooter.core.remoteViews().some((v) => v.id === late.core.playerId)).toBe(true);
  });
});

describe('interest tiers', () => {
  it('a distant ship is sent five times a second as a position; a near one thirty times in full', () => {
    const world = new TestWorld(2);
    const a = world.addClient({});
    const b = world.addClient({});
    world.run(600);
    world.place(a.core.playerId, { ...STILL, x: 0, z: 4000, speed: 5, targetSpeed: 5 });
    world.place(b.core.playerId, { ...STILL, x: 0, z: 7000, speed: 5, targetSpeed: 5 });
    world.run(2000);

    const bytesBefore = world.room.stats.bytesSent;
    world.run(10_000);
    const farBytes = world.room.stats.bytesSent - bytesBefore;
    expect(a.core.remoteViews()[0]).toMatchObject({ id: b.core.playerId, full: false });

    world.place(b.core.playerId, { z: 4500 });
    world.run(2000);
    const nearBefore = world.room.stats.bytesSent;
    world.run(10_000);
    const nearBytes = world.room.stats.bytesSent - nearBefore;
    expect(a.core.remoteViews()[0]).toMatchObject({ id: b.core.playerId, full: true });

    // Per player per second: 30 snapshots of the header, plus the other ship.
    const perSecond = (bytes: number): number => bytes / 2 / 10;
    const header = SNAPSHOT_HEADER_BYTES;
    expect(perSecond(farBytes)).toBeGreaterThan(30 * header);
    expect(perSecond(farBytes)).toBeLessThan(30 * header + 5 * FAR_ENTRY_BYTES + 30);
    expect(perSecond(nearBytes)).toBeGreaterThan(30 * (header + NEAR_ENTRY_BYTES) - 30);
    expect(perSecond(nearBytes)).toBeLessThan(30 * (header + NEAR_ENTRY_BYTES) + 30);
  });

  it('a ship leaving the near tier stays near until 2,200 units, so it does not flicker', () => {
    const world = new TestWorld(2);
    const a = world.addClient({});
    const b = world.addClient({});
    world.run(600);
    world.place(a.core.playerId, { ...STILL, x: 0, z: 4000 });
    world.place(b.core.playerId, { ...STILL, x: 0, z: 5900 });
    world.run(1000);
    expect(a.core.remoteViews()[0]?.full).toBe(true);
    world.place(b.core.playerId, { z: 6100 });
    world.run(1000);
    expect(a.core.remoteViews()[0]?.full).toBe(true);
    world.place(b.core.playerId, { z: 6300 });
    world.run(1000);
    expect(a.core.remoteViews()[0]?.full).toBe(false);
    world.place(b.core.playerId, { z: 6100 });
    world.run(1000);
    expect(a.core.remoteViews()[0]?.full).toBe(false);
  });
});

describe('disconnect (decision D6)', () => {
  it('the ship flies straight for 10 s and can be hit, then dies; the seat stays', () => {
    const world = new TestWorld(6);
    const leaver = world.addClient({
      controls: (): Controls => ({ yaw: 1, pitch: 0, throttle: 0, fire: false }),
    });
    const watcher = world.addClient({});
    world.run(600);
    world.place(leaver.core.playerId, {
      ...STILL,
      x: 0,
      z: 4200,
      yaw: 0,
      speed: 20,
      targetSpeed: 20,
    });
    world.place(watcher.core.playerId, {
      ...STILL,
      x: 0,
      z: 4000,
      yaw: 0,
      speed: 20,
      targetSpeed: 20,
    });
    world.run(2000);

    const id = leaver.core.playerId;
    leaver.transport.close();
    world.run(100);
    const droppedAt = world.room.tick;
    expect(world.room.isAway(id)).toBe(true);
    const yawAtDrop = world.room.shipOf(id)?.yaw;

    world.run(5000);
    // Still there, still flying, no longer turning.
    expect(world.room.shipOf(id)?.alive).toBe(true);
    expect(world.room.shipOf(id)?.yaw).toBeCloseTo(yawAtDrop ?? 0, 6);
    expect(watcher.core.remoteViews().some((v) => v.id === id && v.alive)).toBe(true);
    // It can be damaged while its player is away.
    const hpBefore = world.room.shipOf(id)?.hp ?? 0;
    world.place(id, { hp: hpBefore });
    expect(world.deaths).toEqual([]);

    world.run(6000);
    expect(world.deaths).toHaveLength(1);
    expect(world.deaths[0]).toMatchObject({
      victimId: id,
      killerId: null,
      cause: CAUSE_DISCONNECT,
    });
    const diedAfter = (world.deaths[0]?.tick ?? 0) - droppedAt;
    expect(Math.abs(diedAfter - AWAY_GRACE_TICKS)).toBeLessThanOrEqual(8);
    // The seat and its points are still held: a phone that was locked comes back to them.
    expect(world.left).toEqual([]);
    expect(world.room.playerCount).toBe(2);
    // The watcher no longer draws the destroyed ship.
    expect(watcher.core.remoteViews().some((v) => v.id === id && v.alive)).toBe(false);
  });

  it('a hunter can shoot down a ship whose player has gone', () => {
    const world = new TestWorld(6);
    const leaver = world.addClient({});
    const shooter = world.addClient({ controls: hunter() });
    world.run(600);
    world.place(leaver.core.playerId, {
      ...STILL,
      x: 0,
      z: 4200,
      yaw: 0,
      speed: 20,
      targetSpeed: 20,
    });
    world.place(shooter.core.playerId, {
      ...STILL,
      x: 0,
      z: 4000,
      yaw: 0,
      speed: 20,
      targetSpeed: 20,
    });
    leaver.transport.close();
    world.run(8000);
    expect(world.deaths[0]).toMatchObject({
      victimId: leaver.core.playerId,
      killerId: shooter.core.playerId,
      cause: CAUSE_PLAYER,
    });
  });
});

describe('reconnect', () => {
  it('within the grace period the same token gets the same seat, ship and kills', () => {
    const world = new TestWorld(8);
    const player = world.addSession({ controls: wanderer(3) });
    world.run(3000);
    const id = player.session.core.playerId;
    world.place(id, { hp: 55 });
    const before = world.room.shipOf(id);
    expect(player.links).toHaveLength(1);

    player.links[0]?.close();
    world.run(3000);

    expect(player.session.reconnects).toBe(1);
    expect(player.links).toHaveLength(2);
    expect(player.session.core.status).toBe('playing');
    expect(player.session.core.playerId).toBe(id);
    expect(world.room.playerCount).toBe(1);
    expect(world.room.isAway(id)).toBe(false);
    expect(world.room.shipOf(id)).toMatchObject({
      hp: 55,
      spawnSeq: before?.spawnSeq,
      alive: true,
    });
    expect(world.deaths).toEqual([]);

    // And it is predicting cleanly again.
    const correctionsAfter = player.corrections.length;
    world.run(5000);
    expect(player.corrections.length).toBe(correctionsAfter);
    const core = player.session.core;
    const predicted = core.predictedAt(core.ackTick);
    expect(predicted && core.ackState && shipStatesEqual(predicted, core.ackState)).toBe(true);
  });

  it('a phone locked for a minute, its socket closed, comes back to the same seat and points', () => {
    const world = new TestWorld(8);
    let reachable = true;
    const player = world.addSession({
      link: { up: () => (reachable ? 0 : null), down: () => (reachable ? 0 : null) },
    });
    world.run(2000);
    const id = player.session.core.playerId;
    const firstToken = player.session.core.sessionToken;
    world.room.addScore(id, 777);

    // The network goes dark for a minute; the socket closes.
    reachable = false;
    player.links[0]?.close();
    world.run(60_000);
    expect(world.deaths[0]).toMatchObject({ victimId: id, cause: CAUSE_DISCONNECT });
    expect(world.room.playerCount).toBe(1);
    expect(world.left).toEqual([]);

    reachable = true;
    world.run(8000);
    expect(player.session.core.status).toBe('playing');
    expect(player.session.core.playerId).toBe(id);
    expect(player.session.core.sessionToken).toEqual(firstToken);
    expect(world.room.scoreOf(id)).toBeGreaterThanOrEqual(777);
    expect(world.room.shipOf(id)).toMatchObject({ hp: 100, alive: true });
    expect(world.room.playerCount).toBe(1);
  });

  it('a dropped seat is given up after five minutes', () => {
    const world = new TestWorld(8);
    const leaver = world.addClient({});
    world.run(1000);
    const id = leaver.core.playerId;
    leaver.transport.close();
    world.run((SEAT_TICKS - 600) * TICK_MS);
    expect(world.room.playerIds()).toEqual([id]);
    world.run(1200 * TICK_MS);
    expect(world.left).toEqual([id]);
    expect(world.room.playerCount).toBe(0);
  });

  it("a wrong token does not take anyone else's seat", () => {
    const world = new TestWorld(8);
    const victim = world.addClient({});
    world.run(1000);
    const guess = Uint8Array.from({ length: 16 }, (_, i) => i * 7 + 1);
    const intruder = joined(world, guess);
    expect(intruder.welcome.playerId).not.toBe(victim.core.playerId);
    expect(victim.core.status).toBe('playing');
    expect(world.room.playerCount).toBe(2);
  });
});

describe('hidden tab', () => {
  it("3 s hidden: others see no snap, and the player resumes from the server's state", () => {
    let worstSnap = -Infinity;
    let previous: { x: number; y: number; z: number; atMs: number } | null = null;
    const world = new TestWorld(12);
    const hider = world.addSession({
      controls: wanderer(5),
      link: profileLink('100ms', 5),
    });
    const watcher = world.addClient({
      link: profileLink('100ms', 7),
      onFrame: (core) => {
        const view = core.remoteViews()[0];
        const now = world.clock.now();
        if (view && previous) {
          worstSnap = Math.max(
            worstSnap,
            snapExcess(
              distance(view, previous),
              now - previous.atMs,
              SIM.maxSpeed,
              THRESHOLDS.snapFactor,
            ),
          );
        }
        previous = view ? { x: view.x, y: view.y, z: view.z, atMs: now } : null;
      },
    });
    world.run(600);
    const id = hider.session.core.playerId;
    world.place(id, { ...STILL, x: 0, z: 4150, yaw: 0, speed: 20, targetSpeed: 20 });
    world.place(watcher.core.playerId, {
      ...STILL,
      x: 0,
      z: 4000,
      yaw: 0,
      speed: 20,
      targetSpeed: 20,
    });
    world.run(4000);
    worstSnap = -Infinity;

    hider.session.setHidden(true);
    world.run(200);
    expect(world.room.isAway(id)).toBe(true);
    expect(hider.session.core.status).toBe('away');
    const sentWhileHidden = hider.session.core.counters.inputsSent;
    world.run(2800);
    expect(hider.session.core.counters.inputsSent).toBe(sentWhileHidden);

    hider.session.setHidden(false);
    world.run(1000);
    expect(hider.session.core.status).toBe('playing');
    expect(hider.session.reconnects).toBe(0);
    expect(world.room.isAway(id)).toBe(false);
    expect(world.deaths).toEqual([]);

    // The watcher never saw the ship jump: before, during or after.
    world.run(4000);
    expect(worstSnap).toBeLessThanOrEqual(0);

    // The returning client did not replay the gap, and matches the server.
    const core = hider.session.core;
    expect(core.counters.skippedTicks).toBe(0);
    const predicted = core.predictedAt(core.ackTick);
    expect(predicted && core.ackState && shipStatesEqual(predicted, core.ackState)).toBe(true);
    const correctionsAfterReturn = hider.corrections.filter(
      (c) => c.timeMs > world.clock.now() - 3500,
    );
    expect(correctionsAfterReturn).toEqual([]);
  });

  it('if the socket died while hidden, the client notices within a second and reconnects', () => {
    const world = new TestWorld(12);
    let dead = false;
    const player = world.addSession({
      // A dead phone socket: nothing gets through, and nobody says so.
      link: { up: () => (dead ? null : 0), down: () => (dead ? null : 0) },
    });
    world.run(2000);
    const id = player.session.core.playerId;

    player.session.setHidden(true);
    world.run(100);
    dead = true;
    world.run(3000);
    player.session.setHidden(false);
    world.run(900);
    expect(player.session.reconnects).toBe(0);
    dead = false;
    world.run(600);

    expect(player.session.reconnects).toBe(1);
    world.run(1000);
    expect(player.session.core.status).toBe('playing');
    expect(player.session.core.playerId).toBe(id);
    expect(world.room.playerCount).toBe(1);
  });

  it('hidden for longer than the grace period: the ship dies, and respawns when the player returns', () => {
    const world = new TestWorld(12);
    const player = world.addSession({});
    world.run(2000);
    const id = player.session.core.playerId;
    player.session.setHidden(true);
    world.run(15_000);
    expect(world.deaths[0]).toMatchObject({ victimId: id, cause: CAUSE_DISCONNECT });
    expect(world.room.shipOf(id)?.alive).toBe(false);
    expect(world.room.playerCount).toBe(1);

    player.session.setHidden(false);
    world.run(1500);
    expect(player.session.core.status).toBe('playing');
    expect(world.room.shipOf(id)).toMatchObject({ alive: true, hp: 100 });
    expect(player.session.core.state?.alive).toBe(true);
  });
});

// --- Four players, and real message loss ------------------------------------------

describe('four hunters', () => {
  function melee(dropShare: number, seed: number): { world: TestWorld; clients: TestClient[] } {
    const world = new TestWorld(seed);
    const loss = new Rng(seed + 100);
    const lossy =
      (delayMs: number) =>
      (_data: Uint8Array, channel: string): number | null =>
        channel === 'droppable' && loss.next() < dropShare ? null : delayMs;
    const clients = [0, 1, 2, 3].map(() =>
      world.addClient({ controls: hunter(), link: { up: lossy(30), down: lossy(30) } }),
    );
    world.run(600);
    clients.forEach((client, i) => {
      const angle = (i / 4) * 2 * Math.PI;
      world.place(client.core.playerId, {
        ...STILL,
        x: Math.sin(angle) * 150,
        z: 4400 + Math.cos(angle) * 150,
        yaw: angle + Math.PI,
        speed: 20,
        targetSpeed: 20,
      });
    });
    return { world, clients };
  }

  it.each([
    ['no loss', 0],
    ['2% of inputs and snapshots lost', 0.02],
  ])(
    'with %s: everyone fights, kills are registered, and nobody is left in a wrong state',
    (_name, drop) => {
      const { world, clients } = melee(drop, 21);
      world.run(60_000);

      expect(world.room.stats.bulletsFired).toBeGreaterThan(50);
      expect(world.hits.length).toBeGreaterThan(14);
      const kills = world.deaths.filter((d) => d.cause === CAUSE_PLAYER);
      expect(kills.length).toBeGreaterThanOrEqual(2);
      expect(new Set(world.deaths.map((d) => d.deathId)).size).toBe(world.deaths.length);

      // Let the last messages land, then compare every client with the server.
      world.run(500);
      for (const client of clients) {
        const core = client.core;
        expect(core.status).toBe('playing');
        const mine = world.room.shipOf(core.playerId);
        // Its own ship: alive or dead as the server says, in the same life.
        expect(core.ackState).toMatchObject({ alive: mine?.alive, spawnSeq: mine?.spawnSeq });
        expect(core.kills).toBe(world.room.killsOf(core.playerId));
        // Every death reached it, exactly once.
        const told = client.events.filter((e) => e.kind === 'death').map((e) => e.deathId);
        expect(told.sort()).toEqual(world.deaths.map((d) => d.deathId).sort());
        // Every other ship: known, and in the right life.
        const views = core.remoteViews();
        expect(views).toHaveLength(3);
        for (const view of views) {
          const theirs = world.room.shipOf(view.id);
          expect(view.spawnSeq).toBe(theirs?.spawnSeq);
        }
      }

      // What shooters saw and what the server decided. In a free-for-all two
      // players can shoot the same ship; a hit seen on a ship that another
      // player destroyed a moment earlier is the one disagreement lag
      // compensation cannot remove, so that is the only kind allowed here.
      const seen = clients.flatMap((c) => c.viewHits);
      const result = hitAgreement(seen, world.hits);
      expect(result.seen).toBeGreaterThan(14);
      expect(result.agreement).toBeGreaterThanOrEqual(0.8);
      if (drop === 0) {
        const confirmed = new Set(
          world.hits.map((h) => `${h.ownerId}:${h.spawnTick}:${h.targetId}`),
        );
        for (const hit of seen) {
          if (confirmed.has(`${hit.ownerId}:${hit.spawnTick}:${hit.targetId}`)) continue;
          const target = world.truth.get(hit.targetId)?.get(hit.tick);
          expect(target?.alive, `unconfirmed hit on a live ship at tick ${hit.tick}`).toBe(false);
        }
      }
    },
  );
});

// --- A bad link: late inputs, corrections and stalls ----------------------------

describe('on the 200 ms lossy profile', () => {
  it('the shooter is shown the hits the server counted, though its own ship keeps being corrected', () => {
    // As in the browser suite: two hunters, two ships flying erratically,
    // and every ship kept alive so that only lag compensation is measured.
    const world = new TestWorld(7);
    const clients = [0, 1, 2, 3].map((i) =>
      world.addClient({
        controls: i % 2 === 0 ? hunter() : wanderer(11 + i),
        link: profileLink('200ms-lossy', 70 + 2 * i),
      }),
    );
    world.run(600);
    clients.forEach((client, i) => {
      const angle = (i / 4) * 2 * Math.PI;
      world.place(client.core.playerId, {
        ...STILL,
        x: Math.sin(angle) * 150,
        z: 4400 + Math.cos(angle) * 150,
        yaw: angle + Math.PI,
        speed: 20,
        targetSpeed: 20,
      });
    });
    world.clock.every(TICK_MS, () => {
      for (const client of clients) world.place(client.core.playerId, { hp: SIM.maxHp });
    });
    world.run(42_000);

    // The link really was bad: inputs arrived late and ships were corrected.
    const hunters = [clients[0], clients[2]].filter((c): c is TestClient => c !== undefined);
    for (const shooter of hunters) {
      expect(shooter.core.counters.missedInputs).toBeGreaterThan(100);
      expect(shooter.corrections.length).toBeGreaterThan(100);
    }

    // Judge the hits whose news has had time to reach the shooter.
    const settled = (hit: { tick: number }): boolean => hit.tick <= world.room.tick - 120;
    const ids = new Set(hunters.map((c) => c.core.playerId));
    const counted = world.hits.filter((h) => ids.has(h.ownerId) && settled(h));
    const shown = hunters.flatMap((c) => c.viewHits).filter(settled);
    const result = hitAgreement(shown, counted);
    expect(counted.length).toBeGreaterThan(150);
    // A shot fired from a place the server then corrected is tested again
    // from the corrected place. Without that, one hit in seven went unshown.
    expect(result.unseen / counted.length).toBeLessThan(0.02);
    expect(result.agreement).toBeGreaterThanOrEqual(THRESHOLDS.hitAgreementMin);
  });
});

describe('a kill seen from the shooter', () => {
  // A plain ship takes 7 bullets. A shield of 50 comes off first (decision
  // D8), which makes it 10. A Fenix beam does 30, which makes it 4.
  const CASES = [
    { name: 'a plain ship', shield: 0, fenix: false, hits: 7 },
    { name: 'a ship with half a shield', shield: 50, fenix: false, hits: 10 },
    { name: 'a plain ship shot by a Fenix', shield: 0, fenix: true, hits: 4 },
  ];
  const PROFILES_TO_TRY = ['clean', '100ms', '200ms'] as const;
  const all = CASES.flatMap((c) => PROFILES_TO_TRY.map((profile) => ({ ...c, profile })));

  it.each(all)(
    '$name on the $profile profile: the shooter sees exactly the $hits hits that counted, and none on the wreck',
    ({ profile, shield, fenix, hits }) => {
      const world = new TestWorld(4, SIM.asteroidCount, false);
      const victim = world.addClient({ link: profileLink(profile, 1) });
      const shooter = world.addClient({ controls: hunter(), link: profileLink(profile, 3) });
      world.run(600);
      world.place(shooter.core.playerId, {
        ...STILL,
        x: 0,
        z: 4000,
        yaw: 0,
        speed: 20,
        targetSpeed: 20,
        fenix,
      });
      world.place(victim.core.playerId, {
        ...STILL,
        x: 0,
        z: 4200,
        yaw: 0,
        speed: 20,
        targetSpeed: 20,
        shield,
      });
      // Stop at the first death, before the respawn starts another fight.
      world.clock.every(TICK_MS, () => {
        if (world.deaths.length > 0) world.place(shooter.core.playerId, { fireCooldown: 250 });
      });
      world.run(8000);

      expect(world.deaths).toHaveLength(1);
      const serverHits = world.hits.filter((h) => h.ownerId === shooter.core.playerId);
      expect(serverHits).toHaveLength(hits);
      const result = hitAgreement(shooter.viewHits, serverHits);
      // Without tracking the target's expected hit points and shield the
      // shooter would see more hits land on a ship that was already dead.
      expect(result.seen).toBe(hits);
      expect(result.confirmed).toBe(hits);
      expect(shooter.viewHits.every((h) => h.damage === (fenix ? 30 : 15))).toBe(true);
    },
  );
});
