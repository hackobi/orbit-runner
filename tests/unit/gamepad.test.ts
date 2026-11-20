import { describe, expect, it } from 'vitest';
import {
  PAD_DEAD_ZONE,
  activePad,
  padAxis,
  padControls,
  padName,
} from '../../src/client/gamepad.ts';
import type { PadLike } from '../../src/client/gamepad.ts';

/** A standard-layout pad at rest, with the given axes and buttons changed. */
function pad(axes: Record<number, number> = {}, buttons: Record<number, number> = {}): PadLike {
  return {
    id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
    connected: true,
    mapping: 'standard',
    axes: [0, 1, 2, 3].map((index) => axes[index] ?? 0),
    buttons: Array.from({ length: 18 }, (_, index) => {
      const value = buttons[index] ?? 0;
      return { pressed: value >= 0.5, value };
    }),
  };
}

describe('a controller stick', () => {
  it('gives nothing inside the dead zone and exactly ±1 at full travel and beyond', () => {
    expect(padAxis(0)).toBe(0);
    expect(padAxis(PAD_DEAD_ZONE)).toBe(0);
    expect(padAxis(-PAD_DEAD_ZONE * 0.9)).toBe(0);
    expect(padAxis(1)).toBe(1);
    expect(padAxis(-1)).toBe(-1);
    expect(padAxis(1.3)).toBe(1);
    expect(padAxis(Number.NaN)).toBe(0);
  });

  it('rises smoothly from the dead zone', () => {
    const justOutside = padAxis(PAD_DEAD_ZONE + 0.01);
    expect(justOutside).toBeGreaterThan(0);
    expect(justOutside).toBeLessThan(0.02);
  });
});

describe('the controller layout', () => {
  it('asks for nothing at rest, even with worn sticks', () => {
    expect(padControls(pad({ 0: 0.08, 1: -0.1, 3: 0.2 }))).toEqual({
      yaw: 0,
      pitch: 0,
      throttle: 0,
      fire: false,
      heavy: false,
      seek: false,
      boost: false,
      brake: false,
      menu: false,
      fort: false,
    });
  });

  it('steers as the keys do: stick right is the D key, stick forward is the Up key', () => {
    expect(padControls(pad({ 0: 1 })).yaw).toBe(-1);
    expect(padControls(pad({ 0: -1 })).yaw).toBe(1);
    expect(padControls(pad({ 1: -1 })).pitch).toBe(1);
    expect(padControls(pad({ 1: 1 })).pitch).toBe(-1);
  });

  it('puts each action on its own button', () => {
    const only = (button: number, value = 1): string[] =>
      Object.entries(padControls(pad({}, { [button]: value })))
        .filter(([, on]) => on === true)
        .map(([name]) => name);
    expect(only(7)).toEqual(['fire']);
    expect(only(5)).toEqual(['heavy']);
    expect(only(6)).toEqual(['seek']);
    expect(only(0)).toEqual(['boost']);
    expect(only(1)).toEqual(['brake']);
    expect(only(9)).toEqual(['menu']);
    // The fort: Create / View on any pad, and the DualSense's touchpad.
    expect(only(8)).toEqual(['fort']);
    expect(only(17)).toEqual(['fort']);
  });

  it('counts a trigger as held from a light pull, and a resting one as not', () => {
    expect(padControls(pad({}, { 7: 0.35 })).fire).toBe(true);
    expect(padControls(pad({}, { 7: 0.1 })).fire).toBe(false);
    expect(padControls(pad({}, { 6: 0.35 })).seek).toBe(true);
  });

  it('changes speed from the D-pad or the right stick, and both together cancel', () => {
    expect(padControls(pad({}, { 12: 1 })).throttle).toBe(1);
    expect(padControls(pad({}, { 13: 1 })).throttle).toBe(-1);
    expect(padControls(pad({ 3: -0.9 })).throttle).toBe(1);
    expect(padControls(pad({ 3: 0.9 })).throttle).toBe(-1);
    expect(padControls(pad({ 3: 0.9 }, { 12: 1 })).throttle).toBe(0);
  });

  it('survives a pad that reports fewer buttons and axes than the layout has', () => {
    const short: PadLike = { ...pad(), axes: [0.9], buttons: [{ pressed: true, value: 1 }] };
    expect(padControls(short)).toMatchObject({ pitch: 0, throttle: 0, boost: true, fire: false });
  });
});

describe('finding the controller', () => {
  it('finds none where there is no browser', () => {
    expect(activePad()).toBeNull();
  });

  it('shows a name without the numbers browsers add', () => {
    expect(padName(pad())).toBe('DualSense Wireless Controller');
    expect(padName({ ...pad(), id: '045e-0b13-Xbox Wireless Controller' })).toBe(
      'Xbox Wireless Controller',
    );
    expect(padName({ ...pad(), id: '' })).toBe('Controller');
  });
});
