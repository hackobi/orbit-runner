// Binary wire format, little-endian.
//
// Clients send three things only: a hello, their numbered inputs, and
// whether they are away. There is no message that carries a position, a hit
// or a score from client to server.
//
// The own ship travels as float64 so the client can compare its prediction
// with the server's state exactly. Other ships travel quantised (remote.ts).

import {
  ANGLE_SCALE,
  HEIGHT_SCALE,
  POSITION_SCALE,
  quantiseAngle,
  quantiseHeight,
  quantisePosition,
} from './remote.ts';
import type { RemoteSample } from './remote.ts';
import { inputFromWire } from './sim/ship.ts';
import type { Input, ShipState } from './sim/ship.ts';

export const PROTOCOL_VERSION = 4;

/** Inputs carried per message: the tick's own plus the ones before it. */
export const INPUT_REDUNDANCY = 3;

export const MAX_CLIENT_MESSAGE_BYTES = 64;

export const SESSION_TOKEN_BYTES = 16;

const CLIENT_HELLO = 1;
const CLIENT_INPUT = 2;
const CLIENT_PRESENCE = 3;

const SERVER_WELCOME = 1;
const SERVER_REJECT = 2;
const SERVER_SNAPSHOT = 3;
const SERVER_EVENTS = 4;

export const REJECT_VERSION = 1;
export const REJECT_FULL = 2;
export type RejectReason = typeof REJECT_VERSION | typeof REJECT_FULL;

/** No player: used for "killed by nobody". */
export const NO_PLAYER = 255;

export const CAUSE_PLANET = 1;
export const CAUSE_PLAYER = 2;
export const CAUSE_DISCONNECT = 3;
export const CAUSE_ASTEROID = 4;
/** Flew out of the combat zone and stayed out (decision D11). */
export const CAUSE_EDGE = 5;
export type DeathCause =
  | typeof CAUSE_PLANET
  | typeof CAUSE_PLAYER
  | typeof CAUSE_DISCONNECT
  | typeof CAUSE_ASTEROID
  | typeof CAUSE_EDGE;

// --- Message types ----------------------------------------------------------

export interface HelloMessage {
  readonly type: 'hello';
  readonly protocolVersion: number;
  /** SIM_FINGERPRINT as the client computed it. */
  readonly simFingerprint: number;
  /** The client's clock when it sent this. Echoed back so it can measure the round trip. */
  readonly clientTimeMs: number;
  /** The token from an earlier welcome, to take the same seat back. Null for a new player. */
  readonly sessionToken: Uint8Array | null;
}

export interface InputMessage {
  readonly type: 'input';
  /** Tick of inputs[0]. inputs[i] is for tick − i. */
  readonly tick: number;
  readonly inputs: readonly Input[];
}

export interface PresenceMessage {
  readonly type: 'presence';
  /** True when the player's tab was hidden; false when it is back and wants a fresh welcome. */
  readonly away: boolean;
  readonly clientTimeMs: number;
}

export type ClientMessage = HelloMessage | InputMessage | PresenceMessage;

export interface WelcomeMessage {
  readonly type: 'welcome';
  readonly playerId: number;
  /** The tick the ship state below belongs to. */
  readonly serverTick: number;
  readonly clientTimeMs: number;
  readonly sessionToken: Uint8Array;
  readonly ship: ShipState;
  /** What the client builds the belt and the orbs from. Neither is sent piece by piece. */
  readonly worldSeed: number;
  readonly asteroidCount: number;
  readonly withOrbs: boolean;
}

export interface RejectMessage {
  readonly type: 'reject';
  readonly reason: RejectReason;
}

export interface RemoteEntry {
  readonly id: number;
  readonly sample: RemoteSample;
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
  readonly kills: number;
  /** Every other ship this client is told about at this tick, near ones in full. */
  readonly remotes: readonly RemoteEntry[];
}

export interface BulletEvent {
  readonly kind: 'bullet';
  readonly ownerId: number;
  readonly spawnTick: number;
  /** The shooter's position and heading when it fired. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  /** A Fenix beam rather than a bullet. */
  readonly beam: boolean;
}

export interface HitEvent {
  readonly kind: 'hit';
  /** The bullet: its owner and the tick it was fired. */
  readonly ownerId: number;
  readonly spawnTick: number;
  readonly targetId: number;
  readonly tick: number;
  /** The target's hit points and shield afterwards. */
  readonly hp: number;
  readonly shield: number;
}

export interface DeathEvent {
  readonly kind: 'death';
  /** Unique within the room's lifetime, so a payout can never be made twice. */
  readonly deathId: number;
  readonly victimId: number;
  readonly killerId: number;
  readonly cause: DeathCause;
  readonly tick: number;
}

export interface LeftEvent {
  readonly kind: 'left';
  readonly playerId: number;
}

/**
 * A rock was destroyed. This is world state, so it goes to every player
 * wherever they are: a client that missed one would later predict a crash
 * into a rock that is not there.
 */
export interface AsteroidEvent {
  readonly kind: 'asteroid';
  readonly asteroidId: number;
  readonly tick: number;
  /** Who destroyed it. NO_PLAYER when the event only reports that it is gone. */
  readonly playerId: number;
  /** The tick the bullet that destroyed it was fired, or 0 if a ship crashed into it. */
  readonly spawnTick: number;
  readonly byBullet: boolean;
}

/**
 * An orb was taken. World state, sent to every player like a rock.
 *
 * When a ship flew through it, the effect on that ship happened on `tick`,
 * and the ship's own client predicted it. When a bullet took it, the effect
 * on the shooter happens SIM.shotEffectDelayTicks later, so that the news
 * reaches the shooter's client first and it can apply it on the same tick.
 */
export interface OrbEvent {
  readonly kind: 'orb';
  readonly orbId: number;
  readonly tick: number;
  /** Who took it. NO_PLAYER when the event only reports that it is gone. */
  readonly playerId: number;
  /** The tick the bullet that took it was fired, or 0 if a ship flew through it. */
  readonly spawnTick: number;
  readonly byBullet: boolean;
}

export type GameEvent = BulletEvent | HitEvent | DeathEvent | LeftEvent | AsteroidEvent | OrbEvent;

export interface EventsMessage {
  readonly type: 'events';
  readonly events: readonly GameEvent[];
}

export type ServerMessage = WelcomeMessage | RejectMessage | SnapshotMessage | EventsMessage;

// --- Byte reading and writing -----------------------------------------------

class Writer {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(size: number) {
    const buffer = new ArrayBuffer(size);
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
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
  i16(value: number): void {
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
  }
  u32(value: number): void {
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }
  i32(value: number): void {
    this.view.setInt32(this.offset, value, true);
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
  raw(data: Uint8Array): void {
    this.bytes.set(data, this.offset);
    this.offset += data.byteLength;
  }
  finish(): Uint8Array {
    return this.bytes.subarray(0, this.offset);
  }
}

class Reader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
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
  i16(): number {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }
  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }
  i32(): number {
    const value = this.view.getInt32(this.offset, true);
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
  raw(length: number): Uint8Array {
    if (this.offset + length > this.bytes.byteLength) throw new RangeError('read past end');
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  atEnd(): boolean {
    return this.offset === this.view.byteLength;
  }
}

// --- Own ship, full precision -----------------------------------------------

export const SHIP_STATE_BYTES = 8 * 8 + 2 + 1 + 2 + 1 + 1 + 1 + 1 + 1 + 1 + 1;

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
  w.u8(s.hp);
  w.u8(s.shield);
  w.u8(s.invulnTicks);
  w.u8(s.fireCooldown);
  w.u8(s.crashTicks);
  w.u8(s.fenix ? 1 : 0);
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
    hp: r.u8(),
    shield: r.u8(),
    invulnTicks: r.u8(),
    fireCooldown: r.u8(),
    crashTicks: r.u8(),
    fenix: r.u8() === 1,
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

// --- Other ships, quantised -------------------------------------------------

const FLAG_ALIVE = 1;
const FLAG_BOOSTING = 2;
const FLAG_INVULNERABLE = 4;
const FLAG_FULL = 8;
const FLAG_FENIX = 16;

/** A nearby ship: 1 id + 1 flags + 10 position + 6 angles + 1 hp + 1 shield + 1 spawn. */
export const NEAR_ENTRY_BYTES = 21;
/** A distant ship: 1 id + 1 flags + 10 position + 1 spawn. */
export const FAR_ENTRY_BYTES = 13;

function writeRemote(w: Writer, entry: RemoteEntry): void {
  const s = entry.sample;
  w.u8(entry.id);
  w.u8(
    (s.alive ? FLAG_ALIVE : 0) |
      (s.boosting ? FLAG_BOOSTING : 0) |
      (s.invulnerable ? FLAG_INVULNERABLE : 0) |
      (s.full ? FLAG_FULL : 0) |
      (s.fenix ? FLAG_FENIX : 0),
  );
  w.i32(quantisePosition(s.x));
  w.i16(quantiseHeight(s.y));
  w.i32(quantisePosition(s.z));
  w.u8(s.spawnSeq);
  if (!s.full) return;
  w.i16(quantiseAngle(s.yaw));
  w.i16(quantiseAngle(s.pitch));
  w.i16(quantiseAngle(s.roll));
  w.u8(s.hp);
  w.u8(s.shield);
}

function readRemote(r: Reader, tick: number): RemoteEntry {
  const id = r.u8();
  const flags = r.u8();
  const x = r.i32() / POSITION_SCALE;
  const y = r.i16() / HEIGHT_SCALE;
  const z = r.i32() / POSITION_SCALE;
  const spawnSeq = r.u8();
  const full = (flags & FLAG_FULL) !== 0;
  return {
    id,
    sample: {
      tick,
      x,
      y,
      z,
      yaw: full ? r.i16() / ANGLE_SCALE : 0,
      pitch: full ? r.i16() / ANGLE_SCALE : 0,
      roll: full ? r.i16() / ANGLE_SCALE : 0,
      hp: full ? r.u8() : 0,
      shield: full ? r.u8() : 0,
      spawnSeq,
      alive: (flags & FLAG_ALIVE) !== 0,
      boosting: (flags & FLAG_BOOSTING) !== 0,
      invulnerable: (flags & FLAG_INVULNERABLE) !== 0,
      fenix: (flags & FLAG_FENIX) !== 0,
      full,
    },
  };
}

// --- Client to server -------------------------------------------------------

const NO_TOKEN = new Uint8Array(SESSION_TOKEN_BYTES);

export function encodeHello(message: Omit<HelloMessage, 'type'>): Uint8Array {
  const w = new Writer(1 + 2 + 4 + 8 + SESSION_TOKEN_BYTES);
  w.u8(CLIENT_HELLO);
  w.u16(message.protocolVersion);
  w.u32(message.simFingerprint);
  w.f64(message.clientTimeMs);
  w.raw(message.sessionToken?.byteLength === SESSION_TOKEN_BYTES ? message.sessionToken : NO_TOKEN);
  return w.finish();
}

const BUTTON_FIRE = 4;

// One byte of buttons: throttle −1, 0, +1 as 0, 1, 2 in the low bits, then fire.
export function encodeInput(tick: number, inputs: readonly Input[]): Uint8Array {
  const count = Math.min(inputs.length, INPUT_REDUNDANCY);
  const w = new Writer(1 + 4 + 1 + count * 5);
  w.u8(CLIENT_INPUT);
  w.u32(tick);
  w.u8(count);
  for (let i = 0; i < count; i++) {
    const input = inputs[i];
    if (!input) break;
    w.i8(input.yaw);
    w.i8(input.pitch);
    w.u8((input.throttle + 1) | (input.fire ? BUTTON_FIRE : 0));
    w.u16(input.viewDelay);
  }
  return w.finish();
}

export function encodePresence(away: boolean, clientTimeMs: number): Uint8Array {
  const w = new Writer(1 + 1 + 8);
  w.u8(CLIENT_PRESENCE);
  w.u8(away ? 1 : 0);
  w.f64(clientTimeMs);
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
      const simFingerprint = r.u32();
      const clientTimeMs = r.f64();
      const token = r.raw(SESSION_TOKEN_BYTES);
      if (!r.atEnd()) return null;
      const sessionToken = token.some((byte) => byte !== 0) ? token : null;
      return { type: 'hello', protocolVersion, simFingerprint, clientTimeMs, sessionToken };
    }
    if (type === CLIENT_INPUT) {
      const tick = r.u32();
      const count = r.u8();
      if (count < 1 || count > INPUT_REDUNDANCY) return null;
      const inputs: Input[] = [];
      for (let i = 0; i < count; i++) {
        const yaw = r.i8();
        const pitch = r.i8();
        const buttons = r.u8();
        if (buttons > (BUTTON_FIRE | 3)) return null;
        const input = inputFromWire(
          yaw,
          pitch,
          (buttons & 3) - 1,
          (buttons & BUTTON_FIRE) !== 0,
          r.u16(),
        );
        if (!input) return null;
        inputs.push(input);
      }
      if (!r.atEnd()) return null;
      return { type: 'input', tick, inputs };
    }
    if (type === CLIENT_PRESENCE) {
      const away = r.u8();
      const clientTimeMs = r.f64();
      if (!r.atEnd() || away > 1) return null;
      return { type: 'presence', away: away === 1, clientTimeMs };
    }
    return null;
  } catch {
    return null;
  }
}

// --- Server to client -------------------------------------------------------

export function encodeWelcome(message: Omit<WelcomeMessage, 'type'>): Uint8Array {
  const w = new Writer(1 + 1 + 4 + 8 + SESSION_TOKEN_BYTES + SHIP_STATE_BYTES + 4 + 2 + 1);
  w.u8(SERVER_WELCOME);
  w.u8(message.playerId);
  w.u32(message.serverTick);
  w.f64(message.clientTimeMs);
  w.raw(message.sessionToken);
  writeShip(w, message.ship);
  w.u32(message.worldSeed);
  w.u16(message.asteroidCount);
  w.u8(message.withOrbs ? 1 : 0);
  return w.finish();
}

export function encodeReject(reason: RejectReason): Uint8Array {
  const w = new Writer(2);
  w.u8(SERVER_REJECT);
  w.u8(reason);
  return w.finish();
}

/** Everything in a snapshot before the list of other ships. */
export const SNAPSHOT_HEADER_BYTES = 1 + 4 + 4 + 1 + SHIP_STATE_BYTES + 2 + 1;

export function encodeSnapshot(message: Omit<SnapshotMessage, 'type'>): Uint8Array {
  const w = new Writer(SNAPSHOT_HEADER_BYTES + message.remotes.length * NEAR_ENTRY_BYTES);
  w.u8(SERVER_SNAPSHOT);
  w.u32(message.serverTick);
  w.f32(message.inputLead);
  w.u8(Math.min(255, message.missedInputs));
  writeShip(w, message.ship);
  w.u16(Math.min(65535, message.kills));
  w.u8(message.remotes.length);
  for (const entry of message.remotes) writeRemote(w, entry);
  return w.finish();
}

const EVENT_BULLET = 1;
const EVENT_HIT = 2;
const EVENT_DEATH = 3;
const EVENT_LEFT = 4;
const EVENT_ASTEROID = 5;
const EVENT_ORB = 6;

const MAX_EVENT_BYTES = 27;

export function encodeEvents(events: readonly GameEvent[]): Uint8Array {
  const count = Math.min(events.length, 255);
  const w = new Writer(2 + count * MAX_EVENT_BYTES);
  w.u8(SERVER_EVENTS);
  w.u8(count);
  for (let i = 0; i < count; i++) {
    const event = events[i];
    if (!event) break;
    switch (event.kind) {
      case 'bullet':
        w.u8(EVENT_BULLET);
        w.u8(event.ownerId);
        w.u32(event.spawnTick);
        w.f32(event.x);
        w.f32(event.y);
        w.f32(event.z);
        w.f32(event.yaw);
        w.f32(event.pitch);
        w.u8(event.beam ? 1 : 0);
        break;
      case 'hit':
        w.u8(EVENT_HIT);
        w.u8(event.ownerId);
        w.u32(event.spawnTick);
        w.u8(event.targetId);
        w.u32(event.tick);
        w.u8(event.hp);
        w.u8(event.shield);
        break;
      case 'death':
        w.u8(EVENT_DEATH);
        w.u32(event.deathId);
        w.u8(event.victimId);
        w.u8(event.killerId);
        w.u8(event.cause);
        w.u32(event.tick);
        break;
      case 'left':
        w.u8(EVENT_LEFT);
        w.u8(event.playerId);
        break;
      case 'asteroid':
        w.u8(EVENT_ASTEROID);
        w.u16(event.asteroidId);
        w.u32(event.tick);
        w.u8(event.playerId);
        w.u32(event.spawnTick);
        w.u8(event.byBullet ? 1 : 0);
        break;
      case 'orb':
        w.u8(EVENT_ORB);
        w.u16(event.orbId);
        w.u32(event.tick);
        w.u8(event.playerId);
        w.u32(event.spawnTick);
        w.u8(event.byBullet ? 1 : 0);
        break;
    }
  }
  return w.finish();
}

function readEvent(r: Reader): GameEvent | null {
  const kind = r.u8();
  if (kind === EVENT_BULLET) {
    return {
      kind: 'bullet',
      ownerId: r.u8(),
      spawnTick: r.u32(),
      x: r.f32(),
      y: r.f32(),
      z: r.f32(),
      yaw: r.f32(),
      pitch: r.f32(),
      beam: r.u8() === 1,
    };
  }
  if (kind === EVENT_HIT) {
    return {
      kind: 'hit',
      ownerId: r.u8(),
      spawnTick: r.u32(),
      targetId: r.u8(),
      tick: r.u32(),
      hp: r.u8(),
      shield: r.u8(),
    };
  }
  if (kind === EVENT_DEATH) {
    const deathId = r.u32();
    const victimId = r.u8();
    const killerId = r.u8();
    const cause = r.u8();
    const tick = r.u32();
    if (
      cause !== CAUSE_PLANET &&
      cause !== CAUSE_PLAYER &&
      cause !== CAUSE_DISCONNECT &&
      cause !== CAUSE_ASTEROID &&
      cause !== CAUSE_EDGE
    ) {
      return null;
    }
    return { kind: 'death', deathId, victimId, killerId, cause, tick };
  }
  if (kind === EVENT_LEFT) return { kind: 'left', playerId: r.u8() };
  if (kind === EVENT_ASTEROID) {
    return {
      kind: 'asteroid',
      asteroidId: r.u16(),
      tick: r.u32(),
      playerId: r.u8(),
      spawnTick: r.u32(),
      byBullet: r.u8() === 1,
    };
  }
  if (kind === EVENT_ORB) {
    return {
      kind: 'orb',
      orbId: r.u16(),
      tick: r.u32(),
      playerId: r.u8(),
      spawnTick: r.u32(),
      byBullet: r.u8() === 1,
    };
  }
  return null;
}

export function decodeServerMessage(data: Uint8Array): ServerMessage | null {
  try {
    const r = new Reader(data);
    const type = r.u8();
    if (type === SERVER_WELCOME) {
      const playerId = r.u8();
      const serverTick = r.u32();
      const clientTimeMs = r.f64();
      const sessionToken = r.raw(SESSION_TOKEN_BYTES);
      const ship = readShip(r);
      const worldSeed = r.u32();
      const asteroidCount = r.u16();
      const withOrbs = r.u8() === 1;
      if (!r.atEnd()) return null;
      return {
        type: 'welcome',
        playerId,
        serverTick,
        clientTimeMs,
        sessionToken,
        ship,
        worldSeed,
        asteroidCount,
        withOrbs,
      };
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
      const kills = r.u16();
      const count = r.u8();
      const remotes: RemoteEntry[] = [];
      for (let i = 0; i < count; i++) remotes.push(readRemote(r, serverTick));
      if (!r.atEnd()) return null;
      return { type: 'snapshot', serverTick, inputLead, missedInputs, ship, kills, remotes };
    }
    if (type === SERVER_EVENTS) {
      const count = r.u8();
      const events: GameEvent[] = [];
      for (let i = 0; i < count; i++) {
        const event = readEvent(r);
        if (!event) return null;
        events.push(event);
      }
      return r.atEnd() ? { type: 'events', events } : null;
    }
    return null;
  } catch {
    return null;
  }
}
