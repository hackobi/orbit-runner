// Homing shots on the client (decision D23). The server flies them; each
// snapshot says where every one nearby is. They are drawn at the same moment
// of the past as other ships, between the two samples around it.

import { SIM } from '../shared/constants.ts';
import type { SeekerEntry } from '../shared/protocol.ts';
import { SEEKER_STEP } from '../shared/sim/seeker.ts';

export interface SeekerView {
  ownerId: number;
  /** The ship it is following, or NO_PLAYER. */
  targetId: number;
  x: number;
  y: number;
  z: number;
  /** Unit direction of flight; zero until it has been seen twice. */
  dx: number;
  dy: number;
  dz: number;
}

interface Sample extends SeekerEntry {
  readonly tick: number;
}

const TRACK_LENGTH = 24;
/** With no newer sample, a shot is carried on along its last movement for this long. */
const MAX_EXTRAPOLATION_TICKS = 9;

export class SeekerTracks {
  /** A ship has one homing shot out at a time, so its owner identifies it. */
  private readonly tracks = new Map<number, Sample[]>();
  private latestTick = 0;

  /** Takes the homing shots of the snapshot for `serverTick`. */
  arrived(serverTick: number, entries: readonly SeekerEntry[]): void {
    if (serverTick <= this.latestTick) return;
    this.latestTick = serverTick;
    for (const entry of entries) {
      let track = this.tracks.get(entry.ownerId);
      if (!track) {
        track = [];
        this.tracks.set(entry.ownerId, track);
      }
      const last = track[track.length - 1];
      if (last) {
        // Further than it could have flown: this is the owner's next shot.
        const reach = (serverTick - last.tick) * SEEKER_STEP * 2 + SIM.muzzleOffset;
        const moved = Math.hypot(entry.x - last.x, entry.y - last.y, entry.z - last.z);
        if (moved > reach) track.length = 0;
      }
      track.push({ ...entry, tick: serverTick });
      if (track.length > TRACK_LENGTH) track.shift();
    }
  }

  /**
   * Every homing shot as it should be drawn at `viewTick`. One that the
   * newest snapshot no longer lists has ended: it is drawn up to the last
   * place it was seen, and then forgotten.
   */
  views(viewTick: number): SeekerView[] {
    const views: SeekerView[] = [];
    for (const [ownerId, track] of this.tracks) {
      const newest = track[track.length - 1];
      const oldest = track[0];
      if (!newest || !oldest || (newest.tick < this.latestTick && viewTick >= newest.tick)) {
        this.tracks.delete(ownerId);
        continue;
      }
      if (viewTick < oldest.tick) continue;

      let index = track.length - 2;
      while (index > 0 && (track[index]?.tick ?? 0) > viewTick) index--;
      const a = track[Math.max(0, index)] ?? newest;
      const b = track[Math.max(0, index) + 1] ?? newest;
      const span = b.tick - a.tick;
      const beyond = Math.min(viewTick - a.tick, span + MAX_EXTRAPOLATION_TICKS);
      const t = span > 0 ? beyond / span : 0;
      const mx = b.x - a.x;
      const my = b.y - a.y;
      const mz = b.z - a.z;
      const length = Math.hypot(mx, my, mz);
      views.push({
        ownerId,
        targetId: newest.targetId,
        x: a.x + mx * t,
        y: a.y + my * t,
        z: a.z + mz * t,
        dx: length > 0 ? mx / length : 0,
        dy: length > 0 ? my / length : 0,
        dz: length > 0 ? mz / length : 0,
      });
    }
    return views;
  }

  clear(): void {
    this.tracks.clear();
    this.latestTick = 0;
  }
}
