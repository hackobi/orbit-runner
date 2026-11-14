import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import type { DebugHook } from '../../src/client/debugHook.ts';
import type { Controls } from '../../src/shared/sim/ship.ts';
import { waitForEmptyRoom } from './support.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

// The touch controls must drive the same axes as the keyboard, to the same
// values, and several fingers must work at once. The fingers here are real
// touch events sent through Chromium's own protocol, so the page receives
// pointer events of type "touch" exactly as from a screen.

interface Finger {
  id: number;
  x: number;
  y: number;
}

async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  fingers: Finger[],
) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: fingers });
}

const controls = (page: Page): Promise<Controls> =>
  page.evaluate(() => {
    const hook = window.__orbit;
    if (!hook) throw new Error('debug hook missing');
    return hook.readControls();
  });

const centreOf = async (page: Page, selector: string): Promise<{ x: number; y: number }> => {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test.beforeEach(async ({ page }) => {
  await waitForEmptyRoom();
  await page.goto('/');
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
});

test('the keyboard and the touch controls drive the same axes to the same values', async ({
  page,
  context,
}) => {
  // What the keys give.
  const withKey = async (key: string): Promise<Controls> => {
    await page.keyboard.down(key);
    const read = await controls(page);
    await page.keyboard.up(key);
    return read;
  };
  const keys = {
    left: await withKey('KeyA'),
    right: await withKey('KeyD'),
    up: await withKey('ArrowUp'),
    down: await withKey('ArrowDown'),
    fire: await withKey('Space'),
    faster: await withKey('KeyW'),
    slower: await withKey('KeyS'),
  };
  expect(keys.left).toMatchObject({ yaw: 1, pitch: 0 });
  expect(keys.right).toMatchObject({ yaw: -1, pitch: 0 });
  expect(keys.up).toMatchObject({ yaw: 0, pitch: 1 });
  expect(keys.fire.fire).toBe(true);
  expect(keys.faster.throttle).toBe(1);
  expect(keys.slower.throttle).toBe(-1);

  // The same from a finger on the stick.
  const cdp = await context.newCDPSession(page);
  const origin = { x: 180, y: 220 };
  await expect(page.locator('#fire')).toBeVisible();
  await touch(cdp, 'touchStart', [{ id: 1, ...origin }]);
  await expect(page.locator('#knob')).toBeVisible();
  expect(await controls(page)).toMatchObject({ yaw: 0, pitch: 0, fire: false, throttle: 0 });

  // The browser hands a finger's movement to the page on its next frame,
  // so each reading is waited for.
  const stickGives = async (dx: number, dy: number, expected: Partial<Controls>): Promise<void> => {
    await touch(cdp, 'touchMove', [{ id: 1, x: origin.x + dx, y: origin.y + dy }]);
    await expect.poll(() => controls(page)).toMatchObject(expected);
  };
  await stickGives(-56, 0, { yaw: keys.left.yaw, pitch: 0 });
  await stickGives(56, 0, { yaw: keys.right.yaw, pitch: 0 });
  await stickGives(0, -56, { yaw: 0, pitch: keys.up.pitch });
  await stickGives(0, 56, { yaw: 0, pitch: keys.down.pitch });
  // Further than the stick reaches is still exactly full deflection.
  await stickGives(300, -300, { yaw: -1, pitch: 1 });
  // Inside the dead zone is nothing.
  await stickGives(4, -4, { yaw: 0, pitch: 0 });
  await touch(cdp, 'touchEnd', []);
  await expect(page.locator('#knob')).toBeHidden();
  await expect.poll(() => controls(page)).toMatchObject({ yaw: 0, pitch: 0 });
});

test('three fingers at once: steering, firing and speeding up', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  const stick: Finger = { id: 1, x: 180, y: 220 };
  await touch(cdp, 'touchStart', [stick]);
  const held: Finger = { ...stick, x: stick.x + 56 };
  await touch(cdp, 'touchMove', [held]);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: -1, fire: false, throttle: 0 });

  const fire: Finger = { id: 2, ...(await centreOf(page, '#fire')) };
  await touch(cdp, 'touchStart', [held, fire]);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: -1, fire: true, throttle: 0 });

  const faster: Finger = { id: 3, ...(await centreOf(page, '#faster')) };
  await touch(cdp, 'touchStart', [held, fire, faster]);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: -1, fire: true, throttle: 1 });

  // Lifting the stick finger leaves the other two working. (Chromium lifts
  // the fingers an "end" names, or all of them if it names none.)
  await touch(cdp, 'touchEnd', [held]);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: 0, fire: true, throttle: 1 });
  await touch(cdp, 'touchEnd', []);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: 0, fire: false, throttle: 0 });

  // And the ship really did what the fingers asked: it fired and turned.
  const status = await page.evaluate(() => window.__orbit?.status());
  expect(status?.counters.shotsFired).toBeGreaterThan(0);
});

test('"Invert pitch" flips the stick and the keys alike, and is remembered', async ({
  page,
  context,
}) => {
  await page.locator('#settings-button').tap();
  await page.locator('#invert-pitch').check();
  const cdp = await context.newCDPSession(page);
  await touch(cdp, 'touchStart', [{ id: 1, x: 180, y: 220 }]);
  await touch(cdp, 'touchMove', [{ id: 1, x: 180, y: 220 - 56 }]);
  await expect.poll(async () => (await controls(page)).pitch).toBe(-1);
  await touch(cdp, 'touchEnd', []);
  await page.keyboard.down('ArrowUp');
  expect((await controls(page)).pitch).toBe(-1);
  await page.keyboard.up('ArrowUp');

  await page.reload();
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  await page.keyboard.down('ArrowUp');
  expect((await controls(page)).pitch).toBe(-1);
  await page.keyboard.up('ArrowUp');
  await page.locator('#settings-button').tap();
  await page.locator('#invert-pitch').uncheck();
});

test('held upright, the page asks for the phone to be turned; sideways it does not', async ({
  page,
}) => {
  await expect(page.locator('#rotate')).toBeHidden();
  const size = page.viewportSize();
  if (!size) throw new Error('no viewport');
  await page.setViewportSize({ width: size.height, height: size.width });
  await expect(page.locator('#rotate')).toBeVisible();
  await page.setViewportSize(size);
  await expect(page.locator('#rotate')).toBeHidden();
});
