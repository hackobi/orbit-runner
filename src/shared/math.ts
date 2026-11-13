// Deterministic maths for the shared simulation.
//
// ECMAScript calls Math.sin and Math.cos "implementation-approximated", so V8
// and JavaScriptCore may round them differently. These versions use only
// + − × ÷ and Math.round, which the spec defines exactly, so every engine
// produces the same bits.

export const PI = 3.141592653589793;
export const TWO_PI = 2 * PI;
export const HALF_PI = PI / 2;

// π/2 split in two parts (Cody–Waite) so that x − k·π/2 keeps full precision.
const PIO2_HIGH = 1.5707963267341256;
const PIO2_LOW = 6.077100506506192e-11;
const TWO_OVER_PI = 0.6366197723675814;

// Taylor coefficients. Division is exactly rounded, so these are the same
// everywhere.
const S3 = -1 / 6;
const S5 = 1 / 120;
const S7 = -1 / 5040;
const S9 = 1 / 362880;
const S11 = -1 / 39916800;
const S13 = 1 / 6227020800;
const S15 = -1 / 1307674368000;

const C2 = -1 / 2;
const C4 = 1 / 24;
const C6 = -1 / 720;
const C8 = 1 / 40320;
const C10 = -1 / 3628800;
const C12 = 1 / 479001600;
const C14 = -1 / 87178291200;
const C16 = 1 / 20922789888000;

/** sin(r) for |r| ≤ π/4. Truncation error is below 5e-17. */
function sinKernel(r: number): number {
  const r2 = r * r;
  return r + r * r2 * (S3 + r2 * (S5 + r2 * (S7 + r2 * (S9 + r2 * (S11 + r2 * (S13 + r2 * S15))))));
}

/** cos(r) for |r| ≤ π/4. Truncation error is below 3e-18. */
function cosKernel(r: number): number {
  const r2 = r * r;
  return (
    1 +
    r2 * (C2 + r2 * (C4 + r2 * (C6 + r2 * (C8 + r2 * (C10 + r2 * (C12 + r2 * (C14 + r2 * C16)))))))
  );
}

// Quadrant of x and the remainder in [−π/4, π/4]. Accurate for |x| up to about
// 1e5; the simulation only passes wrapped angles.
function quadrant(x: number): number {
  return Math.round(x * TWO_OVER_PI);
}

function remainder(x: number, k: number): number {
  return x - k * PIO2_HIGH - k * PIO2_LOW;
}

export function sin(x: number): number {
  const k = quadrant(x);
  const r = remainder(x, k);
  switch (((k % 4) + 4) % 4) {
    case 0:
      return sinKernel(r);
    case 1:
      return cosKernel(r);
    case 2:
      return -sinKernel(r);
    default:
      return -cosKernel(r);
  }
}

export function cos(x: number): number {
  const k = quadrant(x);
  const r = remainder(x, k);
  switch (((k % 4) + 4) % 4) {
    case 0:
      return cosKernel(r);
    case 1:
      return -sinKernel(r);
    case 2:
      return -cosKernel(r);
    default:
      return sinKernel(r);
  }
}

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Wraps an angle that is at most one turn outside (−π, π] back into it. */
export function wrapAngle(angle: number): number {
  if (angle > PI) return angle - TWO_PI;
  if (angle <= -PI) return angle + TWO_PI;
  return angle;
}
