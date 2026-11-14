// Keeps the picture smooth on slow devices by drawing less. It watches how
// long frames take and moves between a few quality tiers, slowly and with a
// memory, so the picture does not flicker between two of them.
//
// The simulation is not involved: it runs in fixed steps whatever the frame
// rate, so a slow device sees the same game, less finely drawn.

export interface QualityTier {
  readonly name: 'high' | 'medium' | 'low';
  /** The canvas never has more device pixels per CSS pixel than this. v1 used 1.75. */
  readonly pixelRatio: number;
  /** Nor more pixels in all than this. */
  readonly maxPixels: number;
  /** Exhaust and burst specks alive at once. */
  readonly particles: number;
  /** Rocks whose orbit is further than this from the ship's are not drawn. */
  readonly rockDistance: number;
}

export const TIERS: readonly QualityTier[] = [
  { name: 'high', pixelRatio: 1.75, maxPixels: 8_300_000, particles: 1400, rockDistance: Infinity },
  { name: 'medium', pixelRatio: 1.25, maxPixels: 2_600_000, particles: 500, rockDistance: 900 },
  { name: 'low', pixelRatio: 1, maxPixels: 1_300_000, particles: 150, rockDistance: 450 },
];

/** Slower than this on average and the picture is too heavy: under 50 frames a second. */
const TOO_SLOW_MS = 20;
/** Faster than this and there is room for more: 57 frames a second or better. */
const FAST_ENOUGH_MS = 17.5;
/** Frames are judged a second at a time. */
const WINDOW_MS = 1000;
/** Two slow seconds in a row drop a tier. */
const SLOW_WINDOWS_TO_DROP = 2;
/** Ten fast seconds in a row try the tier above. */
const FAST_WINDOWS_TO_RISE = 10;
/** A rise that had to be undone doubles the wait before the next, up to this many seconds. */
const MAX_RISE_WAIT = 160;
/** A gap this long is not a slow frame: the tab was hidden or the phone was locked. */
const PAUSE_MS = 250;

export class QualityController {
  /** Index into TIERS. */
  tier: number;

  private windowMs = 0;
  private windowFrames = 0;
  private slowWindows = 0;
  private fastWindows = 0;
  private riseWait = FAST_WINDOWS_TO_RISE;
  /** Seconds since the last rise, to tell whether a drop is that rise failing. */
  private windowsSinceRise = Infinity;

  constructor(startTier: number) {
    this.tier = startTier;
  }

  /** Call once a frame with the time since the last. Returns true if the tier changed. */
  frame(elapsedMs: number): boolean {
    if (elapsedMs > PAUSE_MS) {
      // Start the count again after a pause.
      this.windowMs = this.windowFrames = 0;
      return false;
    }
    this.windowMs += elapsedMs;
    this.windowFrames += 1;
    if (this.windowMs < WINDOW_MS) return false;

    const average = this.windowMs / this.windowFrames;
    this.windowMs = this.windowFrames = 0;
    this.windowsSinceRise += 1;
    this.slowWindows = average > TOO_SLOW_MS ? this.slowWindows + 1 : 0;
    this.fastWindows = average < FAST_ENOUGH_MS ? this.fastWindows + 1 : 0;

    if (this.slowWindows >= SLOW_WINDOWS_TO_DROP && this.tier < TIERS.length - 1) {
      this.tier += 1;
      this.slowWindows = this.fastWindows = 0;
      // Dropping straight after a rise means the rise was a mistake: wait
      // twice as long before trying it again.
      if (this.windowsSinceRise <= 2 * SLOW_WINDOWS_TO_DROP) {
        this.riseWait = Math.min(MAX_RISE_WAIT, this.riseWait * 2);
      }
      return true;
    }
    if (this.fastWindows >= this.riseWait && this.tier > 0) {
      this.tier -= 1;
      this.slowWindows = this.fastWindows = 0;
      this.windowsSinceRise = 0;
      return true;
    }
    return false;
  }
}
