// The player's own preferences, kept in the browser between visits.

export interface Settings {
  /** Flip the pitch axis for every device (decision D10). */
  invertPitch: boolean;
  /** Steer by tilting the phone. Off unless the player asks for it. */
  tilt: boolean;
  /** Fly from inside the ship instead of from behind it. */
  cockpit: boolean;
}

const KEY = 'orbit-runner.settings';
const DEFAULTS: Settings = { invertPitch: false, tilt: false, cockpit: false };

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return {
      invertPitch: stored.invertPitch === true,
      tilt: stored.tilt === true,
      cockpit: stored.cockpit === true,
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
