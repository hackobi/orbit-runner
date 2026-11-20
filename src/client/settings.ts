// The player's own preferences, kept in the browser between visits.

import { skinOr } from './skins.ts';
import type { SkinId } from './skins.ts';

export interface Settings {
  /** Flip the pitch axis for every device (decision D10). */
  invertPitch: boolean;
  /** Steer by tilting the phone. Off unless the player asks for it. */
  tilt: boolean;
  /** Fly from inside the ship instead of from behind it. */
  cockpit: boolean;
  /** What the ship wears in its own shape, and as a Fenix. */
  saucerSkin: SkinId;
  fenixSkin: SkinId;
}

const KEY = 'orbit-runner.settings';
const DEFAULTS: Settings = {
  invertPitch: false,
  tilt: false,
  cockpit: false,
  saucerSkin: 'standard',
  fenixSkin: 'standard',
};

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return {
      invertPitch: stored.invertPitch === true,
      tilt: stored.tilt === true,
      cockpit: stored.cockpit === true,
      // A look this build does not have, or one for the other shape, is the standard one.
      saucerSkin: skinOr(stored.saucerSkin, 'saucer'),
      fenixSkin: skinOr(stored.fenixSkin, 'fenix'),
    };
  } catch {
    // Private browsing, or storage switched off: settings last for the visit.
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // See loadSettings.
  }
}
