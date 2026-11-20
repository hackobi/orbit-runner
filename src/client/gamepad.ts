// A game controller, read through the browser's Gamepad API.
//
// Only controllers the browser reports with the "standard" layout are used.
// That one layout covers the PS5 DualSense, the PS4 pad and Xbox pads alike,
// so there is a single table below and nothing for the player to choose.
// The browser does the pairing (USB or Bluetooth, through the system), and
// it hides a controller from the page until one of its buttons is pressed.

import type { Controls } from '../shared/sim/ship.ts';

/** Stick movement within this share of its travel counts as none: worn sticks rest off-centre. */
export const PAD_DEAD_ZONE = 0.15;
/** A trigger pulled past this counts as held. */
const TRIGGER_HELD = 0.3;
/** The right stick pushed past this changes speed. */
const THROTTLE_HELD = 0.5;
/**
 * How hard the right stick steers while L1 / LB is held: the mouse's share
 * of the full rate (POINTER_GAIN in input.ts).
 */
export const PAD_TRIM_GAIN = 0.6;

// Indices in the standard layout (w3c.github.io/gamepad/#remapping).
const BUTTON = {
  south: 0,
  east: 1,
  leftBumper: 4,
  rightBumper: 5,
  leftTrigger: 6,
  rightTrigger: 7,
  menu: 9,
  dpadUp: 12,
  dpadDown: 13,
} as const;
const AXIS = { leftX: 0, leftY: 1, rightX: 2, rightY: 3 } as const;

/** What each control does, for the list shown in settings. Names: PlayStation, then Xbox. */
export const PAD_LAYOUT: readonly { control: string; action: string }[] = [
  { control: 'Left stick', action: 'Steer' },
  { control: 'R2 / RT', action: 'Fire' },
  { control: 'R1 / RB', action: 'Heavy shot' },
  { control: 'L2 / LT', action: 'Homing shot: hold, then let go' },
  { control: '✕ / A', action: 'Boost' },
  { control: '○ / B', action: 'Brake' },
  { control: 'D-pad or right stick, up and down', action: 'Speed' },
  { control: 'L1 / LB held, with the right stick', action: 'Second steering, as the mouse' },
  { control: 'Options / Menu', action: 'Open or close settings' },
];

/** The parts of a Gamepad this file reads, so tests can pass plain objects. */
export interface PadLike {
  readonly id: string;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

/** One stick axis: nothing inside the dead zone, then 0 to ±1. */
export function padAxis(value: number): number {
  const size = Math.min(1, Math.abs(value));
  if (!(size > PAD_DEAD_ZONE)) return 0;
  return (Math.sign(value) * (size - PAD_DEAD_ZONE)) / (1 - PAD_DEAD_ZONE);
}

/**
 * The controls a pad is asking for, plus its menu button. Pitch is before any
 * inversion. Yaw and pitch can pass ±1 when both sticks steer the same way;
 * the caller clamps the sum of every device.
 */
export function padControls(pad: PadLike): Required<Controls> & { menu: boolean } {
  const held = (index: number, threshold = 0.5): boolean => {
    const button = pad.buttons[index];
    return !!button && (button.pressed || button.value > threshold);
  };
  const rightX = pad.axes[AXIS.rightX] ?? 0;
  const rightY = pad.axes[AXIS.rightY] ?? 0;
  // With L1 / LB held the right stick stops changing speed and steers as the
  // mouse does with its button down: where the stick is pushed is where the
  // pointer would be, so it has the mouse's strength and the mouse's
  // directions (decision D12), and it adds to the left stick.
  const trim = held(BUTTON.leftBumper);
  const trimYaw = trim ? padAxis(rightX) * PAD_TRIM_GAIN : 0;
  const trimPitch = trim ? -padAxis(rightY) * PAD_TRIM_GAIN : 0;
  const faster = held(BUTTON.dpadUp) || (!trim && rightY < -THROTTLE_HELD);
  const slower = held(BUTTON.dpadDown) || (!trim && rightY > THROTTLE_HELD);
  return {
    // Stick right turns right, which is negative yaw, as the D key.
    yaw: -padAxis(pad.axes[AXIS.leftX] ?? 0) + trimYaw || 0,
    // Stick forward is the Up key. Forward reads as negative.
    pitch: -padAxis(pad.axes[AXIS.leftY] ?? 0) + trimPitch || 0,
    throttle: (faster ? 1 : 0) - (slower ? 1 : 0),
    fire: held(BUTTON.rightTrigger, TRIGGER_HELD),
    heavy: held(BUTTON.rightBumper),
    seek: held(BUTTON.leftTrigger, TRIGGER_HELD),
    boost: held(BUTTON.south),
    brake: held(BUTTON.east),
    menu: held(BUTTON.menu),
  };
}

/**
 * The controller in use: the first connected one with the standard layout.
 * Asked for afresh every time, because browsers hand out a new snapshot of
 * each pad per frame and an old one never changes.
 */
export function activePad(): PadLike | null {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
  let pads: readonly (PadLike | null)[];
  try {
    pads = navigator.getGamepads();
  } catch {
    // Some embedded pages are not allowed controllers at all.
    return null;
  }
  for (const pad of pads) {
    if (pad && pad.connected && pad.mapping === 'standard') return pad;
  }
  return null;
}

/** A connected controller the game cannot use, if that is all there is. */
export function unusablePad(): PadLike | null {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
  try {
    for (const pad of navigator.getGamepads()) {
      if (pad && pad.connected && pad.mapping !== 'standard') return pad;
    }
  } catch {
    // See activePad.
  }
  return null;
}

/** A pad's name without the vendor and product numbers browsers append. */
export function padName(pad: PadLike): string {
  const name = pad.id
    .replace(/\((?:STANDARD GAMEPAD\s*)?Vendor:.*?\)/i, '')
    .replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '')
    .trim();
  return name || 'Controller';
}
