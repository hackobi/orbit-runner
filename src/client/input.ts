// Keyboard, mouse, touch and tilt. Every device ends up as the same two
// axes and a throttle, clamped to ±1, so no device turns faster than another.
//
// Keys are v1's (main.js:6256-6264): A / D or the arrows turn, I / K or the
// arrows pitch, W / S change speed, Space fires. New in v2: Shift boosts
// and X brakes (decision D21), and E fires a heavy shot (D22).
// Q held charges the homing shot and letting go fires it (D23). The mouse control is v1's
// too (main.js:8762-8763): hold the button down and the pointer's position
// steers, at up to 0.6 of the full rate. v1 added keys and pointer together
// to as much as 1.6; here the sum is clamped.
//
// Touch: a stick appears under the first finger put down on the left of the
// screen; fire and speed are buttons on the right. Each control follows one
// finger by its pointer id, so they work together. The speed buttons carry
// boost and brake too: ▲ held at top speed boosts, and ▼ brakes.
//
// Stunts (decision D38): a direction pressed twice quickly rolls the ship
// that way, and back pressed twice flips it. That holds for the keys, the
// touch stick and a controller's stick; the mouse and tilt are left out, as
// they move by themselves. B flips too.
//
// A game controller (gamepad.ts) adds to the same sums, so it turns no faster
// than the keys do.

import { STUNT_FLIP, STUNT_NONE, STUNT_ROLL_LEFT, STUNT_ROLL_RIGHT } from '../shared/sim/ship.ts';
import type { Controls, Stunt } from '../shared/sim/ship.ts';
import { activePad, padControls } from './gamepad.ts';
import type { Settings } from './settings.ts';

const POINTER_GAIN = 0.6; // main.js:8762

/** How far the knob travels from where the finger went down, in CSS pixels. */
export const STICK_RADIUS = 56;
/** Movement within this share of the radius counts as none. */
export const STICK_DEAD_ZONE = 0.12;
/** The stick lives on this share of the screen's width, from the left. */
const STICK_SIDE = 0.6;
/** Tilting the phone this many degrees from where it was held gives full deflection. */
const TILT_RANGE_DEGREES = 25;

/** Two presses the same way within this long are a stunt. */
export const DOUBLE_TAP_MS = 350;
/** A stick counts as pressed a way past this share of its travel, and as let go under `STICK_REST`. */
const STICK_PRESSED = 0.8;
const STICK_REST = 0.4;

/** Notices the second of two quick presses in one direction. */
export class DoubleTaps {
  private last: Stunt = STUNT_NONE;
  private lastAtMs = 0;

  /** A direction was pressed afresh. The stunt, if this is the second press that way in time. */
  press(stunt: Stunt, nowMs: number): Stunt {
    if (stunt === this.last && nowMs - this.lastAtMs <= DOUBLE_TAP_MS) {
      this.last = STUNT_NONE;
      return stunt;
    }
    this.last = stunt;
    this.lastAtMs = nowMs;
    return STUNT_NONE;
  }

  clear(): void {
    this.last = STUNT_NONE;
  }
}

/** Which way a stick is pressed: left or right for the rolls, back for the flip. Positive yaw is left. */
export function stickPress(yaw: number, back: number): Stunt {
  if (back > STICK_PRESSED && back >= Math.abs(yaw)) return STUNT_FLIP;
  if (yaw > STICK_PRESSED) return STUNT_ROLL_LEFT;
  if (yaw < -STICK_PRESSED) return STUNT_ROLL_RIGHT;
  return STUNT_NONE;
}

/** The stunt a key asks for when pressed twice. */
const TAP_KEYS: Readonly<Record<string, Stunt>> = {
  ArrowLeft: STUNT_ROLL_LEFT,
  KeyA: STUNT_ROLL_LEFT,
  ArrowRight: STUNT_ROLL_RIGHT,
  KeyD: STUNT_ROLL_RIGHT,
  ArrowDown: STUNT_FLIP,
  KeyK: STUNT_FLIP,
};

const clampAxis = (value: number): number => Math.max(-1, Math.min(1, value));

/** One stick axis from a finger's offset: nothing inside the dead zone, then 0 to ±1. */
export function stickAxis(offsetPixels: number): number {
  const raw = clampAxis(offsetPixels / STICK_RADIUS);
  const size = Math.abs(raw);
  if (size <= STICK_DEAD_ZONE) return 0;
  return (Math.sign(raw) * (size - STICK_DEAD_ZONE)) / (1 - STICK_DEAD_ZONE);
}

/**
 * Steering from the phone's tilt, held sideways.
 *
 * Held sideways, rolling the phone like a steering wheel changes `beta` and
 * tipping its far edge down changes `gamma`. Which way round depends on
 * which side the top of the phone is: `screenAngle` is 90 with the top to
 * the left and 270 with it to the right. Right side down turns right
 * (negative yaw, as the D key); far edge down is the Up key.
 */
export function tiltAxes(
  beta: number,
  gamma: number,
  neutralBeta: number,
  neutralGamma: number,
  screenAngle: number,
): { yaw: number; pitch: number } {
  const side = screenAngle === 270 ? -1 : 1;
  return {
    yaw: clampAxis((-side * (beta - neutralBeta)) / TILT_RANGE_DEGREES),
    pitch: clampAxis((side * (gamma - neutralGamma)) / TILT_RANGE_DEGREES),
  };
}

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} is missing from the page`);
  return found;
}

/** A button that is "down" while a finger that pressed it stays down. */
class HeldButton {
  private readonly fingers = new Set<number>();
  private readonly node: HTMLElement;

  constructor(node: HTMLElement) {
    this.node = node;
    node.addEventListener('pointerdown', (event) => {
      this.fingers.add(event.pointerId);
      node.classList.add('down');
      // Keep the press if the finger slides off the button.
      try {
        node.setPointerCapture(event.pointerId);
      } catch {
        // Not every pointer can be captured; the press still counts.
      }
      event.preventDefault();
    });
    const up = (event: PointerEvent): void => {
      this.fingers.delete(event.pointerId);
      this.show();
    };
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });
  }

  get down(): boolean {
    return this.fingers.size > 0;
  }

  release(): void {
    this.fingers.clear();
    this.show();
  }

  /** Lets go of every finger but this one: the others are known to be gone. */
  keepOnly(pointerId: number): void {
    const held = this.fingers.has(pointerId);
    this.fingers.clear();
    if (held) this.fingers.add(pointerId);
    this.show();
  }

  private show(): void {
    this.node.classList.toggle('down', this.down);
  }
}

export class InputDevices {
  private readonly held = new Set<string>();
  private readonly settings: Settings;
  /** Called once each time the controller's menu button goes down. */
  onPadMenu: (() => void) | null = null;
  private padMenuDown = false;
  /** Called once each time the controller's fort button goes down. */
  onPadFort: (() => void) | null = null;
  private padFortDown = false;
  /** Called once each time the controller's view button (L1 / LB) goes down. */
  onPadView: (() => void) | null = null;
  private padViewDown = false;

  // Stunts: one asked for waits here until the next tick's controls are read.
  private readonly taps = new DoubleTaps();
  private stickPressed: Stunt = STUNT_NONE;
  private padStuntDown = false;
  private pendingStunt: Stunt = STUNT_NONE;

  // Mouse: steers while its button is down.
  private mouseDown = false;
  private mouseX = 0;
  private mouseY = 0;

  // Touch stick: one finger, from where it went down.
  private stickPointer = -1;
  /** The finger that went down last, and one that found the stick already taken. */
  private newestFinger = -1;
  private passedOver: { id: number; x: number; y: number } | null = null;
  private stickOriginX = 0;
  private stickOriginY = 0;
  private stickX = 0;
  private stickY = 0;
  private readonly touchLayer = element('touch', HTMLDivElement);
  private readonly stick = element('stick', HTMLDivElement);
  private readonly knob = element('knob', HTMLDivElement);
  private readonly fire = new HeldButton(element('fire', HTMLButtonElement));
  private readonly heavy = new HeldButton(element('heavy', HTMLButtonElement));
  private readonly seek = new HeldButton(element('seek', HTMLButtonElement));
  private readonly faster = new HeldButton(element('faster', HTMLButtonElement));
  private readonly slower = new HeldButton(element('slower', HTMLButtonElement));
  private readonly buttons = [this.fire, this.heavy, this.seek, this.faster, this.slower];
  private readonly canvas: HTMLCanvasElement;

  // Tilt.
  private tiltYaw = 0;
  private tiltPitch = 0;
  private neutralBeta: number | null = null;
  private neutralGamma = 0;
  private readonly onTilt = (event: DeviceOrientationEvent): void => {
    if (event.beta === null || event.gamma === null) return;
    if (this.neutralBeta === null) {
      // However the phone is being held when tilt starts is "straight ahead".
      this.neutralBeta = event.beta;
      this.neutralGamma = event.gamma;
    }
    const axes = tiltAxes(
      event.beta,
      event.gamma,
      this.neutralBeta,
      this.neutralGamma,
      screen.orientation.angle,
    );
    this.tiltYaw = axes.yaw;
    this.tiltPitch = axes.pitch;
  };

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.settings = settings;
    this.canvas = canvas;

    window.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (KEYS.has(event.code)) {
        this.held.add(event.code);
        event.preventDefault();
      }
      // A held key repeats; only a fresh press counts toward a double press.
      if (event.repeat) return;
      const tapped = TAP_KEYS[event.code];
      if (tapped !== undefined) this.ask(this.taps.press(tapped, event.timeStamp));
      else if (event.code === 'KeyB') this.ask(STUNT_FLIP);
    });
    window.addEventListener('keyup', (event) => {
      this.held.delete(event.code);
    });
    // Keys released while the window is unfocused never send keyup.
    window.addEventListener('blur', () => {
      this.release();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.release();
    });

    canvas.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') {
        this.mouseDown = true;
        canvas.setPointerCapture(event.pointerId);
        this.trackMouse(event);
        return;
      }
      // The first touch shows the touch controls, on any device that has them.
      this.touchLayer.hidden = false;
      if (event.clientX > window.innerWidth * STICK_SIDE) return;
      const finger = { id: event.pointerId, x: event.clientX, y: event.clientY };
      // One finger has the stick. Another on that side is left alone, unless
      // it turns out to be the only one there is (see `onlyFinger`).
      if (this.stickPointer === -1) this.takeStick(finger);
      else this.passedOver = finger;
    });
    canvas.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'mouse') this.trackMouse(event);
      else if (event.pointerId === this.stickPointer) this.moveStick(event.clientX, event.clientY);
    });
    const up = (event: PointerEvent): void => {
      if (event.pointerType === 'mouse') this.mouseDown = false;
      else if (event.pointerId === this.stickPointer) this.releaseStick();
      if (event.pointerId === this.passedOver?.id) this.passedOver = null;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    // A phone can take a finger for a gesture of its own and never report it
    // lifted; the stick or a button would then stay held. The browser keeps a
    // second account of the fingers, in its touch events, and that one is
    // believed: with no finger on the screen nothing touched is held, and a
    // finger that is the only one on the screen is the only one holding.
    window.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType !== 'mouse') this.newestFinger = event.pointerId;
      },
      true,
    );
    // Browsers send a finger's pointerdown before its touchstart, so by now
    // `newestFinger` is the finger this touchstart is about.
    window.addEventListener('touchstart', (event) => {
      if (event.touches.length === 1) this.onlyFinger(this.newestFinger);
    });
    const fingersGone = (event: TouchEvent): void => {
      if (event.touches.length === 0) this.releaseTouch();
    };
    window.addEventListener('touchend', fingersGone);
    window.addEventListener('touchcancel', fingersGone);
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });

    if (matchMedia('(pointer: coarse)').matches) this.touchLayer.hidden = false;
  }

  /**
   * Notices the controller's menu, fort and view buttons going down. `read` does
   * this too, but only runs while the game is being simulated; this is for
   * every frame, so the buttons work on any screen.
   */
  pollPad(): void {
    const connected = activePad();
    this.padPresses(connected ? padControls(connected) : null);
  }

  private padPresses(pad: { menu: boolean; fort: boolean; view: boolean } | null): void {
    const menu = pad?.menu ?? false;
    if (menu && !this.padMenuDown) this.onPadMenu?.();
    this.padMenuDown = menu;
    const fort = pad?.fort ?? false;
    if (fort && !this.padFortDown) this.onPadFort?.();
    this.padFortDown = fort;
    const view = pad?.view ?? false;
    if (view && !this.padViewDown) this.onPadView?.();
    this.padViewDown = view;
  }

  private ask(stunt: Stunt): void {
    if (stunt !== STUNT_NONE) this.pendingStunt = stunt;
  }

  /** The touch stick and a controller: a direction pressed twice, or the controller's own stunt buttons. */
  private stickStunts(pad: { yaw: number; pitch: number; stunt: Stunt } | null): void {
    const yaw = -this.stickX + (pad?.yaw ?? 0);
    const back = this.stickY - (pad?.pitch ?? 0);
    const pressed = stickPress(yaw, back);
    if (pressed !== STUNT_NONE && pressed !== this.stickPressed) {
      this.stickPressed = pressed;
      this.ask(this.taps.press(pressed, performance.now()));
    } else if (Math.abs(yaw) < STICK_REST && back < STICK_REST) {
      this.stickPressed = STUNT_NONE;
    }
    const button = pad?.stunt ?? STUNT_NONE;
    if (button !== STUNT_NONE && !this.padStuntDown) this.ask(button);
    this.padStuntDown = button !== STUNT_NONE;
  }

  /**
   * The controls as they stand right now. `atTopSpeed` says the ship's
   * throttle is fully open, which is when a held ▲ becomes the boost.
   */
  read(atTopSpeed = false): Controls {
    const key = (code: string): number => (this.held.has(code) ? 1 : 0);
    const left = key('ArrowLeft') + key('KeyA') > 0 ? 1 : 0;
    const right = key('ArrowRight') + key('KeyD') > 0 ? 1 : 0;
    const up = key('ArrowUp') + key('KeyI') > 0 ? 1 : 0;
    const down = key('ArrowDown') + key('KeyK') > 0 ? 1 : 0;
    // v1's mouse: the pointer's place on screen steers, and it reads as
    // dragging the view (decision D12).
    const mouseYaw = this.mouseDown ? this.mouseX * POINTER_GAIN : 0;
    const mousePitch = this.mouseDown ? -this.mouseY * POINTER_GAIN : 0;
    // A controller is read afresh on every call: it has no events for sticks.
    const connected = activePad();
    const pad = connected ? padControls(connected) : null;
    this.padPresses(pad);
    this.stickStunts(pad);
    const stunt = this.pendingStunt;
    this.pendingStunt = STUNT_NONE;
    // The stick: right turns right, as the D key; up is the Up key.
    const pitch = up - down + mousePitch - this.stickY + this.tiltPitch + (pad?.pitch ?? 0);
    return {
      yaw: clampAxis(left - right + mouseYaw - this.stickX + this.tiltYaw + (pad?.yaw ?? 0)),
      pitch: clampAxis(this.settings.invertPitch ? -pitch : pitch),
      throttle:
        key('KeyW') -
        key('KeyS') +
        (this.faster.down ? 1 : 0) -
        (this.slower.down ? 1 : 0) +
        (pad?.throttle ?? 0),
      fire: this.held.has('Space') || this.fire.down || (pad?.fire ?? false),
      heavy: this.held.has('KeyE') || this.heavy.down || (pad?.heavy ?? false),
      seek: this.held.has('KeyQ') || this.seek.down || (pad?.seek ?? false),
      boost:
        this.held.has('ShiftLeft') ||
        this.held.has('ShiftRight') ||
        (this.faster.down && atTopSpeed) ||
        (pad?.boost ?? false),
      brake: this.held.has('KeyX') || this.slower.down || (pad?.brake ?? false),
      stunt,
    };
  }

  /**
   * Turns tilt steering on or off. On iOS the browser asks the player first,
   * and only when this is called from a tap. Returns whether tilt is on.
   */
  async setTilt(on: boolean): Promise<boolean> {
    window.removeEventListener('deviceorientation', this.onTilt);
    this.tiltYaw = this.tiltPitch = 0;
    this.neutralBeta = null;
    if (!on || typeof DeviceOrientationEvent === 'undefined') return false;
    const ask = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> })
      .requestPermission;
    if (ask) {
      try {
        if ((await ask.call(DeviceOrientationEvent)) !== 'granted') return false;
      } catch {
        // Asked outside a tap, or over plain HTTP.
        return false;
      }
    }
    window.addEventListener('deviceorientation', this.onTilt);
    return true;
  }

  private trackMouse(event: PointerEvent): void {
    this.mouseX = clampAxis((event.clientX / window.innerWidth) * 2 - 1);
    this.mouseY = clampAxis((event.clientY / window.innerHeight) * 2 - 1);
  }

  private takeStick(finger: { id: number; x: number; y: number }): void {
    this.stickPointer = finger.id;
    this.stickOriginX = finger.x;
    this.stickOriginY = finger.y;
    this.moveStick(finger.x, finger.y);
    try {
      this.canvas.setPointerCapture(finger.id);
    } catch {
      // The stick still follows the finger while it stays over the picture.
    }
  }

  private moveStick(x: number, y: number): void {
    const dx = x - this.stickOriginX;
    const dy = y - this.stickOriginY;
    this.stickX = stickAxis(dx);
    this.stickY = stickAxis(dy);
    // Draw the base where the finger went down and the knob under the finger.
    const reach = Math.min(1, STICK_RADIUS / Math.max(1, Math.hypot(dx, dy)));
    this.stick.hidden = false;
    this.stick.style.transform = `translate(${this.stickOriginX}px, ${this.stickOriginY}px)`;
    this.knob.style.transform = `translate(${dx * reach}px, ${dy * reach}px)`;
  }

  private releaseStick(): void {
    this.stickPointer = -1;
    this.stickX = this.stickY = 0;
    this.stick.hidden = true;
  }

  /** This finger is the only one on the screen: whatever another held is let go. */
  private onlyFinger(pointerId: number): void {
    if (this.stickPointer !== -1 && this.stickPointer !== pointerId) this.releaseStick();
    // It came down on the stick's side and was passed over for a finger that
    // was not there: the stick is its.
    if (this.passedOver?.id === pointerId && this.stickPointer === -1) {
      this.takeStick(this.passedOver);
    }
    this.passedOver = null;
    for (const button of this.buttons) button.keepOnly(pointerId);
  }

  private release(): void {
    this.held.clear();
    this.mouseDown = false;
    this.releaseTouch();
    this.taps.clear();
    this.pendingStunt = STUNT_NONE;
  }

  private releaseTouch(): void {
    this.releaseStick();
    this.passedOver = null;
    for (const button of this.buttons) button.release();
  }
}

const KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'KeyA',
  'KeyD',
  'KeyE',
  'KeyW',
  'KeyS',
  'KeyI',
  'KeyK',
  'KeyQ',
  'KeyX',
  'ShiftLeft',
  'ShiftRight',
  'Space',
]);
