import { describe, expect, it } from 'vitest';
import {
  CAUSE_EDGE,
  CAUSE_PLAYER,
  FAR_ENTRY_BYTES,
  INPUT_REDUNDANCY,
  NEAR_ENTRY_BYTES,
  SEEKER_ENTRY_BYTES,
  NO_PLAYER,
  PROTOCOL_VERSION,
  REJECT_FULL,
  REJECT_IDLE,
  REJECT_VERSION,
  SNAPSHOT_HEADER_BYTES,
  decodeClientMessage,
  decodeServerMessage,
  encodeBuy,
  encodeEvents,
  encodeHello,
  encodeInput,
  encodePresence,
  encodeReject,
  encodeScores,
  encodeSnapshot,
  encodeWelcome,
} from '../../src/shared/protocol.ts';
import type { GameEvent } from '../../src/shared/protocol.ts';
import { distantSampleOf, sampleOf } from '../../src/shared/remote.ts';
import { Rng } from '../../src/shared/rng.ts';
import { STORE_ITEMS } from '../../src/shared/scoring.ts';
import { SIM_FINGERPRINT } from '../../src/shared/sim/fingerprint.ts';
import { MAX_VIEW_DELAY, quantiseControls, spawnShip } from '../../src/shared/sim/ship.ts';

const ship = {
  ...spawnShip(new Rng(3), 5),
  boostTicks: 77,
  roll: -0.123456789012345,
  hp: 85,
  invulnTicks: 12,
  fireCooldown: 3,
};
const token = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const neutral = quantiseControls({ yaw: 0, pitch: 0, throttle: 0, fire: false });

describe('client messages', () => {
  it('hello round-trips, with and without a session token', () => {
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      simFingerprint: SIM_FINGERPRINT,
      clientTimeMs: 12345.678,
    };
    expect(decodeClientMessage(encodeHello({ ...base, sessionToken: null }))).toEqual({
      type: 'hello',
      ...base,
      sessionToken: null,
    });
    expect(decodeClientMessage(encodeHello({ ...base, sessionToken: token }))).toEqual({
      type: 'hello',
      ...base,
      sessionToken: token,
    });
  });

  it('input round-trips with its redundant copies, buttons and view delay', () => {
    const inputs = [
      quantiseControls({ yaw: 1, pitch: -1, throttle: 1, fire: true }, 14.25),
      quantiseControls({ yaw: -0.3, pitch: 0.2, throttle: -1, fire: false, boost: true }, 3),
      quantiseControls({ yaw: 0, pitch: 0, throttle: 0, fire: false, brake: true, heavy: true }),
    ];
    expect(inputs[0]).toMatchObject({ fire: true, boost: false, brake: false, viewDelay: 228 });
    expect(inputs[1]).toMatchObject({ boost: true, brake: false });
    expect(inputs[2]).toMatchObject({ boost: false, brake: true, heavy: true, seek: false });
    expect(inputs[0]?.heavy).toBe(false);
    const decoded = decodeClientMessage(encodeInput(4_000_000_000, inputs));
    expect(decoded).toEqual({ type: 'input', tick: 4_000_000_000, inputs });
  });

  it('an input message is 21 bytes', () => {
    expect(encodeInput(1, [neutral, neutral, neutral]).byteLength).toBe(21);
    expect(INPUT_REDUNDANCY).toBe(3);
  });

  it('a view delay above the cap is clamped, not refused', () => {
    const bytes = Uint8Array.from(encodeInput(10, [neutral]));
    bytes[9] = 0xff;
    bytes[10] = 0xff;
    const decoded = decodeClientMessage(bytes);
    expect(decoded?.type === 'input' && decoded.inputs[0]?.viewDelay).toBe(MAX_VIEW_DELAY);
    expect(quantiseControls({ yaw: 0, pitch: 0, throttle: 0, fire: false }, 500).viewDelay).toBe(
      MAX_VIEW_DELAY,
    );
    expect(quantiseControls({ yaw: 0, pitch: 0, throttle: 0, fire: false }, -3).viewDelay).toBe(0);
  });

  it('presence round-trips', () => {
    expect(decodeClientMessage(encodePresence(true, 5))).toEqual({
      type: 'presence',
      away: true,
      clientTimeMs: 5,
    });
    expect(decodeClientMessage(encodePresence(false, 7))).toEqual({
      type: 'presence',
      away: false,
      clientTimeMs: 7,
    });
  });

  it('a store request round-trips, and one for something the store does not sell is refused', () => {
    for (const item of STORE_ITEMS) {
      expect(decodeClientMessage(encodeBuy(item))).toEqual({ type: 'buy', item });
    }
    expect(encodeBuy('hp').byteLength).toBe(2);
    expect(decodeClientMessage(new Uint8Array([4, 3]))).toBeNull();
    expect(decodeClientMessage(new Uint8Array([4, 0, 0]))).toBeNull();
  });

  it('malformed messages decode to null', () => {
    const good = encodeInput(10, [neutral]);
    expect(decodeClientMessage(new Uint8Array(0))).toBeNull();
    expect(decodeClientMessage(new Uint8Array([99, 1, 2, 3]))).toBeNull();
    expect(decodeClientMessage(good.subarray(0, good.byteLength - 1))).toBeNull();
    expect(decodeClientMessage(new Uint8Array([...good, 0]))).toBeNull();
    expect(decodeClientMessage(new Uint8Array(1000).fill(2))).toBeNull();

    const badCount = Uint8Array.from(good);
    badCount[5] = 0;
    expect(decodeClientMessage(badCount)).toBeNull();
    const badAxis = Uint8Array.from(good);
    badAxis[6] = 0x80; // −128
    expect(decodeClientMessage(badAxis)).toBeNull();
    const badThrottle = Uint8Array.from(good);
    badThrottle[8] = 3;
    expect(decodeClientMessage(badThrottle)).toBeNull();
    const badButtons = Uint8Array.from(good);
    badButtons[8] = 0x81;
    expect(decodeClientMessage(badButtons)).toBeNull();
  });

  it('survives every prefix and random bytes without throwing', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 5000; i++) {
      const bytes = new Uint8Array(Math.floor(rng.next() * 60));
      for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(rng.next() * 256);
      expect(() => decodeClientMessage(bytes)).not.toThrow();
      expect(() => decodeServerMessage(bytes)).not.toThrow();
    }
  });
});

describe('server messages', () => {
  it('welcome round-trips the ship at full precision, and the token', () => {
    const message = {
      playerId: 7,
      serverTick: 123456,
      clientTimeMs: 99.5,
      sessionToken: token,
      ship,
      worldSeed: 0xdeadbeef,
      asteroidCount: 2000,
      withOrbs: true,
    };
    expect(decodeServerMessage(encodeWelcome(message))).toEqual({ type: 'welcome', ...message });
  });

  it('snapshot round-trips: own ship exactly, other ships on the wire grid', () => {
    const rng = new Rng(21);
    const near = sampleOf(42, {
      ...spawnShip(rng, 3),
      yaw: -2.5,
      pitch: 0.7,
      roll: -0.31,
      hp: 40,
      boostTicks: 9,
    });
    const far = distantSampleOf(sampleOf(42, { ...spawnShip(rng, 9), y: -499.99 }));
    const message = {
      serverTick: 42,
      inputLead: 2.5,
      missedInputs: 1,
      ship,
      kills: 12,
      score: 4_000_000_000,
      asteroidMultTicks: 1800,
      killMultTicks: 7,
      storeTicks: 1200,
      remotes: [
        { id: 3, sample: near },
        { id: 15, sample: far },
      ],
      seekers: [
        { ownerId: 3, targetId: 7, x: 4000.25, y: -12.5, z: -3999.75 },
        { ownerId: 15, targetId: NO_PLAYER, x: -5200, y: 499, z: 0.5 },
      ],
    };
    const bytes = encodeSnapshot(message);
    // What the server keeps for rewinding is exactly what the client decodes.
    expect(decodeServerMessage(bytes)).toEqual({ type: 'snapshot', ...message });
    expect(bytes.byteLength).toBe(
      SNAPSHOT_HEADER_BYTES + NEAR_ENTRY_BYTES + FAR_ENTRY_BYTES + 2 * SEEKER_ENTRY_BYTES,
    );
    expect(near.full).toBe(true);
    expect(far).toMatchObject({ full: false, yaw: 0, hp: 0 });
  });

  it('quantised positions are within 1/512 of a unit, and height within 1/128', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 2000; i++) {
      const s = {
        ...spawnShip(rng, 0),
        y: (rng.next() - 0.5) * 1000,
        yaw: (rng.next() - 0.5) * 6.28,
      };
      const q = sampleOf(1, s);
      expect(Math.abs(q.x - s.x)).toBeLessThanOrEqual(1 / 512);
      expect(Math.abs(q.z - s.z)).toBeLessThanOrEqual(1 / 512);
      expect(Math.abs(q.y - s.y)).toBeLessThanOrEqual(1 / 128);
      expect(Math.abs(q.yaw - s.yaw)).toBeLessThan(0.0001);
    }
  });

  it('a NaN lead survives, meaning "no sample"', () => {
    const none = decodeServerMessage(
      encodeSnapshot({
        serverTick: 42,
        inputLead: Number.NaN,
        missedInputs: 0,
        ship,
        kills: 0,
        score: 0,
        asteroidMultTicks: 0,
        killMultTicks: 0,
        storeTicks: 0,
        remotes: [],
        seekers: [],
      }),
    );
    expect(none?.type === 'snapshot' && Number.isNaN(none.inputLead)).toBe(true);
  });

  it('a snapshot is 108 bytes plus 21 per nearby ship and 12 per homing shot', () => {
    expect(SNAPSHOT_HEADER_BYTES).toBe(108);
    expect(SEEKER_ENTRY_BYTES).toBe(12);
    expect(NEAR_ENTRY_BYTES).toBe(21);
    expect(FAR_ENTRY_BYTES).toBe(13);
  });

  it('the scoreboard round-trips', () => {
    const entries = [
      { playerId: 0, score: 0, kills: 0 },
      { playerId: 15, score: 123456, kills: 42 },
    ];
    expect(decodeServerMessage(encodeScores(entries))).toEqual({ type: 'scores', entries });
  });

  it('events round-trip', () => {
    const events: GameEvent[] = [
      {
        kind: 'bullet',
        ownerId: 2,
        spawnTick: 1000,
        x: 1.5,
        y: -2.25,
        z: 4000.5,
        yaw: 0.5,
        pitch: -0.25,
        shot: 'beam',
      },
      { kind: 'hit', ownerId: 2, spawnTick: 1000, targetId: 5, tick: 1012, hp: 70, shield: 25 },
      {
        kind: 'asteroid',
        asteroidId: 1999,
        tick: 1013,
        playerId: 2,
        spawnTick: 1001,
        byBullet: true,
      },
      { kind: 'death', deathId: 77, victimId: 5, killerId: 2, cause: CAUSE_PLAYER, tick: 1100 },
      { kind: 'death', deathId: 78, victimId: 6, killerId: NO_PLAYER, cause: 1, tick: 1101 },
      { kind: 'left', playerId: 9 },
      { kind: 'orb', orbId: 1359, tick: 1014, playerId: 3, spawnTick: 0, byBullet: false },
      { kind: 'orb', orbId: 2, tick: 1015, playerId: NO_PLAYER, spawnTick: 990, byBullet: true },
      { kind: 'death', deathId: 79, victimId: 6, killerId: NO_PLAYER, cause: CAUSE_EDGE, tick: 9 },
      { kind: 'grant', item: 'fenix', applyTick: 1044 },
    ];
    expect(decodeServerMessage(encodeEvents(events))).toEqual({ type: 'events', events });
    expect(decodeServerMessage(encodeEvents([]))).toEqual({ type: 'events', events: [] });
  });

  it('reject round-trips for each reason, and an unknown reason is malformed', () => {
    for (const reason of [REJECT_VERSION, REJECT_FULL, REJECT_IDLE] as const) {
      expect(decodeServerMessage(encodeReject(reason))).toEqual({ type: 'reject', reason });
    }
    expect(decodeServerMessage(new Uint8Array([2, 9]))).toBeNull();
  });
});
