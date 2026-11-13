// Test-only window into the client. Compiled in only when the build sets
// VITE_TEST_HOOKS=1; a test fails if the production bundle contains it.
//
// Everything here is recorded from what the netcode handed to the renderer,
// never read back from pixels, so results do not depend on the GPU.

import { behaviourFrom } from '../net/behaviours.ts';
import type { Behaviour, BehaviourSpec } from '../net/behaviours.ts';
import type {
  ClientCore,
  CorrectionEvent,
  ShipView,
  SnapshotEvent,
  ViewHit,
} from '../net/client.ts';
import type { RemoteView } from '../net/remotes.ts';
import type { Session } from '../net/session.ts';
import type { GameEvent } from '../shared/protocol.ts';
import { SIM_FINGERPRINT, fusedMultiplyProbe, runTrace } from '../shared/sim/fingerprint.ts';
import type { Controls, ShipState } from '../shared/sim/ship.ts';

/** One other ship as drawn in one frame: id, x, y, z, the server tick drawn, flags. */
export interface RemoteFrame {
  id: number;
  x: number;
  y: number;
  z: number;
  /** The moment on the server's timeline this ship was drawn at, in ticks. */
  viewTick: number;
  full: boolean;
  alive: boolean;
  spawnSeq: number;
  extrapolatedTicks: number;
}

export interface FrameRecord {
  timeMs: number;
  /** Real time since the previous frame. */
  elapsedMs: number;
  /** The newest predicted tick and state. */
  tick: number;
  predicted: ShipState;
  /** The newest server tick received and the server's state at it. */
  ackTick: number;
  acked: ShipState | null;
  /** The pose handed to the renderer this frame. */
  drawn: ShipView;
  /** Every other ship handed to the renderer this frame. */
  remotes: RemoteFrame[];
  bullets: number;
}

export interface DebugStatus {
  status: string;
  playerId: number;
  tick: number;
  ackTick: number;
  kills: number;
  rttMs: number;
  leadTicks: number;
  leadLowTicks: number;
  viewDelayTicks: number;
  interpolationDelayTicks: number;
  reconnects: number;
  counters: ClientCore['counters'];
}

export interface DebugHook {
  readonly frames: FrameRecord[];
  readonly corrections: CorrectionEvent[];
  readonly snapshots: SnapshotEvent[];
  /** This player's bullets meeting a ship on this screen. */
  readonly viewHits: ViewHit[];
  /** Everything the server announced. */
  readonly events: GameEvent[];
  /** The simulation as this browser computes it, for comparison with Node. */
  readonly simFingerprint: number;
  runTrace: typeof runTrace;
  fusedMultiplyProbe: typeof fusedMultiplyProbe;
  status(): DebugStatus;
  /** Hands the controls to a scripted behaviour, or back to the keyboard with null. */
  setBehaviour(spec: BehaviourSpec | null): void;
  /** Forgets everything recorded so far, to start a measurement. */
  clear(): void;
}

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

export interface DebugRecorder {
  onCorrection: (event: CorrectionEvent) => void;
  onSnapshot: (event: SnapshotEvent) => void;
  onViewHit: (hit: ViewHit) => void;
  onGameEvent: (event: GameEvent) => void;
  /** The scripted controls for a tick, or null when the keyboard is in charge. */
  controls: (tick: number, core: ClientCore) => Controls | null;
  attach: (session: Session) => void;
  frame: (
    timeMs: number,
    elapsedMs: number,
    core: ClientCore,
    drawn: ShipView,
    remotes: readonly RemoteView[],
    bullets: number,
  ) => void;
}

export function createDebugRecorder(): DebugRecorder {
  const frames: FrameRecord[] = [];
  const corrections: CorrectionEvent[] = [];
  const snapshots: SnapshotEvent[] = [];
  const viewHits: ViewHit[] = [];
  const events: GameEvent[] = [];
  let behaviour: Behaviour | null = null;

  return {
    onCorrection: (event) => corrections.push(event),
    onSnapshot: (event) => snapshots.push(event),
    onViewHit: (hit) => viewHits.push(hit),
    onGameEvent: (event) => events.push(event),
    controls: (tick, core) => (behaviour ? behaviour(tick, core) : null),
    attach(session) {
      window.__orbit = {
        frames,
        corrections,
        snapshots,
        viewHits,
        events,
        simFingerprint: SIM_FINGERPRINT,
        runTrace,
        fusedMultiplyProbe,
        status: () => {
          const core = session.core;
          return {
            status: core.status,
            playerId: core.playerId,
            tick: core.tick,
            ackTick: core.ackTick,
            kills: core.kills,
            rttMs: core.rttMs,
            leadTicks: core.leadTicks,
            leadLowTicks: core.leadLowTicks,
            viewDelayTicks: core.viewDelayTicks,
            interpolationDelayTicks: core.remotes.delayTicks,
            reconnects: session.reconnects,
            counters: { ...core.counters },
          };
        },
        setBehaviour: (spec) => {
          behaviour = spec ? behaviourFrom(spec) : null;
        },
        clear: () => {
          frames.length = 0;
          corrections.length = 0;
          snapshots.length = 0;
          viewHits.length = 0;
          events.length = 0;
        },
      };
    },
    frame(timeMs, elapsedMs, core, drawn, remotes, bullets) {
      if (!core.state) return;
      frames.push({
        timeMs,
        elapsedMs,
        tick: core.tick,
        predicted: core.state,
        ackTick: core.ackTick,
        acked: core.ackState,
        drawn,
        remotes: remotes.map((remote) => ({
          id: remote.id,
          x: remote.x,
          y: remote.y,
          z: remote.z,
          viewTick: remote.viewTick,
          full: remote.full,
          alive: remote.alive,
          spawnSeq: remote.spawnSeq,
          extrapolatedTicks: remote.extrapolatedTicks,
        })),
        bullets,
      });
    },
  };
}
