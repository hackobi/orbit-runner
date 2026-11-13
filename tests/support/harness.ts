// Runs the real room and real client cores against each other in one
// process, on the virtual clock, over in-memory links.

import { TICK_MS } from '../../src/shared/constants.ts';
import type { GameEvent } from '../../src/shared/protocol.ts';
import { Rng } from '../../src/shared/rng.ts';
import { NEUTRAL_CONTROLS } from '../../src/shared/sim/ship.ts';
import type { Controls, ShipState } from '../../src/shared/sim/ship.ts';
import type { Transport } from '../../src/shared/transport.ts';
import { ClientCore } from '../../src/net/client.ts';
import type {
  ClientTuning,
  CorrectionEvent,
  SnapshotEvent,
  ViewHit,
} from '../../src/net/client.ts';
import { Session } from '../../src/net/session.ts';
import { Room } from '../../src/server/room.ts';
import type { DeathRecord, HitRecord } from '../../src/server/room.ts';
import { createLink } from './loopback.ts';
import type { LinkOptions, Shaper } from './loopback.ts';
import { VirtualClock } from './virtualClock.ts';

/** What a test can see of one client. */
export interface ClientLog {
  corrections: CorrectionEvent[];
  snapshots: SnapshotEvent[];
  /** This client's bullets meeting a ship on its own screen. */
  viewHits: ViewHit[];
  events: GameEvent[];
}

export interface TestClient extends ClientLog {
  core: ClientCore;
  /** The client's end of the link, for cutting the connection. */
  transport: Transport;
  /** Stops this client's frames, as a frozen tab would. */
  pause(): void;
  resume(): void;
}

export interface TestSession extends ClientLog {
  session: Session;
  /** Every link the session has opened, newest last. */
  links: Transport[];
}

export interface ClientSetup {
  /** `core` is the client itself, for behaviours that look at what it sees. */
  controls?: (tick: number, core: ClientCore) => Controls;
  link?: LinkOptions;
  /** Milliseconds between frames. Default is 60 a second. */
  frameMs?: number;
  /** Runs the client's clock fast or slow against the server's. 1 is exact. */
  clockRate?: number;
  tuning?: Partial<ClientTuning>;
  /** Called after each of this client's frames, where a renderer would draw. */
  onFrame?: (core: ClientCore) => void;
}

export class TestWorld {
  readonly clock = new VirtualClock();
  readonly room: Room;
  /** What the server really simulated: player id → tick → ship. */
  readonly truth = new Map<number, Map<number, ShipState>>();
  /** Every hit and death the server decided. */
  readonly hits: HitRecord[] = [];
  readonly deaths: DeathRecord[] = [];
  readonly left: number[] = [];

  constructor(seed = 1) {
    // Tokens only need to be distinct here, so a seeded generator will do.
    const tokens = new Rng(seed ^ 0x5eed);
    this.room = new Room({
      now: this.clock.now,
      seed,
      createToken: () => Uint8Array.from({ length: 16 }, () => Math.floor(tokens.next() * 256)),
      listener: {
        hit: (hit) => this.hits.push(hit),
        playerDied: (death) => this.deaths.push(death),
        playerLeft: (id) => this.left.push(id),
      },
      onTick: (tick, room) => {
        for (const id of room.playerIds()) {
          const ship = room.shipOf(id);
          if (!ship) continue;
          let history = this.truth.get(id);
          if (!history) {
            history = new Map<number, ShipState>();
            this.truth.set(id, history);
          }
          history.set(tick, ship);
        }
      },
    });
    // The real server polls a timer about once a millisecond.
    this.clock.every(1, () => {
      this.room.advance();
    });
  }

  addClient(setup: ClientSetup = {}): TestClient {
    const link = createLink(this.clock, setup.link);
    this.room.connect(link.server);

    const log: ClientLog = { corrections: [], snapshots: [], viewHits: [], events: [] };
    const clockRate = setup.clockRate ?? 1;
    const startedAtMs = this.clock.now();
    const controls = setup.controls;
    const core: ClientCore = new ClientCore({
      transport: link.client,
      now: () => startedAtMs + (this.clock.now() - startedAtMs) * clockRate,
      controls: controls ? (tick) => controls(tick, core) : () => NEUTRAL_CONTROLS,
      ...(setup.tuning ? { tuning: setup.tuning } : {}),
      onCorrection: (event) => log.corrections.push(event),
      onSnapshot: (event) => log.snapshots.push(event),
      onViewHit: (hit) => log.viewHits.push(hit),
      onGameEvent: (event) => log.events.push(event),
    });

    let paused = false;
    // Frames are not aligned with the server's ticks.
    this.clock.every(
      setup.frameMs ?? TICK_MS,
      () => {
        if (paused) return;
        core.update();
        setup.onFrame?.(core);
      },
      this.clock.now() + 3.7,
    );
    return {
      core,
      transport: link.client,
      ...log,
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
      },
    };
  }

  /** A client that reconnects by itself, as the browser client does. */
  addSession(setup: ClientSetup = {}): TestSession {
    const log: ClientLog = { corrections: [], snapshots: [], viewHits: [], events: [] };
    const links: Transport[] = [];
    const controls = setup.controls;
    const session: Session = new Session({
      connect: () => {
        const link = createLink(this.clock, setup.link);
        this.room.connect(link.server);
        links.push(link.client);
        return link.client;
      },
      now: this.clock.now,
      controls: controls ? (tick) => controls(tick, session.core) : () => NEUTRAL_CONTROLS,
      onCorrection: (event) => log.corrections.push(event),
      onSnapshot: (event) => log.snapshots.push(event),
      onViewHit: (hit) => log.viewHits.push(hit),
      onGameEvent: (event) => log.events.push(event),
    });
    this.clock.every(
      setup.frameMs ?? TICK_MS,
      () => {
        session.update();
        setup.onFrame?.(session.core);
      },
      this.clock.now() + 3.7,
    );
    return { session, links, ...log };
  }

  /** Moves a ship on the server, as the test-only endpoint does. */
  place(playerId: number, ship: Partial<ShipState>): void {
    this.room.placeShip(playerId, (current) => ({ ...current, ...ship }));
  }

  run(durationMs: number): void {
    this.clock.runUntil(this.clock.now() + durationMs);
  }

  /** The server's ship at a moment between ticks, on a straight line between the two. */
  truthAt(playerId: number, tick: number): ShipState | null {
    const history = this.truth.get(playerId);
    const a = history?.get(Math.floor(tick));
    const b = history?.get(Math.ceil(tick));
    if (!a || !b) return null;
    const t = tick - Math.floor(tick);
    return { ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  }
}

/** Fixed delay plus uniform jitter, in milliseconds, from a seeded generator. */
export function delay(meanMs: number, jitterMs: number, seed: number): Shaper {
  const rng = new Rng(seed);
  return () => meanMs + (rng.next() * 2 - 1) * jitterMs;
}

/** The brief's network profiles, as one-way mean and jitter in milliseconds. */
export const PROFILES = {
  clean: { oneWayMs: 0, jitterMs: 0 },
  '100ms': { oneWayMs: 50, jitterMs: 10 },
  '200ms': { oneWayMs: 100, jitterMs: 25 },
} as const;

export function profileLink(profile: keyof typeof PROFILES, seed: number): LinkOptions {
  const { oneWayMs, jitterMs } = PROFILES[profile];
  if (oneWayMs === 0) return {};
  return { up: delay(oneWayMs, jitterMs, seed), down: delay(oneWayMs, jitterMs, seed + 1) };
}
