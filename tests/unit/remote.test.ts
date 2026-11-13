import { describe, expect, it } from 'vitest';
import { sampleOf, sampleTrack } from '../../src/shared/remote.ts';
import type { RemoteSample } from '../../src/shared/remote.ts';
import { Rng } from '../../src/shared/rng.ts';
import { spawnShip } from '../../src/shared/sim/ship.ts';
import type { ShipState } from '../../src/shared/sim/ship.ts';

const base: ShipState = { ...spawnShip(new Rng(1), 0), x: 0, y: 0, z: 0, invulnTicks: 0 };
const at = (tick: number, overrides: Partial<ShipState>): RemoteSample =>
  sampleOf(tick, { ...base, ...overrides });

describe('placing a remote ship in time', () => {
  const track = [at(10, { x: 0 }), at(12, { x: 2 }), at(14, { x: 4, yaw: 0.5 })];

  it('draws a straight line between two samples', () => {
    expect(sampleTrack(track, 11, 9)?.x).toBe(1);
    expect(sampleTrack(track, 12.5, 9)?.x).toBe(2.5);
    expect(sampleTrack(track, 10, 9)?.x).toBe(0);
    expect(sampleTrack(track, 13, 9)?.extrapolatedTicks).toBe(0);
  });

  it('turns angles the short way round', () => {
    const turning = [at(10, { yaw: 3.0 }), at(12, { yaw: -3.0 })];
    const mid = sampleTrack(turning, 11, 9);
    // From 3.0 to −3.0 the short way passes through π, not through 0.
    expect(Math.abs(mid?.yaw ?? 0)).toBeGreaterThan(3.0);
  });

  it('returns null before the first sample and for an empty track', () => {
    expect(sampleTrack(track, 9.9, 9)).toBeNull();
    expect(sampleTrack([], 10, 9)).toBeNull();
  });

  it('past the newest sample, carries on along the last movement, up to the limit, then holds', () => {
    expect(sampleTrack(track, 15, 9)).toMatchObject({ x: 5, extrapolatedTicks: 1 });
    expect(sampleTrack(track, 23, 9)).toMatchObject({ x: 13, extrapolatedTicks: 9 });
    expect(sampleTrack(track, 40, 9)).toMatchObject({ x: 13, extrapolatedTicks: 9 });
    // With no extrapolation allowed (as the server uses it) it holds at once.
    expect(sampleTrack(track, 15, 0)).toMatchObject({ x: 4, extrapolatedTicks: 0 });
  });

  it('does not draw a line across a respawn: the ship stays, then jumps', () => {
    const respawn = [at(10, { x: 0, spawnSeq: 1 }), at(12, { x: 5000, spawnSeq: 2 })];
    expect(sampleTrack(respawn, 11.9, 9)).toMatchObject({ x: 0, spawnSeq: 1 });
    expect(sampleTrack(respawn, 12, 9)).toMatchObject({ x: 5000, spawnSeq: 2 });
    // And does not extrapolate from the old life into the new one.
    expect(sampleTrack(respawn, 14, 9)).toMatchObject({ x: 5000, extrapolatedTicks: 0 });
  });

  it('does not extrapolate a dead ship', () => {
    const dying = [at(10, { x: 0 }), at(12, { x: 2, alive: false })];
    expect(sampleTrack(dying, 15, 9)).toMatchObject({ x: 2, alive: false, extrapolatedTicks: 0 });
  });

  it('takes flags from the earlier sample of the pair', () => {
    const protectedThenNot = [at(10, { invulnTicks: 5 }), at(12, { invulnTicks: 0 })];
    expect(sampleTrack(protectedThenNot, 11, 9)?.invulnerable).toBe(true);
    expect(sampleTrack(protectedThenNot, 12, 9)?.invulnerable).toBe(false);
  });

  it('works across uneven gaps, as after a server catch-up', () => {
    const uneven = [at(10, { x: 0 }), at(13, { x: 3 }), at(14, { x: 4 })];
    expect(sampleTrack(uneven, 11.5, 9)?.x).toBe(1.5);
    expect(sampleTrack(uneven, 13.5, 9)?.x).toBe(3.5);
  });
});
