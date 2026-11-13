// Other players' ships on the client: a buffer of snapshot samples per ship,
// and one clock that says which moment of the past to draw them at.
//
// Remote ships are drawn a little behind the newest data, so that there are
// normally two samples to draw between. How far behind adapts to how
// irregularly snapshots arrive.

import { SIM, TICK_MS, TICK_RATE } from '../shared/constants.ts';
import { sampleTrack } from '../shared/remote.ts';
import type { RemoteSample, TrackPose } from '../shared/remote.ts';

export interface RemoteTuning {
  /** Ticks between snapshots. */
  snapshotIntervalTicks: number;
  /** The delay never goes below this: two snapshot intervals. */
  minDelayTicks: number;
  /** Nor above this (250 ms), however irregular the arrivals. */
  maxDelayTicks: number;
  /** Margin on top of the measured arrival jitter. */
  marginTicks: number;
  /** How many arrivals "recent" covers. 150 is five seconds. */
  arrivalWindow: number;
  /** The remote clock runs at most this fraction fast or slow to stay on target. */
  maxRateAdjust: number;
  rateGain: number;
  /** If the clock is further than this from its target it jumps there. */
  snapTicks: number;
  /** With no newer sample, a ship is carried on along its last movement for this long (150 ms). */
  maxExtrapolationTicks: number;
  /** Half-life of the visual offset left when late data moves a ship. */
  offsetHalfLifeMs: number;
  /** A late-data jump bigger than this is shown at once. */
  snapDistance: number;
  /** Samples kept per ship. */
  trackLength: number;
}

export const DEFAULT_REMOTE_TUNING: RemoteTuning = {
  snapshotIntervalTicks: 2,
  minDelayTicks: 4,
  maxDelayTicks: 15,
  marginTicks: 1,
  arrivalWindow: 150,
  maxRateAdjust: 0.05,
  rateGain: 1 / 30,
  snapTicks: 30,
  maxExtrapolationTicks: 9,
  offsetHalfLifeMs: 50,
  snapDistance: 100,
  trackLength: 48,
};

/** The fastest a remote ship's leftover offset is allowed to close, in units per second. */
const OFFSET_CLOSE_SPEED = SIM.maxSpeed;

interface Remote {
  readonly track: RemoteSample[];
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

/** A remote ship as it should be drawn this frame. */
export interface RemoteView extends TrackPose {
  id: number;
  /** The moment on the server's timeline this pose belongs to, in ticks. */
  viewTick: number;
}

export class RemoteShips {
  /** The server tick being drawn right now. Fractional. NaN until the first snapshot. */
  viewTick = Number.NaN;
  /** How far behind the newest possible data remote ships are drawn, in ticks. */
  delayTicks: number;
  rate = 1;

  private readonly tuning: RemoteTuning;
  private readonly remotes = new Map<number, Remote>();
  /** For each recent snapshot: arrival time minus the time its tick stands for. */
  private readonly arrivalOffsets: number[] = [];
  private fastestOffsetMs = 0;
  private lastAdvanceMs = 0;

  constructor(tuning: Partial<RemoteTuning> = {}) {
    this.tuning = { ...DEFAULT_REMOTE_TUNING, ...tuning };
    this.delayTicks = this.tuning.minDelayTicks;
  }

  get count(): number {
    return this.remotes.size;
  }

  ids(): number[] {
    return [...this.remotes.keys()];
  }

  /** Notes when a snapshot arrived. Call once per snapshot, before `add`. */
  arrived(serverTick: number, arrivedAtMs: number): void {
    const tuning = this.tuning;
    this.arrivalOffsets.push(arrivedAtMs - serverTick * TICK_MS);
    if (this.arrivalOffsets.length > tuning.arrivalWindow) this.arrivalOffsets.shift();

    // The fastest recent arrival approximates the path with no extra delay;
    // how much later the slowest one came is the jitter to cover.
    let fastest = Infinity;
    let slowest = -Infinity;
    for (const offset of this.arrivalOffsets) {
      if (offset < fastest) fastest = offset;
      if (offset > slowest) slowest = offset;
    }
    this.fastestOffsetMs = fastest;
    const jitterTicks = (slowest - fastest) / TICK_MS;
    this.delayTicks = Math.min(
      tuning.maxDelayTicks,
      Math.max(
        tuning.minDelayTicks,
        tuning.snapshotIntervalTicks + jitterTicks + tuning.marginTicks,
      ),
    );

    if (Number.isNaN(this.viewTick)) {
      this.viewTick = this.targetTick(arrivedAtMs);
      this.lastAdvanceMs = arrivedAtMs;
    }
  }

  /** Stores one ship's sample from a snapshot. Samples must arrive in tick order. */
  add(id: number, sample: RemoteSample): void {
    let remote = this.remotes.get(id);
    if (!remote) {
      remote = { track: [], offsetX: 0, offsetY: 0, offsetZ: 0 };
      this.remotes.set(id, remote);
    }
    const track = remote.track;
    const newest = track[track.length - 1];
    if (newest && sample.tick <= newest.tick) return;

    // If the ship was being drawn past its newest sample, this sample moves
    // it. Keep drawing it where it was and let the difference fade.
    const before =
      newest && this.viewTick > newest.tick
        ? sampleTrack(track, this.viewTick, this.tuning.maxExtrapolationTicks)
        : null;
    track.push(sample);
    if (track.length > this.tuning.trackLength) track.shift();
    if (!before) return;

    const after = sampleTrack(track, this.viewTick, this.tuning.maxExtrapolationTicks);
    if (!after || after.spawnSeq !== before.spawnSeq || after.alive !== before.alive) {
      remote.offsetX = remote.offsetY = remote.offsetZ = 0;
      return;
    }
    const dx = before.x + remote.offsetX - after.x;
    const dy = before.y + remote.offsetY - after.y;
    const dz = before.z + remote.offsetZ - after.z;
    const tooFar =
      dx * dx + dy * dy + dz * dz > this.tuning.snapDistance * this.tuning.snapDistance;
    remote.offsetX = tooFar ? 0 : dx;
    remote.offsetY = tooFar ? 0 : dy;
    remote.offsetZ = tooFar ? 0 : dz;
  }

  remove(id: number): void {
    this.remotes.delete(id);
  }

  /** Moves the remote clock forward to `nowMs`. Call once per frame. */
  advance(nowMs: number): void {
    if (Number.isNaN(this.viewTick)) return;
    const elapsedMs = Math.max(0, nowMs - this.lastAdvanceMs);
    this.lastAdvanceMs = nowMs;

    const tuning = this.tuning;
    const error = this.targetTick(nowMs) - (this.viewTick + elapsedMs / TICK_MS);
    if (Math.abs(error) > tuning.snapTicks) {
      this.viewTick = this.targetTick(nowMs);
      this.rate = 1;
    } else {
      this.rate =
        1 +
        Math.max(-tuning.maxRateAdjust, Math.min(tuning.maxRateAdjust, error * tuning.rateGain));
      this.viewTick += (elapsedMs / TICK_MS) * this.rate;
    }

    // Close leftover offsets: by half every half-life, but never faster than
    // a ship can fly, so the catching-up never looks like a jump.
    const keep = Math.pow(0.5, elapsedMs / tuning.offsetHalfLifeMs);
    const maxStep = (OFFSET_CLOSE_SPEED * elapsedMs) / 1000;
    for (const remote of this.remotes.values()) {
      const length = Math.sqrt(
        remote.offsetX * remote.offsetX +
          remote.offsetY * remote.offsetY +
          remote.offsetZ * remote.offsetZ,
      );
      if (length === 0) continue;
      const step = Math.min(length * (1 - keep), maxStep);
      const scale = length - step < 1e-6 ? 0 : (length - step) / length;
      remote.offsetX *= scale;
      remote.offsetY *= scale;
      remote.offsetZ *= scale;
    }
  }

  /**
   * Where a ship is at a tick, straight from its samples: no smoothing. This
   * is the position hits are decided against, on the client and on the server.
   */
  poseAt(id: number, tick: number): TrackPose | null {
    const remote = this.remotes.get(id);
    return remote ? sampleTrack(remote.track, tick, this.tuning.maxExtrapolationTicks) : null;
  }

  /** Every remote ship as it should be drawn now. */
  views(): RemoteView[] {
    const views: RemoteView[] = [];
    if (Number.isNaN(this.viewTick)) return views;
    for (const [id, remote] of this.remotes) {
      const pose = sampleTrack(remote.track, this.viewTick, this.tuning.maxExtrapolationTicks);
      if (!pose) continue;
      views.push({
        ...pose,
        x: pose.x + remote.offsetX,
        y: pose.y + remote.offsetY,
        z: pose.z + remote.offsetZ,
        id,
        viewTick: this.viewTick,
      });
    }
    return views;
  }

  /** Drops ships that no snapshot has mentioned for a while. */
  prune(newestServerTick: number): void {
    for (const [id, remote] of this.remotes) {
      const newest = remote.track[remote.track.length - 1];
      if (!newest || newestServerTick - newest.tick > 2 * TICK_RATE) this.remotes.delete(id);
    }
  }

  clear(): void {
    this.remotes.clear();
    this.arrivalOffsets.length = 0;
    this.viewTick = Number.NaN;
    this.delayTicks = this.tuning.minDelayTicks;
    this.rate = 1;
  }

  private targetTick(nowMs: number): number {
    return (nowMs - this.fastestOffsetMs) / TICK_MS - this.delayTicks;
  }
}
