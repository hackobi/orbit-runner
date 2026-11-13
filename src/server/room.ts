// One authoritative room. It owns the only true copy of every ship, advances
// it in fixed ticks, and tells each client what happened.
//
// The room does not touch sockets or the system clock: it is handed
// transports and a time source, so the same class runs behind a WebSocket
// server and inside virtual-time tests.

import { TICK_MS } from '../shared/constants.ts';
import {
  PROTOCOL_VERSION,
  REJECT_FULL,
  REJECT_VERSION,
  decodeClientMessage,
  encodeReject,
  encodeSnapshot,
  encodeWelcome,
} from '../shared/protocol.ts';
import type { HelloMessage, InputMessage } from '../shared/protocol.ts';
import { Rng } from '../shared/rng.ts';
import { SIM_FINGERPRINT } from '../shared/sim/fingerprint.ts';
import { NEUTRAL_INPUT, spawnShip, stepShip } from '../shared/sim/ship.ts';
import type { Input, ShipState } from '../shared/sim/ship.ts';
import type { Transport } from '../shared/transport.ts';

export const MAX_PLAYERS = 16;

/** A snapshot goes out every second tick: 30 a second. */
export const SNAPSHOT_EVERY_TICKS = 2;

/** Inputs numbered further ahead than this are refused, which bounds the buffer. */
export const MAX_INPUT_LEAD_TICKS = 120;

/** After a stall the room simulates at most this many ticks in one go. */
const MAX_CATCH_UP_TICKS = 120;

/** A connection that has not said hello by now is closed. */
const HELLO_TIMEOUT_MS = 5000;

/** A connection is closed after this many malformed messages. */
const MAX_MALFORMED_MESSAGES = 20;

export interface RoomOptions {
  now: () => number;
  seed: number;
  maxPlayers?: number;
  /** Called after every simulated tick. Tests use it to record what really happened. */
  onTick?: (tick: number, room: Room) => void;
}

export interface RoomStats {
  /** Ticks thrown away because the process stalled for longer than the catch-up limit. */
  droppedTicks: number;
  malformedMessages: number;
  /** Inputs that arrived after their tick had been simulated. */
  lateInputs: number;
  /** Player-ticks simulated by reusing the previous input. */
  missedInputs: number;
  bytesSent: number;
}

interface Connection {
  readonly transport: Transport;
  readonly openedAtMs: number;
  malformed: number;
  player: Player | null;
  closed: boolean;
}

interface Player {
  readonly id: number;
  readonly connection: Connection;
  ship: ShipState;
  lastInput: Input;
  /** Inputs for ticks that have not been simulated yet. */
  readonly pending: Map<number, Input>;
  /** The tick of the first input this player sent. Null until one arrives. */
  firstInputTick: number | null;
  /** Worst input lead since the last snapshot, in ticks. NaN if none arrived. */
  worstLead: number;
  missedSinceSnapshot: number;
}

export class Room {
  tick = 0;
  readonly stats: RoomStats = {
    droppedTicks: 0,
    malformedMessages: 0,
    lateInputs: 0,
    missedInputs: 0,
    bytesSent: 0,
  };

  private readonly now: () => number;
  private readonly rng: Rng;
  private readonly maxPlayers: number;
  private readonly onTick: ((tick: number, room: Room) => void) | undefined;
  private readonly connections = new Set<Connection>();
  private readonly players = new Map<number, Player>();
  /** The moment the current tick was due. Null until the first advance. */
  private tickDueAtMs: number | null = null;

  constructor(options: RoomOptions) {
    this.now = options.now;
    this.rng = new Rng(options.seed);
    this.maxPlayers = options.maxPlayers ?? MAX_PLAYERS;
    this.onTick = options.onTick;
  }

  get playerCount(): number {
    return this.players.size;
  }

  /** The authoritative ship of a player, for tests and the health endpoint. */
  shipOf(playerId: number): ShipState | undefined {
    return this.players.get(playerId)?.ship;
  }

  playerIds(): number[] {
    return [...this.players.keys()];
  }

  /** Takes over a new connection. The first message must be a hello. */
  connect(transport: Transport): void {
    const connection: Connection = {
      transport,
      openedAtMs: this.now(),
      malformed: 0,
      player: null,
      closed: false,
    };
    this.connections.add(connection);
    transport.onMessage((data) => {
      this.receive(connection, data);
    });
    transport.onClose(() => {
      this.drop(connection);
    });
  }

  /**
   * Simulates every tick that is due. Call it often; it does nothing until a
   * tick boundary has passed. Real time decides how many ticks run, never the
   * caller's timer.
   */
  advance(): void {
    const now = this.now();
    this.tickDueAtMs ??= now;

    let steps = 0;
    let snapshotDue = false;
    while (now - this.tickDueAtMs >= TICK_MS) {
      if (steps === MAX_CATCH_UP_TICKS) {
        const dropped = Math.floor((now - this.tickDueAtMs) / TICK_MS);
        this.tickDueAtMs += dropped * TICK_MS;
        this.stats.droppedTicks += dropped;
        break;
      }
      this.tickDueAtMs += TICK_MS;
      this.step();
      steps++;
      if (this.tick % SNAPSHOT_EVERY_TICKS === 0) snapshotDue = true;
    }
    if (snapshotDue) this.sendSnapshots();

    for (const connection of this.connections) {
      if (!connection.player && now - connection.openedAtMs > HELLO_TIMEOUT_MS) {
        this.close(connection);
      }
    }
  }

  private step(): void {
    this.tick += 1;
    for (const player of this.players.values()) {
      let input = player.pending.get(this.tick);
      if (input) {
        player.pending.delete(this.tick);
        player.lastInput = input;
      } else {
        // No input for this tick: carry on with the last one. The ship never
        // freezes for other players, and withholding input gains nothing.
        input = player.lastInput;
        // Ticks before the player's first input are not misses: nothing was due.
        if (player.firstInputTick !== null && this.tick >= player.firstInputTick) {
          player.missedSinceSnapshot += 1;
          this.stats.missedInputs += 1;
        }
      }
      player.ship = stepShip(player.ship, input);
      if (!player.ship.alive && player.ship.respawnTicks === 0) {
        player.ship = spawnShip(this.rng, player.ship.spawnSeq + 1);
      }
    }
    this.onTick?.(this.tick, this);
  }

  private sendSnapshots(): void {
    for (const player of this.players.values()) {
      this.send(
        player.connection,
        encodeSnapshot({
          serverTick: this.tick,
          inputLead: player.worstLead,
          missedInputs: player.missedSinceSnapshot,
          ship: player.ship,
        }),
        'droppable',
      );
      player.worstLead = Number.NaN;
      player.missedSinceSnapshot = 0;
    }
  }

  private receive(connection: Connection, data: Uint8Array): void {
    if (connection.closed) return;
    const message = decodeClientMessage(data);
    if (!message) {
      this.malformed(connection);
      return;
    }
    if (message.type === 'hello') {
      if (connection.player) this.malformed(connection);
      else this.join(connection, message);
      return;
    }
    if (!connection.player) {
      this.malformed(connection);
      return;
    }
    this.acceptInputs(connection.player, message);
  }

  private join(connection: Connection, hello: HelloMessage): void {
    if (hello.protocolVersion !== PROTOCOL_VERSION || hello.simFingerprint !== SIM_FINGERPRINT) {
      this.send(connection, encodeReject(REJECT_VERSION), 'reliable');
      this.close(connection);
      return;
    }
    const id = this.freeId();
    if (id === null) {
      this.send(connection, encodeReject(REJECT_FULL), 'reliable');
      this.close(connection);
      return;
    }
    const player: Player = {
      id,
      connection,
      ship: spawnShip(this.rng, 0),
      lastInput: NEUTRAL_INPUT,
      pending: new Map(),
      firstInputTick: null,
      worstLead: Number.NaN,
      missedSinceSnapshot: 0,
    };
    connection.player = player;
    this.players.set(id, player);
    this.send(
      connection,
      encodeWelcome({
        playerId: id,
        serverTick: this.tick,
        clientTimeMs: hello.clientTimeMs,
        ship: player.ship,
      }),
      'reliable',
    );
  }

  private acceptInputs(player: Player, message: InputMessage): void {
    // How long before its tick is due the newest input arrived, in ticks.
    const sinceTickDue = this.tickDueAtMs === null ? 0 : this.now() - this.tickDueAtMs;
    const lead = message.tick - this.tick - sinceTickDue / TICK_MS;
    if (!(player.worstLead <= lead)) player.worstLead = lead;
    if (message.tick <= this.tick) this.stats.lateInputs += 1;
    player.firstInputTick ??= message.tick;

    for (let i = 0; i < message.inputs.length; i++) {
      const tick = message.tick - i;
      const input = message.inputs[i];
      if (!input || tick <= this.tick || tick > this.tick + MAX_INPUT_LEAD_TICKS) continue;
      // One input per tick. The first copy to arrive wins.
      if (!player.pending.has(tick)) player.pending.set(tick, input);
    }
  }

  private freeId(): number | null {
    for (let id = 0; id < this.maxPlayers; id++) {
      if (!this.players.has(id)) return id;
    }
    return null;
  }

  private malformed(connection: Connection): void {
    connection.malformed += 1;
    this.stats.malformedMessages += 1;
    if (connection.malformed >= MAX_MALFORMED_MESSAGES) this.close(connection);
  }

  private send(connection: Connection, data: Uint8Array, channel: 'reliable' | 'droppable'): void {
    if (connection.closed) return;
    this.stats.bytesSent += data.byteLength;
    connection.transport.send(data, channel);
  }

  private close(connection: Connection): void {
    if (connection.closed) return;
    connection.transport.close();
    this.drop(connection);
  }

  private drop(connection: Connection): void {
    connection.closed = true;
    this.connections.delete(connection);
    if (connection.player) this.players.delete(connection.player.id);
  }
}
