import { describe, expect, it } from 'vitest';
import { TICK_MS } from '../../src/shared/constants.ts';
import {
  PROTOCOL_VERSION,
  REJECT_FULL,
  REJECT_VERSION,
  encodeHello,
  encodeInput,
} from '../../src/shared/protocol.ts';
import { SIM_FINGERPRINT } from '../../src/shared/sim/fingerprint.ts';
import { quantiseControls, shipStatesEqual, stepShip } from '../../src/shared/sim/ship.ts';
import { Room } from '../../src/server/room.ts';
import { TestWorld } from '../support/harness.ts';
import { RawClient, joined } from '../support/rawClient.ts';
import { createLink } from '../support/loopback.ts';

const FULL_LEFT = quantiseControls({ yaw: 1, pitch: 0, throttle: 1, fire: false });

describe('joining', () => {
  it('welcomes a matching client with its id, the tick and its ship', () => {
    const world = new TestWorld();
    world.run(1000);
    const { welcome } = joined(world);
    expect(welcome.playerId).toBe(0);
    expect(welcome.serverTick).toBeGreaterThan(55);
    expect(welcome.ship.alive).toBe(true);
    expect(world.room.playerCount).toBe(1);
  });

  it('rejects a different protocol version or a different simulation fingerprint, and closes', () => {
    for (const [version, fingerprint] of [
      [PROTOCOL_VERSION + 1, SIM_FINGERPRINT],
      [PROTOCOL_VERSION, SIM_FINGERPRINT ^ 1],
    ] as const) {
      const world = new TestWorld();
      const client = new RawClient(world);
      client.hello(version, fingerprint);
      world.run(5);
      expect(client.received).toEqual([{ type: 'reject', reason: REJECT_VERSION }]);
      expect(client.closed).not.toBeNull();
      expect(world.room.playerCount).toBe(0);
    }
  });

  it('holds 16 players and rejects the 17th', () => {
    const world = new TestWorld();
    const ids = new Set<number>();
    for (let i = 0; i < 16; i++) ids.add(joined(world).welcome.playerId);
    expect(ids.size).toBe(16);
    const extra = new RawClient(world);
    extra.hello();
    world.run(5);
    expect(extra.received).toEqual([{ type: 'reject', reason: REJECT_FULL }]);
    expect(world.room.playerCount).toBe(16);
  });

  it('holds the seat for ten seconds after a player leaves, then frees it', () => {
    const world = new TestWorld();
    const link = createLink(world.clock);
    world.room.connect(link.server);
    link.client.send(
      encodeHello({
        protocolVersion: PROTOCOL_VERSION,
        simFingerprint: SIM_FINGERPRINT,
        clientTimeMs: 0,
        sessionToken: null,
      }),
      'reliable',
    );
    world.run(5);
    expect(world.room.playerCount).toBe(1);
    link.client.close();
    world.run(9000);
    expect(world.room.playerCount).toBe(1);
    expect(world.room.isAway(0)).toBe(true);
    world.run(1200);
    expect(world.room.playerCount).toBe(0);
    expect(joined(world).welcome.playerId).toBe(0);
  });

  it('closes a connection that never says hello', () => {
    const world = new TestWorld();
    const client = new RawClient(world);
    world.run(4000);
    expect(client.closed).toBeNull();
    world.run(1500);
    expect(client.closed).not.toBeNull();
  });
});

describe('server authority', () => {
  it('a client that floods inputs moves exactly as far as one that sends one per tick', () => {
    const world = new TestWorld();
    const { client, welcome } = joined(world);

    // Every millisecond, claim the next 100 ticks, three inputs per message.
    world.clock.every(1, () => {
      for (let ahead = 1; ahead <= 100; ahead += 3) {
        client.send(encodeInput(world.room.tick + ahead + 2, [FULL_LEFT, FULL_LEFT, FULL_LEFT]));
      }
    });
    world.run(5000);

    // Path length depends only on speed, and speed only on throttle. The
    // most an honest ship can cover is full throttle from the first tick.
    const truth = world.truth.get(welcome.playerId);
    let honest = welcome.ship;
    let honestPath = 0;
    let actualPath = 0;
    let previous = welcome.ship;
    for (let tick = welcome.serverTick + 1; tick <= world.room.tick; tick++) {
      const before = honest;
      honest = stepShip(honest, FULL_LEFT);
      honestPath += Math.hypot(honest.x - before.x, honest.y - before.y, honest.z - before.z);
      const actual = truth?.get(tick);
      if (!actual) throw new Error(`no truth for tick ${tick}`);
      actualPath += Math.hypot(actual.x - previous.x, actual.y - previous.y, actual.z - previous.z);
      previous = actual;
    }
    expect(world.room.tick - welcome.serverTick).toBeGreaterThan(295);
    expect(actualPath).toBeGreaterThan(100);
    expect(actualPath).toBeLessThanOrEqual(honestPath + 1e-9);
    expect(previous.speed).toBeLessThanOrEqual(honest.speed);
    // The buffer of future inputs stayed bounded: the flood was refused, not stored.
    expect(world.room.stats.missedInputs).toBe(0);
  });

  it('simulates exactly one input per tick: the first copy of a tick wins', () => {
    const world = new TestWorld();
    const { client, welcome } = joined(world);
    const right = quantiseControls({ yaw: -1, pitch: 0, throttle: 0, fire: false });
    const target = world.room.tick + 10;
    client.send(encodeInput(target, [FULL_LEFT]));
    for (let i = 0; i < 50; i++) client.send(encodeInput(target, [right]));
    world.run(400);
    const ship = world.room.shipOf(welcome.playerId);
    // One tick of left turn, held afterwards because later inputs never came.
    expect(ship && ship.yaw).toBeGreaterThan(0);
  });

  it('ignores inputs for ticks already simulated and for ticks too far ahead', () => {
    const world = new TestWorld();
    world.run(1000);
    const { client, welcome } = joined(world);
    client.send(encodeInput(world.room.tick - 5, [FULL_LEFT]));
    client.send(encodeInput(world.room.tick + 10_000, [FULL_LEFT]));
    world.run(1000);
    const ship = world.room.shipOf(welcome.playerId);
    expect(ship?.yaw).toBe(0);
    expect(world.room.stats.lateInputs).toBe(1);
  });

  it('counts malformed messages, keeps running, and closes a connection that keeps sending them', () => {
    const world = new TestWorld();
    const { client, welcome } = joined(world);
    const before = world.room.shipOf(welcome.playerId);

    client.send(new Uint8Array([255, 1, 2, 3]));
    client.send(new Uint8Array(0));
    client.send(new Uint8Array(500));
    client.hello(); // a second hello is not allowed
    world.run(100);
    expect(world.room.stats.malformedMessages).toBe(4);
    expect(client.closed).toBeNull();
    expect(world.room.playerCount).toBe(1);
    const after = world.room.shipOf(welcome.playerId);
    expect(before && after && after.z).toBeGreaterThan(before?.z ?? Infinity);

    for (let i = 0; i < 16; i++) client.send(new Uint8Array([9]));
    world.run(100);
    expect(client.closed).not.toBeNull();
    expect(world.room.isAway(welcome.playerId)).toBe(true);
  });

  it('treats an input before hello as malformed', () => {
    const world = new TestWorld();
    const client = new RawClient(world);
    client.send(encodeInput(5, [FULL_LEFT]));
    world.run(50);
    expect(world.room.stats.malformedMessages).toBe(1);
    expect(world.room.playerCount).toBe(0);
  });

  it('has no client message that carries a position', () => {
    // The whole client-to-server surface is hello, presence and input. An
    // input is a tick number and, per tick, two stick axes, a byte of buttons
    // and how far behind the player's view of the others was.
    const bytes = encodeInput(1, [FULL_LEFT]);
    expect(bytes.byteLength).toBe(11);
  });
});

describe('tick loop', () => {
  it('runs 60 ticks a second whatever the polling interval', () => {
    for (const pollMs of [1, 7, 16, 40]) {
      let now = 0;
      const room = new Room({
        now: () => now,
        seed: 1,
        createToken: () => new Uint8Array(16).fill(1),
      });
      room.advance();
      for (now = pollMs; now <= 10_000; now += pollMs) room.advance();
      expect(Math.abs(room.tick - 600)).toBeLessThanOrEqual(Math.ceil(pollMs / TICK_MS));
    }
  });

  it('catches up after a short stall and drops ticks after a very long one', () => {
    let now = 0;
    const room = new Room({
      now: () => now,
      seed: 1,
      createToken: () => new Uint8Array(16).fill(1),
    });
    room.advance();
    now = 501;
    room.advance();
    expect(room.tick).toBe(30);
    expect(room.stats.droppedTicks).toBe(0);

    now += 10_000;
    room.advance();
    expect(room.tick).toBe(150);
    expect(room.stats.droppedTicks).toBe(480);
    // And it is back on schedule afterwards.
    now += 1000;
    room.advance();
    expect(room.tick).toBe(210);
  });

  it('sends each player a snapshot every second tick with its own ship', () => {
    const world = new TestWorld();
    const { client, welcome } = joined(world);
    world.run(1000);
    const snapshots = client.received.filter((m) => m.type === 'snapshot');
    expect(snapshots.length).toBeGreaterThanOrEqual(29);
    expect(snapshots.length).toBeLessThanOrEqual(31);
    const last = snapshots[snapshots.length - 1];
    const truth = world.truth.get(welcome.playerId)?.get(last?.serverTick ?? -1);
    expect(last && truth && shipStatesEqual(last.ship, truth)).toBe(true);
    expect(last && Number.isNaN(last.inputLead)).toBe(true);
  });

  it('respawns a ship three seconds after it hits the planet', () => {
    const world = new TestWorld(5);
    const { client, welcome } = joined(world);
    // Fly at the planet: turn toward the origin, then full throttle.
    const spawn = welcome.ship;
    const bearing = Math.atan2(-spawn.x, -spawn.z);
    world.clock.every(TICK_MS, () => {
      const ship = world.room.shipOf(welcome.playerId);
      if (!ship) return;
      let error = bearing - ship.yaw;
      if (error > Math.PI) error -= 2 * Math.PI;
      if (error < -Math.PI) error += 2 * Math.PI;
      const input = quantiseControls({
        yaw: Math.max(-1, Math.min(1, error * 4)),
        pitch: 0,
        throttle: 1,
        fire: false,
      });
      client.send(encodeInput(world.room.tick + 3, [input, input, input]));
    });
    let diedAtTick = -1;
    let respawnedAtTick = -1;
    world.clock.every(1, () => {
      const ship = world.room.shipOf(welcome.playerId);
      if (!ship) return;
      if (!ship.alive && diedAtTick < 0) diedAtTick = world.room.tick;
      if (ship.alive && diedAtTick >= 0 && respawnedAtTick < 0) respawnedAtTick = world.room.tick;
    });
    world.run(120_000);
    expect(diedAtTick).toBeGreaterThan(0);
    expect(respawnedAtTick - diedAtTick).toBe(180);
    const ship = world.room.shipOf(welcome.playerId);
    expect(ship?.spawnSeq).toBeGreaterThanOrEqual(1);
  });
});
