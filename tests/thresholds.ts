// Every pass threshold for the multiplayer tests, in one place.
// Distances are in world units and are derived from the ship's size, so they
// stay meaningful if the hull constant changes.

import { SHIP_LENGTH } from '../src/shared/constants.ts';

export const THRESHOLDS = {
  /** Time after joining during which clocks are still settling. Not measured. */
  warmUpMs: 2000,

  /**
   * Remote ships, 100 ms profile: how far the drawn position may be from
   * where the server had the ship at the moment being drawn.
   */
  remoteErrorP95: SHIP_LENGTH * 0.5, // 2.0 units
  remoteErrorMax: SHIP_LENGTH * 2, // 8.0 units

  /**
   * No visible snaps, every profile: between two frames a remote ship may
   * move at most this many times what its speed limit allows in that time.
   * The speed limit is the larger of the ship's top speed in its current
   * state and its actual speed on the server, so a ship still slowing down
   * after a boost is not counted as a snap.
   */
  snapFactor: 3,

  /** Own ship, 200 ms lossy profile: size of prediction corrections. */
  lossyCorrectionP95: SHIP_LENGTH, // 4.0 units

  /**
   * Own ship, clean network: after warm-up there must be no correction
   * larger than this. The comparison itself is exact; this margin only keeps
   * the browser check from depending on the last bit.
   */
  cleanCorrectionMax: SHIP_LENGTH * 0.0025, // 0.01 units

  /** 100 ms profile: share of shooter-view hits the server must confirm. */
  hitAgreementMin: 0.95,

  /** Load test: tick time must stay under half a tick. */
  tickP99Ms: 1000 / 60 / 2, // 8.33 ms
  /** Load test: heap after garbage collection at 5 minutes against 1 minute. */
  heapGrowthMax: 0.1,
} as const;
