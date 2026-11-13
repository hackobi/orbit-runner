// Keyboard and pointer steering. Every device ends up as the same two axes
// and a throttle, clamped to ±1, so no device turns faster than another.
//
// Key bindings and the pointer control are v1's (main.js:6256-6263 and
// 8762-8763): hold the pointer down and its position on screen steers, at up
// to 0.6 of the full rate. v1 added keys and pointer together to as much as
// 1.6; here the sum is clamped.

import type { Controls } from '../shared/sim/ship.ts';

const POINTER_GAIN = 0.6; // main.js:8762

const clampAxis = (value: number): number => Math.max(-1, Math.min(1, value));

export class InputDevices {
  private readonly held = new Set<string>();
  private pointerDown = false;
  private pointerId = -1;
  /** Pointer position, −1..1 from the centre of the window. */
  private pointerX = 0;
  private pointerY = 0;

  constructor(canvas: HTMLCanvasElement) {
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
      if (this.pointerDown) return;
      this.pointerDown = true;
      this.pointerId = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      this.track(event);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!this.pointerDown || event.pointerId === this.pointerId) this.track(event);
    });
    const up = (event: PointerEvent): void => {
      if (event.pointerId === this.pointerId) this.pointerDown = false;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });
  }

  /** The controls as they stand right now. */
  read(): Controls {
    const key = (code: string): number => (this.held.has(code) ? 1 : 0);
    const yawKeys = key('ArrowLeft') + key('KeyA') > 0 ? 1 : 0;
    const yawKeysRight = key('ArrowRight') + key('KeyD') > 0 ? 1 : 0;
    const pitchUp = key('ArrowUp') + key('KeyI') > 0 ? 1 : 0;
    const pitchDown = key('ArrowDown') + key('KeyK') > 0 ? 1 : 0;
    const pointerYaw = this.pointerDown ? this.pointerX * POINTER_GAIN : 0;
    const pointerPitch = this.pointerDown ? -this.pointerY * POINTER_GAIN : 0;
    return {
      yaw: clampAxis(yawKeys - yawKeysRight + pointerYaw),
      pitch: clampAxis(pitchUp - pitchDown + pointerPitch),
      throttle: key('KeyW') - key('KeyS'),
    };
  }

  private track(event: PointerEvent): void {
    this.pointerX = clampAxis((event.clientX / window.innerWidth) * 2 - 1);
    this.pointerY = clampAxis((event.clientY / window.innerHeight) * 2 - 1);
  }

  private release(): void {
    this.held.clear();
    this.pointerDown = false;
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
]);
