// What a bot does with the controls. A behaviour sees only what a player
// would: its own predicted ship and the other ships as its client draws them.

import { SIM } from '../../src/shared/constants.ts';
import { NEUTRAL_CONTROLS } from '../../src/shared/sim/ship.ts';
import type { Controls } from '../../src/shared/sim/ship.ts';
import type { ClientCore } from '../../src/net/client.ts';

const wrap = (angle: number): number => {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

const clampAxis = (value: number): number => Math.max(-1, Math.min(1, value));

/**
 * Chases the nearest ship it can see and shoots when lined up. It aims ahead
 * of the target by the bullet's flight time, as a player learns to.
 */
export function hunter(): (tick: number, core: ClientCore) => Controls {
  const lastSeen = new Map<number, { x: number; y: number; z: number; viewTick: number }>();
  return (_tick, core) => {
    const me = core.state;
    if (!me?.alive) return NEUTRAL_CONTROLS;

    let best: { x: number; y: number; z: number; distance: number } | null = null;
    for (const view of core.remoteViews()) {
      if (!view.alive || !view.full) continue;
      // Estimate the target's velocity from how it moved since last looked at.
      const before = lastSeen.get(view.id);
      const elapsed = before ? view.viewTick - before.viewTick : 0;
      const perTick = elapsed > 0 && elapsed < 30 ? 1 / elapsed : 0;
      const vx = before ? (view.x - before.x) * perTick : 0;
      const vy = before ? (view.y - before.y) * perTick : 0;
      const vz = before ? (view.z - before.z) * perTick : 0;
      if (elapsed >= 2 || !before) {
        lastSeen.set(view.id, { x: view.x, y: view.y, z: view.z, viewTick: view.viewTick });
      }
      const distance = Math.hypot(view.x - me.x, view.y - me.y, view.z - me.z);
      const flightTicks = distance / (SIM.bulletSpeed / SIM.tickRate);
      const aim = {
        x: view.x + vx * flightTicks,
        y: view.y + vy * flightTicks,
        z: view.z + vz * flightTicks,
        distance,
      };
      if (!best || distance < best.distance) best = aim;
    }
    if (!best) return { yaw: 0, pitch: 0, throttle: 0, fire: false };

    const dx = best.x - me.x;
    const dy = best.y - me.y;
    const dz = best.z - me.z;
    const yawError = wrap(Math.atan2(dx, dz) - me.yaw);
    // Forward y is −sin(pitch), so a target above needs negative pitch.
    const pitchError = -Math.atan2(dy, Math.hypot(dx, dz)) - me.pitch;
    const linedUp = Math.abs(yawError) < 0.05 && Math.abs(pitchError) < 0.05;
    return {
      yaw: clampAxis(yawError * 6),
      pitch: clampAxis(pitchError * 6),
      throttle: best.distance > 300 ? 1 : best.distance < 120 ? -1 : 0,
      fire: linedUp && best.distance < 650,
    };
  };
}
