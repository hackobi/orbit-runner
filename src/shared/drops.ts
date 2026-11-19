// Salvage crates: what a pilot can win while flying, and the odds. A crate is
// decided by the server alone and is worth nothing here; it is carried to
// SpaceFort with a claim code and opened there (docs/DECISIONS.md, D28).

export const CRATE_TIERS = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'] as const;
export type CrateTier = (typeof CRATE_TIERS)[number];

export const CRATE_SOURCES = ['orb', 'raider', 'boss'] as const;
export type CrateSource = (typeof CRATE_SOURCES)[number];

/** The chance that an orb or a raider leaves a crate at all. */
export const CRATE_CHANCE = { orb: 1 / 150, raider: 1 / 300 } as const;

/** The boss: a base chance, more for every level, up to a ceiling. */
export const BOSS_CRATE = { base: 0.15, perLevel: 0.005, cap: 0.4, leastShare: 0.5 } as const;

/** Crates a pilot may win in a day from orbs and raiders together. The boss is not counted. */
export const DAILY_CRATE_CAP = 3;

/** Out of 10,000, in the order of CRATE_TIERS. */
const TIER_ODDS: Record<CrateSource, readonly number[]> = {
  orb: [9000, 900, 90, 10, 0],
  raider: [9000, 900, 90, 10, 0],
  boss: [5500, 3000, 1200, 270, 30],
};

/**
 * The chance of a crate for one pilot when the boss falls. `damageShare` is
 * the part of the damage that was theirs, 0 to 1: a full crew of equals each
 * roll at least half the chance, and a pilot who did most of it rolls it all.
 */
export function bossCrateChance(level: number, damageShare: number): number {
  const chance = Math.min(BOSS_CRATE.cap, BOSS_CRATE.base + BOSS_CRATE.perLevel * level);
  return chance * Math.max(BOSS_CRATE.leastShare, Math.min(1, damageShare));
}

/** The tier of a crate from `source`, given a number drawn evenly from 0 up to 1. */
export function crateTier(source: CrateSource, draw: number): CrateTier {
  const odds = TIER_ODDS[source];
  let left = Math.floor(draw * 10_000);
  for (let tier = 0; tier < odds.length; tier++) {
    left -= odds[tier] ?? 0;
    if (left < 0) return CRATE_TIERS[tier] ?? 'Common';
  }
  return 'Common';
}

/** A crate's odds of being at least this tier, for showing to players. */
export function tierOdds(source: CrateSource): readonly number[] {
  return TIER_ODDS[source];
}
