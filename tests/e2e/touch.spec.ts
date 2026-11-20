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

  // ▼ slows the ship and is the brake as well (decision D21).
  const slower: Finger = { id: 4, ...(await centreOf(page, '#slower')) };
  await touch(cdp, 'touchStart', [slower]);
  await expect.poll(() => controls(page)).toMatchObject({ throttle: -1, brake: true });
  await touch(cdp, 'touchEnd', []);
  await expect.poll(() => controls(page)).toMatchObject({ throttle: 0, brake: false });

  const heavy: Finger = { id: 5, ...(await centreOf(page, '#heavy')) };
  await touch(cdp, 'touchStart', [heavy]);
  await expect.poll(() => controls(page)).toMatchObject({ heavy: true, fire: false });
  await touch(cdp, 'touchEnd', []);
  await expect.poll(() => controls(page)).toMatchObject({ heavy: false });

  const seek: Finger = { id: 6, ...(await centreOf(page, '#seek')) };
  await touch(cdp, 'touchStart', [seek]);
  await expect.poll(() => controls(page)).toMatchObject({ seek: true, heavy: false, fire: false });
  await touch(cdp, 'touchEnd', []);
  await expect.poll(() => controls(page)).toMatchObject({ seek: false });

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

test("the settings panel stays on a phone's screen, and a finger scrolls it to its last row", async ({
  page,
  context,
}) => {
  await page.locator('#settings-button').tap();
  const screen = page.viewportSize()?.height ?? 0;
  const panel = await page.locator('#settings').boundingBox();
  expect(panel).not.toBeNull();
  expect((panel?.y ?? 0) + (panel?.height ?? 0)).toBeLessThanOrEqual(screen);
  // The panel holds more than fits: the last row starts out below its edge.
  await expect(page.locator('#claim-button')).not.toBeInViewport();

  const cdp = await context.newCDPSession(page);
  const x = (panel?.x ?? 0) + 40;
  const from = (panel?.y ?? 0) + (panel?.height ?? 0) - 30;
  await touch(cdp, 'touchStart', [{ id: 1, x, y: from }]);
  for (let moved = 10; moved <= 200; moved += 10) {
    await touch(cdp, 'touchMove', [{ id: 1, x, y: from - moved }]);
  }
  await touch(cdp, 'touchEnd', []);
  await expect(page.locator('#claim-button')).toBeInViewport({ ratio: 1 });
  // Scrolling the panel is not steering.
  expect((await controls(page)).pitch).toBe(0);
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

// On an iPhone the left stick stayed over twice in a twenty-minute session
// (2026-11-20). A phone can take a finger for a gesture of its own and never
// tell the page it lifted. These are events made in the page, so that a
// finger can go down and simply never come up.
test('a finger whose lift is never reported does not leave the stick or a button held', async ({
  page,
}) => {
  const finger = (type: string, id: number, x: number, y: number, selector = '#game') =>
    page.evaluate(
      ([kind, pointerId, clientX, clientY, target]) => {
        document.querySelector(target)?.dispatchEvent(
          new PointerEvent(kind, {
            pointerType: 'touch',
            pointerId,
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      [type, id, x, y, selector] as const,
    );
  /** The browser's own count of fingers on the screen, as its touch events give it. */
  const fingersOnScreen = (type: 'touchstart' | 'touchend', count: number) =>
    page.evaluate(
      ([kind, fingers]) => {
        const target = document.body;
        const touches = Array.from(
          { length: fingers },
          (_, identifier) => new Touch({ identifier, target }),
        );
        window.dispatchEvent(new TouchEvent(kind, { touches }));
      },
      [type, count] as const,
    );

  // A finger steers hard over, and is then lost without a word.
  await finger('pointerdown', 71, 180, 220);
  await fingersOnScreen('touchstart', 1);
  await finger('pointermove', 71, 236, 220);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: -1 });

  // The next finger down is the only one on the screen, so the stick is its,
  // from where it lands.
  await finger('pointerdown', 72, 150, 200);
  await fingersOnScreen('touchstart', 1);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: 0, pitch: 0 });
  await finger('pointermove', 72, 94, 200);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: 1 });
  // The lost finger turning up again moves nothing.
  await finger('pointermove', 71, 400, 400);
  expect(await controls(page)).toMatchObject({ yaw: 1, pitch: 0 });
  await finger('pointerup', 72, 94, 200);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: 0 });
  await expect(page.locator('#knob')).toBeHidden();

  // A lost finger on a button: the next lone finger, on another button, is
  // the only thing pressed.
  const fire = await centreOf(page, '#fire');
  const heavy = await centreOf(page, '#heavy');
  await finger('pointerdown', 73, fire.x, fire.y, '#fire');
  await fingersOnScreen('touchstart', 1);
  await expect.poll(() => controls(page)).toMatchObject({ fire: true });
  await finger('pointerdown', 74, heavy.x, heavy.y, '#heavy');
  await fingersOnScreen('touchstart', 1);
  await expect.poll(() => controls(page)).toMatchObject({ fire: false, heavy: true });
  await expect(page.locator('#fire')).not.toHaveClass(/down/);

  // And with no new finger at all: the browser saying none is left lets go
  // of everything touched.
  await finger('pointerdown', 75, 180, 220);
  await finger('pointermove', 75, 236, 220);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: -1, heavy: true });
  await fingersOnScreen('touchend', 0);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: 0, heavy: false });
  await expect(page.locator('#knob')).toBeHidden();
  await expect(page.locator('#heavy')).not.toHaveClass(/down/);
});

test('a second finger on the stick side does not take the stick from the first', async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  const thumb: Finger = { id: 1, x: 180, y: 220 };
  await touch(cdp, 'touchStart', [thumb]);
  const held: Finger = { ...thumb, x: thumb.x + 56 };
  await touch(cdp, 'touchMove', [held]);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: -1 });

  // Another finger brushes the same side, moves, and lifts.
  const stray: Finger = { id: 2, x: 90, y: 120 };
  await touch(cdp, 'touchStart', [held, stray]);
  const strayed: Finger = { ...stray, x: 20 };
  await touch(cdp, 'touchMove', [held, strayed]);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: -1 });
  await touch(cdp, 'touchEnd', [strayed]);
  // The thumb still steers.
  expect(await controls(page)).toMatchObject({ yaw: -1 });
  await touch(cdp, 'touchMove', [{ ...thumb, x: thumb.x - 56 }]);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: 1 });
  await expect(page.locator('#knob')).toBeVisible();
  await touch(cdp, 'touchEnd', []);
  await expect.poll(() => controls(page)).toMatchObject({ yaw: 0 });

  // Two fingers on one button: it stays pressed until both have lifted.
  const fire = await centreOf(page, '#fire');
  const first: Finger = { id: 3, ...fire };
  const second: Finger = { id: 4, x: fire.x + 6, y: fire.y + 6 };
  await touch(cdp, 'touchStart', [first]);
  await touch(cdp, 'touchStart', [first, second]);
  await expect.poll(() => controls(page)).toMatchObject({ fire: true });
  await touch(cdp, 'touchEnd', [first]);
  await expect.poll(() => controls(page)).toMatchObject({ fire: true });
  await touch(cdp, 'touchEnd', []);
  await expect.poll(() => controls(page)).toMatchObject({ fire: false });
});
