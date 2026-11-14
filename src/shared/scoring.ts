// Points. The server keeps every player's score; nothing here is predicted,
// and no client message carries a score. The numbers are v1's
// (main.js:4605-4655, 8011-8032, 8846-8859, 9852) except where noted.

import { SIM } from './constants.ts';
import type { OrbKind } from './sim/orbs.ts';

export const SCORE = {
  /** A ring asteroid shot down (main.js:9020). */
  asteroid: 160,
  /** Orbs are worth this times their kind's multiplier (main.js:4636). */
  orbBase: 110,
  /** A bullet or beam landing on another player (main.js:9852). No multipliers. */
  pvpHit: 500,
  /**
   * Destroying another player. v1 paid this only for its server bots
   * (main.js:7274); without it the hunter orb would double nothing.
   */
  kill: 330,
  /** Points a second for being in the belt, and for being there soon after firing (main.js:8854). */
  beltIncome: 1,
  beltIncomeInCombat: 2,
  /** "Soon after firing" is 10 s (main.js:8854). */
  combatTicks: 600,
  /** A miner or hunter orb doubles its kind of score for 30 s (main.js:9260). */
  multiplierTicks: 1800,
  /** A Zaphire orb opens the store for this long, or until something is bought. */
  storeTicks: 1200,
} as const;

/** main.js:4639-4645. Kinds not listed are worth nothing by themselves. */
const ORB_MULTIPLIER: Record<OrbKind, number> = {
  shield: 5,
  pink: 10,
  boost: 5,
  zaphire: 1,
  fenix: 0,
  wormhole: 0,
  miner: 0,
  hunter: 0,
};

/** What the store sells, for points (main.js:8011-8032). */
export const STORE_ITEMS = ['hp', 'shield', 'fenix'] as const;
export type StoreItem = (typeof STORE_ITEMS)[number];
export const STORE_PRICES: Record<StoreItem, number> = { hp: 1500, shield: 1000, fenix: 2000 };

/** True over the belt, whatever the height (main.js:4617-4622). */
export function inBelt(x: number, z: number): boolean {
  const r2 = x * x + z * z;
  return r2 >= SIM.beltInner * SIM.beltInner && r2 <= SIM.beltOuter * SIM.beltOuter;
}

const doubled = (points: number, twice: boolean): number => (twice ? points * 2 : points);

/** main.js:4623-4628. Every rock is in the belt, so the belt's doubling always applies. */
export function asteroidScore(minerActive: boolean): number {
  return doubled(SCORE.asteroid * 2, minerActive);
}

/** main.js:4635-4655. Every orb is in the belt too. The miner orb doubles orbs as well. */
export function orbScore(kind: OrbKind, minerActive: boolean): number {
  return doubled(SCORE.orbBase * ORB_MULTIPLIER[kind] * 2, minerActive);
}

/** main.js:4629-4634, with the place being where the victim was. */
export function killScore(x: number, z: number, hunterActive: boolean): number {
  return doubled(doubled(SCORE.kill, inBelt(x, z)), hunterActive);
}
