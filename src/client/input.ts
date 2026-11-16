// Keyboard, mouse, touch and tilt. Every device ends up as the same two
// axes and a throttle, clamped to ±1, so no device turns faster than another.
//
// Keys are v1's (main.js:6256-6264): A / D or the arrows turn, I / K or the
// arrows pitch, W / S change speed, Space fires. New in v2: Shift boosts
// and X brakes (decision D21). The mouse control is v1's
// too (main.js:8762-8763): hold the button down and the pointer's position
// steers, at up to 0.6 of the full rate. v1 added keys and pointer together
// to as much as 1.6; here the sum is clamped.
//
// Touch: a stick appears under the first finger put down on the left of the
// screen; fire and speed are buttons on the right. Each control follows one
// finger by its pointer id, so they work together. The speed buttons carry
// boost and brake too: ▲ held at top speed boosts, and ▼ brakes.

import type { Controls } from '../shared/sim/ship.ts';
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

/** A button that is "down" while the finger that pressed it stays down. */
class HeldButton {
  down = false;
  private pointerId = -1;

  constructor(node: HTMLElement) {
    node.addEventListener('pointerdown', (event) => {
      if (this.down) return;
      this.down = true;
      this.pointerId = event.pointerId;
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
      if (event.pointerId !== this.pointerId) return;
      this.release();
      node.classList.remove('down');
    };
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });
  }

  release(): void {
    this.down = false;
    this.pointerId = -1;
  }
}

export class InputDevices {
  private readonly held = new Set<string>();
  private readonly settings: Settings;

  // Mouse: steers while its button is down.
  private mouseDown = false;
  private mouseX = 0;
  private mouseY = 0;

  // Touch stick: one finger, from where it went down.
  private stickPointer = -1;
  private stickOriginX = 0;
  private stickOriginY = 0;
  private stickX = 0;
  private stickY = 0;
  private readonly touchLayer = element('touch', HTMLDivElement);
  private readonly stick = element('stick', HTMLDivElement);
  private readonly knob = element('knob', HTMLDivElement);
  private readonly fire = new HeldButton(element('fire', HTMLButtonElement));
  private readonly faster = new HeldButton(element('faster', HTMLButtonElement));
  private readonly slower = new HeldButton(element('slower', HTMLButtonElement));

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

    window.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (KEYS.has(event.code)) {
        this.held.add(event.code);
        event.preventDefault();
      }
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
      if (this.stickPointer !== -1 || event.clientX > window.innerWidth * STICK_SIDE) return;
      this.stickPointer = event.pointerId;
      this.stickOriginX = event.clientX;
      this.stickOriginY = event.clientY;
      this.moveStick(event);
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // The stick still follows the finger while it stays over the picture.
      }
    });
    canvas.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'mouse') this.trackMouse(event);
      else if (event.pointerId === this.stickPointer) this.moveStick(event);
    });
    const up = (event: PointerEvent): void => {
      if (event.pointerType === 'mouse') this.mouseDown = false;
      else if (event.pointerId === this.stickPointer) this.releaseStick();
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });

    if (matchMedia('(pointer: coarse)').matches) this.touchLayer.hidden = false;
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
    // The stick: right turns right, as the D key; up is the Up key.
    const pitch = up - down + mousePitch - this.stickY + this.tiltPitch;
    return {
      yaw: clampAxis(left - right + mouseYaw - this.stickX + this.tiltYaw),
      pitch: clampAxis(this.settings.invertPitch ? -pitch : pitch),
      throttle: key('KeyW') - key('KeyS') + (this.faster.down ? 1 : 0) - (this.slower.down ? 1 : 0),
      fire: this.held.has('Space') || this.fire.down,
      boost:
        this.held.has('ShiftLeft') ||
        this.held.has('ShiftRight') ||
        (this.faster.down && atTopSpeed),
      brake: this.held.has('KeyX') || this.slower.down,
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

  private moveStick(event: PointerEvent): void {
    const dx = event.clientX - this.stickOriginX;
    const dy = event.clientY - this.stickOriginY;
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

  private release(): void {
    this.held.clear();
    this.mouseDown = false;
    this.releaseStick();
    this.fire.release();
    this.faster.release();
    this.slower.release();
  }
}

const KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'KeyA',
  'KeyD',
  'KeyW',
  'KeyS',
  'KeyI',
  'KeyK',
  'KeyX',
  'ShiftLeft',
  'ShiftRight',
  'Space',
]);
