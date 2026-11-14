import { describe, expect, it } from 'vitest';
import { STICK_DEAD_ZONE, STICK_RADIUS, stickAxis, tiltAxes } from '../../src/client/input.ts';

describe('the touch stick', () => {
  it('gives nothing inside the dead zone and exactly ±1 at its edge and beyond', () => {
    expect(stickAxis(0)).toBe(0);
    expect(stickAxis(STICK_RADIUS * STICK_DEAD_ZONE)).toBe(0);
    expect(stickAxis(-STICK_RADIUS * STICK_DEAD_ZONE * 0.9)).toBe(0);
    expect(stickAxis(STICK_RADIUS)).toBe(1);
    expect(stickAxis(-STICK_RADIUS)).toBe(-1);
    expect(stickAxis(STICK_RADIUS * 3)).toBe(1);
  });

  it('rises smoothly from the dead zone: no jump as the finger leaves it', () => {
    const justOutside = stickAxis(STICK_RADIUS * (STICK_DEAD_ZONE + 0.01));
    expect(justOutside).toBeGreaterThan(0);
    expect(justOutside).toBeLessThan(0.02);
    expect(stickAxis(STICK_RADIUS * 0.56)).toBeCloseTo(0.5, 9);
  });
});

describe('tilt steering, as designed (not yet tried on a phone)', () => {
  // Held sideways with the top of the phone to the left (angle 90).
  it('however the phone is held when tilt starts is straight ahead', () => {
    expect(tiltAxes(12, -30, 12, -30, 90)).toEqual({ yaw: -0, pitch: 0 });
  });

  it('right side down turns right, like the D key; far edge down is the Up key', () => {
    expect(tiltAxes(25, 0, 0, 0, 90).yaw).toBe(-1);
    expect(tiltAxes(-12.5, 0, 0, 0, 90).yaw).toBe(0.5);
    expect(tiltAxes(0, 25, 0, 0, 90).pitch).toBe(1);
  });

  it('is mirrored with the top of the phone to the right, and never exceeds ±1', () => {
    expect(tiltAxes(25, 0, 0, 0, 270).yaw).toBe(1);
    expect(tiltAxes(0, 25, 0, 0, 270).pitch).toBe(-1);
    expect(tiltAxes(80, -80, 0, 0, 90)).toEqual({ yaw: -1, pitch: -1 });
  });
});
