import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DebugHook } from '../../src/client/debugHook.ts';
import type { Controls } from '../../src/shared/sim/ship.ts';
import { waitForEmptyRoom } from './support.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
    __pad?: { axes: number[]; buttons: number[]; mapping: string; connected: boolean };
  }
}

// No test browser has a controller, so the page is given one: the browser's
// own list of pads is replaced by a single pad whose sticks and buttons the
// test sets. Everything after that list is the game's real code. What a real
// DualSense or Xbox pad reports is not covered here.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__pad = {
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => 0),
      mapping: 'standard',
      connected: false,
    };
    navigator.getGamepads = () => {
      const state = window.__pad;
      if (!state?.connected) return [null, null, null, null];
      return [
        {
          id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
          index: 0,
          connected: true,
          mapping: state.mapping,
          timestamp: performance.now(),
          axes: state.axes,
          buttons: state.buttons.map((value) => ({
            pressed: value >= 0.5,
            touched: value > 0,
            value,
          })),
        } as unknown as Gamepad,
        null,
        null,
        null,
      ];
    };
  });
  await waitForEmptyRoom();
  await page.goto('/');
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
});

const controls = (page: Page): Promise<Controls> =>
  page.evaluate(() => {
    const hook = window.__orbit;
    if (!hook) throw new Error('debug hook missing');
    return hook.readControls();
  });

const setPad = (page: Page, change: Partial<NonNullable<Window['__pad']>>): Promise<void> =>
  page.evaluate((next) => {
    if (!window.__pad) throw new Error('no fake pad');
    const was = window.__pad.connected;
    Object.assign(window.__pad, next);
    if (window.__pad.connected !== was) {
      window.dispatchEvent(
        new Event(window.__pad.connected ? 'gamepadconnected' : 'gamepaddisconnected'),
      );
    }
  }, change);

const buttons = (held: Record<number, number>): number[] =>
  Array.from({ length: 17 }, (_, index) => held[index] ?? 0);

test('a controller flies the ship, to the same values as the keys', async ({ page }) => {
  await page.locator('#settings-button').click();
  await expect(page.locator('#pad-status')).toContainText('press any button');
  await expect(page.locator('#pad-layout')).toBeHidden();

  await setPad(page, { connected: true });
  await expect(page.locator('#pad-status')).toHaveText('Controller: DualSense Wireless Controller');
  await expect(page.locator('#pad-layout')).toBeVisible();
  await expect(page.locator('#pad-layout dt')).toHaveCount(9);
  await expect(page.locator('#banner')).toContainText('DualSense Wireless Controller connected');

  // At rest it asks for nothing.
  expect(await controls(page)).toMatchObject({ yaw: 0, pitch: 0, throttle: 0, fire: false });

  // Full stick is exactly what the key gives.
  await page.keyboard.down('KeyD');
  const key = await controls(page);
  await page.keyboard.up('KeyD');
  await setPad(page, { axes: [1, 0, 0, 0] });
  expect((await controls(page)).yaw).toBe(key.yaw);

  // Stick and key together turn no faster than either alone.
  await page.keyboard.down('KeyD');
  expect((await controls(page)).yaw).toBe(-1);
  await page.keyboard.up('KeyD');

  await setPad(page, { axes: [0, -1, 0, 0], buttons: buttons({ 7: 1, 0: 1, 12: 1 }) });
  expect(await controls(page)).toMatchObject({
    yaw: 0,
    pitch: 1,
    throttle: 1,
    fire: true,
    boost: true,
    heavy: false,
    brake: false,
  });

  // Inverted pitch applies to the controller as to everything else.
  await page.locator('#invert-pitch').check();
  expect((await controls(page)).pitch).toBe(-1);
  await page.locator('#invert-pitch').uncheck();

  // The menu button closes the panel, once per press however long it is held.
  await setPad(page, { axes: [0, 0, 0, 0], buttons: buttons({ 9: 1 }) });
  await expect(page.locator('#settings')).toBeHidden();
  await page.waitForTimeout(300);
  await expect(page.locator('#settings')).toBeHidden();
  await setPad(page, { buttons: buttons({}) });
  await page.waitForTimeout(100);
  await setPad(page, { buttons: buttons({ 9: 1 }) });
  await expect(page.locator('#settings')).toBeVisible();
  await setPad(page, { buttons: buttons({}) });

  await setPad(page, { connected: false });
  await expect(page.locator('#pad-status')).toContainText('press any button');
  expect(await controls(page)).toMatchObject({ yaw: 0, pitch: 0, throttle: 0, fire: false });
});

test('a controller without the standard layout is named and left unused', async ({ page }) => {
  await page.locator('#settings-button').click();
  await setPad(page, { connected: true, mapping: '', axes: [1, 1, 0, 0] });
  await expect(page.locator('#pad-status')).toContainText('cannot be used here');
  expect(await controls(page)).toMatchObject({ yaw: 0, pitch: 0 });
});
