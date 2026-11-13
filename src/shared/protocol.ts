// Binary wire format, little-endian.
//
// Clients send two things only: a hello and their numbered inputs. There is
// no message that carries a position, a hit or a score from client to server.
//
// The own ship travels as float64 so the client can compare its prediction
// with the server's state exactly.

import { inputFromWire } from './sim/ship.ts';
import type { Input, ShipState } from './sim/ship.ts';

export const PROTOCOL_VERSION = 1;

/** Inputs carried per message: the tick's own plus the ones before it. */
export const INPUT_REDUNDANCY = 3;

export const MAX_CLIENT_MESSAGE_BYTES = 64;

const CLIENT_HELLO = 1;
const CLIENT_INPUT = 2;

const SERVER_WELCOME = 1;
const SERVER_REJECT = 2;
const SERVER_SNAPSHOT = 3;

export const REJECT_VERSION = 1;
export const REJECT_FULL = 2;
export type RejectReason = typeof REJECT_VERSION | typeof REJECT_FULL;

export interface HelloMessage {
  readonly type: 'hello';
  readonly protocolVersion: number;
  readonly constantsHash: number;
  /** The client's clock when it sent this. Echoed back so it can measure the round trip. */
  readonly clientTimeMs: number;
}

export interface InputMessage {
  readonly type: 'input';
  /** Tick of inputs[0]. inputs[i] is for tick − i. */
  readonly tick: number;
  readonly inputs: readonly Input[];
}

export type ClientMessage = HelloMessage | InputMessage;

export interface WelcomeMessage {
  readonly type: 'welcome';
  readonly playerId: number;
  /** The tick the ship state below belongs to. */
  readonly serverTick: number;
  readonly clientTimeMs: number;
  readonly ship: ShipState;
}

export interface RejectMessage {
  readonly type: 'reject';
  readonly reason: RejectReason;
}

export interface SnapshotMessage {
  readonly type: 'snapshot';
  readonly serverTick: number;
  /**
   * How early this client's inputs arrived, in ticks, at worst since the
   * previous snapshot. Negative means an input arrived after its tick had
   * been simulated. NaN means no input arrived in that time.
   */
  readonly inputLead: number;
  /** Ticks since the previous snapshot that were simulated without this client's input. */
  readonly missedInputs: number;
  readonly ship: ShipState;
}

export type ServerMessage = WelcomeMessage | RejectMessage | SnapshotMessage;

class Writer {
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number) {
    this.view = new DataView(new ArrayBuffer(size));
  }

  u8(value: number): void {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }
  i8(value: number): void {
    this.view.setInt8(this.offset, value);
    this.offset += 1;
  }
  u16(value: number): void {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }
  u32(value: number): void {
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }
  f32(value: number): void {
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
  }
  f64(value: number): void {
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }
  finish(): Uint8Array {
    return new Uint8Array(this.view.buffer, 0, this.offset);
  }
}

class Reader {
  private readonly view: DataView;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  // DataView throws a RangeError when a read runs past the end; decode
  // functions catch it and report the message as malformed.
  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }
  i8(): number {
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }
  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }
  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }
  f32(): number {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }
  f64(): number {
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }
  atEnd(): boolean {
    return this.offset === this.view.byteLength;
  }
}

// --- Ship state -------------------------------------------------------------

export const SHIP_STATE_BYTES = 8 * 8 + 2 + 1 + 2 + 1;

function writeShip(w: Writer, s: ShipState): void {
  w.f64(s.x);
  w.f64(s.y);
  w.f64(s.z);
  w.f64(s.yaw);
  w.f64(s.pitch);
  w.f64(s.roll);
  w.f64(s.speed);
  w.f64(s.targetSpeed);
  w.u16(s.boostTicks);
  w.u8(s.alive ? 1 : 0);
  w.u16(s.respawnTicks);
  w.u8(s.spawnSeq);
}

function readShip(r: Reader): ShipState {
  return {
    x: r.f64(),
    y: r.f64(),
    z: r.f64(),
    yaw: r.f64(),
    pitch: r.f64(),
    roll: r.f64(),
    speed: r.f64(),
    targetSpeed: r.f64(),
    boostTicks: r.u16(),
    alive: r.u8() === 1,
    respawnTicks: r.u16(),
    spawnSeq: r.u8(),
  };
}

/** The exact bytes of a ship state, for hashing and byte-for-byte comparison. */
export function encodeShipState(s: ShipState): Uint8Array {
  const w = new Writer(SHIP_STATE_BYTES);
  writeShip(w, s);
  return w.finish();
}

export function decodeShipState(data: Uint8Array): ShipState | null {
  try {
    const r = new Reader(data);
    const ship = readShip(r);
    return r.atEnd() ? ship : null;
  } catch {
    return null;
  }
}

// --- Client to server -------------------------------------------------------

export function encodeHello(message: Omit<HelloMessage, 'type'>): Uint8Array {
  const w = new Writer(1 + 2 + 4 + 8);
  w.u8(CLIENT_HELLO);
  w.u16(message.protocolVersion);
  w.u32(message.constantsHash);
  w.f64(message.clientTimeMs);
  return w.finish();
}

// Throttle −1, 0, +1 travels as 0, 1, 2.
export function encodeInput(tick: number, inputs: readonly Input[]): Uint8Array {
  const count = Math.min(inputs.length, INPUT_REDUNDANCY);
  const w = new Writer(1 + 4 + 1 + count * 3);
  w.u8(CLIENT_INPUT);
  w.u32(tick);
  w.u8(count);
  for (let i = 0; i < count; i++) {
    const input = inputs[i];
    if (!input) break;
    w.i8(input.yaw);
    w.i8(input.pitch);
    w.u8(input.throttle + 1);
  }
  return w.finish();
}

/** Returns null for anything that is not a well-formed client message. */
export function decodeClientMessage(data: Uint8Array): ClientMessage | null {
  if (data.byteLength === 0 || data.byteLength > MAX_CLIENT_MESSAGE_BYTES) return null;
  try {
    const r = new Reader(data);
    const type = r.u8();
    if (type === CLIENT_HELLO) {
      const protocolVersion = r.u16();
      const constantsHash = r.u32();
      const clientTimeMs = r.f64();
      if (!r.atEnd()) return null;
      return { type: 'hello', protocolVersion, constantsHash, clientTimeMs };
    }
    if (type === CLIENT_INPUT) {
      const tick = r.u32();
      const count = r.u8();
      if (count < 1 || count > INPUT_REDUNDANCY) return null;
      const inputs: Input[] = [];
      for (let i = 0; i < count; i++) {
        const input = inputFromWire(r.i8(), r.i8(), r.u8() - 1);
        if (!input) return null;
        inputs.push(input);
      }
      if (!r.atEnd()) return null;
      return { type: 'input', tick, inputs };
    }
    return null;
  } catch {
    return null;
  }
}

// --- Server to client -------------------------------------------------------

export function encodeWelcome(message: Omit<WelcomeMessage, 'type'>): Uint8Array {
  const w = new Writer(1 + 1 + 4 + 8 + SHIP_STATE_BYTES);
  w.u8(SERVER_WELCOME);
  w.u8(message.playerId);
  w.u32(message.serverTick);
  w.f64(message.clientTimeMs);
  writeShip(w, message.ship);
  return w.finish();
}

export function encodeReject(reason: RejectReason): Uint8Array {
  const w = new Writer(2);
  w.u8(SERVER_REJECT);
  w.u8(reason);
  return w.finish();
}

export function encodeSnapshot(message: Omit<SnapshotMessage, 'type'>): Uint8Array {
  const w = new Writer(1 + 4 + 4 + 1 + SHIP_STATE_BYTES);
  w.u8(SERVER_SNAPSHOT);
  w.u32(message.serverTick);
  w.f32(message.inputLead);
  w.u8(Math.min(255, message.missedInputs));
  writeShip(w, message.ship);
  return w.finish();
}

export function decodeServerMessage(data: Uint8Array): ServerMessage | null {
  try {
    const r = new Reader(data);
    const type = r.u8();
    if (type === SERVER_WELCOME) {
      const playerId = r.u8();
      const serverTick = r.u32();
      const clientTimeMs = r.f64();
      const ship = readShip(r);
      return r.atEnd() ? { type: 'welcome', playerId, serverTick, clientTimeMs, ship } : null;
    }
    if (type === SERVER_REJECT) {
      const reason = r.u8();
      if (!r.atEnd() || (reason !== REJECT_VERSION && reason !== REJECT_FULL)) return null;
      return { type: 'reject', reason };
    }
    if (type === SERVER_SNAPSHOT) {
      const serverTick = r.u32();
      const inputLead = r.f32();
      const missedInputs = r.u8();
      const ship = readShip(r);
      return r.atEnd() ? { type: 'snapshot', serverTick, inputLead, missedInputs, ship } : null;
    }
    return null;
  } catch {
    return null;
  }
}
