// How other players' ships travel on the wire and how they are placed in
// time. The client draws remote ships with sampleTrack; the server uses the
// very same function, on the very same quantised samples, to work out where
// a shooter was seeing a target. That is what makes "I hit it on my screen"
// and "the server says it was a hit" the same question.

import { PI, TWO_PI } from './math.ts';
import type { ShipState } from './sim/ship.ts';

/** One ship at one snapshot tick, already rounded to what the wire can carry. */
export interface RemoteSample {
  readonly tick: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly hp: number;
  readonly shield: number;
  readonly spawnSeq: number;
  readonly alive: boolean;
  readonly boosting: boolean;
  readonly invulnerable: boolean;
  readonly fenix: boolean;
  /**
   * False for a distant ship, which is sent less often and as a position
   * only. Its angles are zero.
   */
  readonly full: boolean;
}

/** X and Z are sent in 1/256 of a unit: finer than anything visible. */
export const POSITION_SCALE = 256;
/** Y only spans ±500, so it is sent in 16 bits at 1/64 of a unit. */
export const HEIGHT_SCALE = 64;
/** Angles are sent as 16-bit fractions of π. */
export const ANGLE_SCALE = 32767 / PI;

export const quantisePosition = (value: number): number => Math.round(value * POSITION_SCALE);
export const quantiseHeight = (value: number): number => Math.round(value * HEIGHT_SCALE);
export const quantiseAngle = (value: number): number => Math.round(value * ANGLE_SCALE);

/** The sample a snapshot carries for a nearby ship. */
export function sampleOf(tick: number, ship: ShipState): RemoteSample {
  return {
    tick,
    x: quantisePosition(ship.x) / POSITION_SCALE,
    y: quantiseHeight(ship.y) / HEIGHT_SCALE,
    z: quantisePosition(ship.z) / POSITION_SCALE,
    yaw: quantiseAngle(ship.yaw) / ANGLE_SCALE,
    pitch: quantiseAngle(ship.pitch) / ANGLE_SCALE,
    roll: quantiseAngle(ship.roll) / ANGLE_SCALE,
    hp: ship.hp,
    shield: ship.shield,
    spawnSeq: ship.spawnSeq,
    alive: ship.alive,
    boosting: ship.boostTicks > 0,
    invulnerable: ship.invulnTicks > 0,
    fenix: ship.fenix,
    full: true,
  };
}

/** The same ship as a distant one sees it: where it is, and little else. */
export function distantSampleOf(sample: RemoteSample): RemoteSample {
  return {
    ...sample,
    yaw: 0,
    pitch: 0,
    roll: 0,
    hp: 0,
    shield: 0,
    boosting: false,
    invulnerable: false,
    full: false,
  };
}

/** A ship placed at a moment in time. */
export interface TrackPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  hp: number;
  shield: number;
  spawnSeq: number;
  alive: boolean;
  boosting: boolean;
  invulnerable: boolean;
  fenix: boolean;
  full: boolean;
  /** 0 when the pose lies between two samples; otherwise how many ticks past the newest it was pushed. */
  extrapolatedTicks: number;
  /**
   * The tick of the sample that hp, shield and the flags were taken from. They are
   * not interpolated: they are as of this tick, which is at or before the
   * tick asked for.
   */
  stateTick: number;
}

function shortestArc(from: number, to: number): number {
  let delta = to - from;
  if (delta > PI) delta -= TWO_PI;
  else if (delta < -PI) delta += TWO_PI;
  return delta;
}

function poseAt(sample: RemoteSample): TrackPose {
  return {
    x: sample.x,
    y: sample.y,
    z: sample.z,
    yaw: sample.yaw,
    pitch: sample.pitch,
    roll: sample.roll,
    hp: sample.hp,
    shield: sample.shield,
    spawnSeq: sample.spawnSeq,
    alive: sample.alive,
    boosting: sample.boosting,
    invulnerable: sample.invulnerable,
    fenix: sample.fenix,
    full: sample.full,
    extrapolatedTicks: 0,
    stateTick: sample.tick,
  };
}

/**
 * Where a ship is at `tick`, which may fall between samples. `samples` must
 * be in tick order.
 *
 * - Between two samples: a straight line, angles along the shorter arc.
 * - Across a respawn: no line. The ship stays at the earlier sample until
 *   the later one's tick, then is at the later one.
 * - Past the newest sample: carried on along its last movement for at most
 *   `maxExtrapolationTicks`, then held.
 * - Before the oldest sample, or with no samples: null.
 */
export function sampleTrack(
  samples: readonly RemoteSample[],
  tick: number,
  maxExtrapolationTicks: number,
): TrackPose | null {
  const count = samples.length;
  const newest = samples[count - 1];
  const oldest = samples[0];
  if (!newest || !oldest || tick < oldest.tick) return null;

  if (tick >= newest.tick) {
    const pose = poseAt(newest);
    const before = samples[count - 2];
    const beyond = Math.min(tick - newest.tick, maxExtrapolationTicks);
    if (
      beyond > 0 &&
      before &&
      newest.alive &&
      before.alive &&
      before.spawnSeq === newest.spawnSeq &&
      before.full === newest.full
    ) {
      const perTick = 1 / (newest.tick - before.tick);
      pose.x += (newest.x - before.x) * perTick * beyond;
      pose.y += (newest.y - before.y) * perTick * beyond;
      pose.z += (newest.z - before.z) * perTick * beyond;
      pose.yaw += shortestArc(before.yaw, newest.yaw) * perTick * beyond;
      pose.extrapolatedTicks = beyond;
    }
    return pose;
  }

  // Find the pair around the tick. The newest samples are the likely ones.
  let index = count - 2;
  while (index > 0 && (samples[index]?.tick ?? 0) > tick) index--;
  const a = samples[index];
  const b = samples[index + 1];
  if (!a || !b) return null;

  const pose = poseAt(a);
  if (a.spawnSeq !== b.spawnSeq) return pose;
  const t = (tick - a.tick) / (b.tick - a.tick);
  pose.x += (b.x - a.x) * t;
  pose.y += (b.y - a.y) * t;
  pose.z += (b.z - a.z) * t;
  if (a.full && b.full) {
    pose.yaw += shortestArc(a.yaw, b.yaw) * t;
    pose.pitch += (b.pitch - a.pitch) * t;
    pose.roll += (b.roll - a.roll) * t;
  }
  return pose;
}
