import { describe, expect, it } from 'vitest';
import { HALF_PI, PI, clamp, cos, sin, wrapAngle } from '../../src/shared/math.ts';

describe('deterministic sin and cos', () => {
  it('match Math.sin and Math.cos to 1e-12 over ±4π', () => {
    let worst = 0;
    const steps = 200_000;
    for (let i = 0; i <= steps; i++) {
      const x = -4 * PI + (8 * PI * i) / steps;
      worst = Math.max(worst, Math.abs(sin(x) - Math.sin(x)), Math.abs(cos(x) - Math.cos(x)));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('are exact at the points the simulation relies on', () => {
    expect(sin(0)).toBe(0);
    expect(cos(0)).toBe(1);
    expect(Math.abs(sin(PI))).toBeLessThan(1e-15);
    expect(Math.abs(cos(HALF_PI))).toBeLessThan(1e-15);
    expect(sin(HALF_PI)).toBe(1);
    expect(cos(PI)).toBe(-1);
  });

  it('stay on the unit circle', () => {
    for (let x = -PI; x <= PI; x += 0.001) {
      expect(Math.abs(sin(x) * sin(x) + cos(x) * cos(x) - 1)).toBeLessThan(1e-15);
    }
  });

  it('are odd and even', () => {
    // Starts above zero: sin(−0) is +0 here, which the simulation never depends on.
    for (let x = 0.013; x <= 7; x += 0.013) {
      expect(sin(-x)).toBe(-sin(x));
      expect(cos(-x)).toBe(cos(x));
    }
  });
});

describe('helpers', () => {
  it('clamp', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('wrapAngle keeps angles in (−π, π]', () => {
    expect(wrapAngle(PI + 0.1)).toBeCloseTo(-PI + 0.1, 12);
    expect(wrapAngle(-PI - 0.1)).toBeCloseTo(PI - 0.1, 12);
    expect(wrapAngle(1)).toBe(1);
    expect(wrapAngle(PI)).toBe(PI);
  });
});
