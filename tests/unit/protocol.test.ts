import { describe, expect, it } from 'vitest';
import {
  INPUT_REDUNDANCY,
  PROTOCOL_VERSION,
  REJECT_FULL,
  decodeClientMessage,
  decodeServerMessage,
  encodeHello,
  encodeInput,
  encodeReject,
  encodeSnapshot,
  encodeWelcome,
} from '../../src/shared/protocol.ts';
import { Rng } from '../../src/shared/rng.ts';
import { SIM_FINGERPRINT } from '../../src/shared/sim/fingerprint.ts';
import { quantiseControls, spawnShip } from '../../src/shared/sim/ship.ts';

const ship = { ...spawnShip(new Rng(3), 5), boostTicks: 77, roll: -0.123456789012345 };

describe('client messages', () => {
  it('hello round-trips', () => {
    const bytes = encodeHello({
      protocolVersion: PROTOCOL_VERSION,
      simFingerprint: SIM_FINGERPRINT,
      clientTimeMs: 12345.678,
    });
    expect(decodeClientMessage(bytes)).toEqual({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      simFingerprint: SIM_FINGERPRINT,
      clientTimeMs: 12345.678,
    });
  });

  it('input round-trips with its redundant copies', () => {
    const inputs = [
      quantiseControls({ yaw: 1, pitch: -1, throttle: 1 }),
      quantiseControls({ yaw: -0.3, pitch: 0.2, throttle: -1 }),
      quantiseControls({ yaw: 0, pitch: 0, throttle: 0 }),
    ];
    const decoded = decodeClientMessage(encodeInput(4_000_000_000, inputs));
    expect(decoded).toEqual({ type: 'input', tick: 4_000_000_000, inputs });
  });

  it('an input message is 15 bytes', () => {
    const input = quantiseControls({ yaw: 0, pitch: 0, throttle: 0 });
    expect(encodeInput(1, [input, input, input]).byteLength).toBe(15);
    expect(INPUT_REDUNDANCY).toBe(3);
  });

  it('malformed messages decode to null', () => {
    const good = encodeInput(10, [quantiseControls({ yaw: 0, pitch: 0, throttle: 0 })]);
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
  });

  it('survives every prefix and random bytes without throwing', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 5000; i++) {
      const bytes = new Uint8Array(Math.floor(rng.next() * 40));
      for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(rng.next() * 256);
      expect(() => decodeClientMessage(bytes)).not.toThrow();
      expect(() => decodeServerMessage(bytes)).not.toThrow();
    }
  });
});

describe('server messages', () => {
  it('welcome round-trips the ship at full precision', () => {
    const decoded = decodeServerMessage(
      encodeWelcome({ playerId: 7, serverTick: 123456, clientTimeMs: 99.5, ship }),
    );
    expect(decoded).toEqual({
      type: 'welcome',
      playerId: 7,
      serverTick: 123456,
      clientTimeMs: 99.5,
      ship,
    });
  });

  it('snapshot round-trips, including a NaN lead for "no sample"', () => {
    const decoded = decodeServerMessage(
      encodeSnapshot({ serverTick: 42, inputLead: 2.5, missedInputs: 1, ship }),
    );
    expect(decoded).toEqual({
      type: 'snapshot',
      serverTick: 42,
      inputLead: 2.5,
      missedInputs: 1,
      ship,
    });
    const none = decodeServerMessage(
      encodeSnapshot({ serverTick: 42, inputLead: Number.NaN, missedInputs: 0, ship }),
    );
    expect(none?.type === 'snapshot' && Number.isNaN(none.inputLead)).toBe(true);
  });

  it('reject round-trips', () => {
    expect(decodeServerMessage(encodeReject(REJECT_FULL))).toEqual({
      type: 'reject',
      reason: REJECT_FULL,
    });
  });

  it('a snapshot is 80 bytes', () => {
    expect(encodeSnapshot({ serverTick: 1, inputLead: 0, missedInputs: 0, ship }).byteLength).toBe(
      80,
    );
  });
});
