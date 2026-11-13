// Test-only window into the client. Compiled in only when the build sets
// VITE_TEST_HOOKS=1; a test fails if the production bundle contains it.
//
// Everything here is recorded from what the netcode handed to the renderer,
// never read back from pixels, so results do not depend on the GPU.

import type { ClientCore, CorrectionEvent, ShipView, SnapshotEvent } from '../net/client.ts';
import { SIM_FINGERPRINT, fusedMultiplyProbe, runTrace } from '../shared/sim/fingerprint.ts';
import type { ShipState } from '../shared/sim/ship.ts';

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
}

export interface DebugHook {
  readonly frames: FrameRecord[];
  readonly corrections: CorrectionEvent[];
  readonly snapshots: SnapshotEvent[];
  /** The simulation as this browser computes it, for comparison with Node. */
  readonly simFingerprint: number;
  runTrace: typeof runTrace;
  fusedMultiplyProbe: typeof fusedMultiplyProbe;
  status(): {
    status: string;
    playerId: number;
    tick: number;
    ackTick: number;
    rttMs: number;
    leadTicks: number;
    targetLeadTicks: number;
    counters: ClientCore['counters'];
  };
}

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

export interface DebugRecorder {
  onCorrection: (event: CorrectionEvent) => void;
  onSnapshot: (event: SnapshotEvent) => void;
  attach: (core: ClientCore) => void;
  frame: (timeMs: number, elapsedMs: number, drawn: ShipView) => void;
}

export function createDebugRecorder(): DebugRecorder {
  const frames: FrameRecord[] = [];
  const corrections: CorrectionEvent[] = [];
  const snapshots: SnapshotEvent[] = [];
  let core: ClientCore | null = null;

  return {
    onCorrection: (event) => corrections.push(event),
    onSnapshot: (event) => snapshots.push(event),
    attach(client) {
      core = client;
      window.__orbit = {
        frames,
        corrections,
        snapshots,
        simFingerprint: SIM_FINGERPRINT,
        runTrace,
        fusedMultiplyProbe,
        status: () => ({
          status: client.status,
          playerId: client.playerId,
          tick: client.tick,
          ackTick: client.ackTick,
          rttMs: client.rttMs,
          leadTicks: client.leadTicks,
          targetLeadTicks: client.targetLeadTicks,
          counters: { ...client.counters },
        }),
      };
    },
    frame(timeMs, elapsedMs, drawn) {
      if (!core?.state) return;
      frames.push({
        timeMs,
        elapsedMs,
        tick: core.tick,
        predicted: core.state,
        ackTick: core.ackTick,
        acked: core.ackState,
        drawn,
      });
    },
  };
}
