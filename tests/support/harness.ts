// Runs the real room and real client cores against each other in one
// process, on the virtual clock, over in-memory links.

import { TICK_MS } from '../../src/shared/constants.ts';
import { Rng } from '../../src/shared/rng.ts';
import { NEUTRAL_CONTROLS } from '../../src/shared/sim/ship.ts';
import type { Controls, ShipState } from '../../src/shared/sim/ship.ts';
import { ClientCore } from '../../src/net/client.ts';
import type { ClientTuning, CorrectionEvent, SnapshotEvent } from '../../src/net/client.ts';
import { Room } from '../../src/server/room.ts';
import { createLink } from './loopback.ts';
import type { LinkOptions, Shaper } from './loopback.ts';
import { VirtualClock } from './virtualClock.ts';

export interface TestClient {
  core: ClientCore;
  corrections: CorrectionEvent[];
  snapshots: SnapshotEvent[];
  /** Stops this client's frames, as a frozen tab would. */
  pause(): void;
  resume(): void;
}

export interface ClientSetup {
  controls?: (tick: number) => Controls;
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

  constructor(seed = 1) {
    // Tokens only need to be distinct here, so a seeded generator will do.
    const tokens = new Rng(seed ^ 0x5eed);
    this.room = new Room({
      now: this.clock.now,
      seed,
      createToken: () => Uint8Array.from({ length: 16 }, () => Math.floor(tokens.next() * 256)),
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

    const corrections: CorrectionEvent[] = [];
    const snapshots: SnapshotEvent[] = [];
    const clockRate = setup.clockRate ?? 1;
    const startedAtMs = this.clock.now();
    const core = new ClientCore({
      transport: link.client,
      now: () => startedAtMs + (this.clock.now() - startedAtMs) * clockRate,
      controls: setup.controls ?? (() => NEUTRAL_CONTROLS),
      ...(setup.tuning ? { tuning: setup.tuning } : {}),
      onCorrection: (event) => corrections.push(event),
      onSnapshot: (event) => snapshots.push(event),
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
      corrections,
      snapshots,
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
      },
    };
  }

  run(durationMs: number): void {
    this.clock.runUntil(this.clock.now() + durationMs);
  }
}

/** Fixed delay plus uniform jitter, in milliseconds, from a seeded generator. */
export function delay(meanMs: number, jitterMs: number, seed: number): Shaper {
  const rng = new Rng(seed);
  return () => meanMs + (rng.next() * 2 - 1) * jitterMs;
}

/**
 * A player-like script: every so often pick new stick positions and hold
 * them. The same seed gives the same script, keyed by tick.
 */
export function wanderingControls(seed: number): (tick: number) => Controls {
  const rng = new Rng(seed);
  let current: Controls = NEUTRAL_CONTROLS;
  let holdUntil = 0;
  let lastTick = -1;
  return (tick) => {
    if (tick !== lastTick && tick >= holdUntil) {
      current = {
        yaw: rng.next() * 2 - 1,
        // Pitch is kept gentle so a minute of flying stays inside the belt.
        pitch: (rng.next() * 2 - 1) * 0.3,
        throttle: Math.floor(rng.next() * 3) - 1,
        fire: false,
      };
      holdUntil = tick + 5 + Math.floor(rng.next() * 40);
    }
    lastTick = tick;
    return current;
  };
}
