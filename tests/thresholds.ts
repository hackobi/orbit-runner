// Every pass threshold for the multiplayer tests, in one place.
// Distances are in world units and are derived from the ship's size, so they
// stay meaningful if the hull constant changes.

import { SHIP_LENGTH } from '../src/shared/constants.ts';

export const THRESHOLDS = {
  /** Time after joining during which the tick clock is still settling. */
  warmUpMs: 2000,

  /**
   * Clean network: after warm-up there must be no correction of the own ship
   * larger than this. The comparison itself is exact; this margin only keeps
   * the browser check from depending on the last bit.
   */
  cleanCorrectionMax: SHIP_LENGTH * 0.0025, // 0.01 units
} as const;
