// The looks a pilot can give their ship. A look changes what is drawn and
// nothing else: every ship is hit, flies and fires the same whatever it wears.
// This file is the list; `models.ts` builds each one.

import type { CrateTier } from '../shared/drops.ts';

/** A ship has two shapes: its own, and the Fenix it turns into after a Fenix orb. */
export type ShipForm = 'saucer' | 'fenix';

export interface Skin {
  readonly id: string;
  readonly name: string;
  /** How rare it reads, in the words crates and gear already use. */
  readonly tier: CrateTier;
  /** The shapes it dresses. The three special ones dress both. */
  readonly forms: readonly ShipForm[];
}

export const SKINS = [
  { id: 'standard', name: 'Standard', tier: 'Common', forms: ['saucer', 'fenix'] },
  // Paint, trim and lights on the saucer.
  { id: 'comet', name: 'Comet', tier: 'Rare', forms: ['saucer'] },
  { id: 'tidal', name: 'Tidal', tier: 'Rare', forms: ['saucer'] },
  { id: 'hornet', name: 'Hornet', tier: 'Rare', forms: ['saucer'] },
  // Paint, trim and lights on the Fenix.
  { id: 'frostbite', name: 'Frostbite', tier: 'Rare', forms: ['fenix'] },
  { id: 'venom', name: 'Venom', tier: 'Rare', forms: ['fenix'] },
  { id: 'dusk', name: 'Dusk', tier: 'Rare', forms: ['fenix'] },
  // Ships of their own: a different shape, a part that moves, their own engines.
  { id: 'prism', name: 'Prism', tier: 'Epic', forms: ['saucer', 'fenix'] },
  { id: 'solar', name: 'Solar Crown', tier: 'Legendary', forms: ['saucer', 'fenix'] },
  { id: 'phantom', name: 'Phantom', tier: 'Mythic', forms: ['saucer', 'fenix'] },
] as const satisfies readonly Skin[];

export type SkinId = (typeof SKINS)[number]['id'];

/** What one ship wears: a look for each of its two shapes. */
export interface Looks {
  readonly saucer: SkinId;
  readonly fenix: SkinId;
}

export const STANDARD_LOOKS: Looks = { saucer: 'standard', fenix: 'standard' };

/** The looks a shape can wear, in the order they are offered. */
export function skinsFor(form: ShipForm): readonly (typeof SKINS)[number][] {
  return SKINS.filter((skin) => (skin.forms as readonly ShipForm[]).includes(form));
}

/** A stored choice if it is a look this shape can wear, and the standard look if not. */
export function skinOr(value: unknown, form: ShipForm): SkinId {
  return skinsFor(form).find((skin) => skin.id === value)?.id ?? 'standard';
}
