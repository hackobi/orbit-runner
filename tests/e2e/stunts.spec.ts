import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DebugHook } from '../../src/client/debugHook.ts';
import { SIM } from '../../src/shared/constants.ts';
import { STUNT_FLIP, STUNT_ROLL_LEFT, STUNT_ROLL_RIGHT } from '../../src/shared/sim/ship.ts';
import { THRESHOLDS } from '../thresholds.ts';
import { waitForEmptyRoom } from './support.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

// The rolls and the backflip (decision D38), asked for with real key events.
// The ship is flown by the page's prediction and judged by the server, so a
// stunt the two disagreed about would show as a correction.

/** The stunts seen in the frames drawn so far, and the ship as it is now. */
const flown = (page: Page) =>
  page.evaluate((warmUpMs) => {
    const hook = window.__orbit;
    const first = hook?.frames[0];
    const last = hook?.frames[hook.frames.length - 1];
    if (!hook || !first || !last) throw new Error('no frames recorded');
    return {
      stunts: [...new Set(hook.frames.map((frame) => frame.predicted.stunt))],
      drawnRoll: Math.max(...hook.frames.map((frame) => Math.abs(frame.drawn.stuntRoll))),
      drawnPitch: Math.max(...hook.frames.map((frame) => Math.abs(frame.drawn.stuntPitch))),
      ship: last.predicted,
      // As the flight test: the first moments of a connection may be corrected; nothing after.
      corrections: hook.corrections.filter((c) => c.timeMs - first.timeMs > warmUpMs),
    };
  }, THRESHOLDS.warmUpMs);

const tapTwice = async (page: Page, key: string): Promise<void> => {
  await page.keyboard.press(key, { delay: 40 });
  await page.waitForTimeout(60);
  await page.keyboard.press(key, { delay: 40 });
};

test('a key pressed twice rolls the ship that way, B flips it, and the server agrees throughout', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await waitForEmptyRoom();
  await page.goto('/');
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');

  // Past the warm-up, so that every stunt is flown where a correction counts.
  await page.waitForTimeout(THRESHOLDS.warmUpMs);

  // One press, or a key held down and repeating, is only a turn.
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(900);
  await page.keyboard.up('KeyA');
  expect((await flown(page)).stunts).toEqual([0]);

  await page.waitForTimeout(500);
  await tapTwice(page, 'KeyA');
  await expect.poll(async () => (await flown(page)).stunts).toContain(STUNT_ROLL_LEFT);
  // Long enough for the roll and the pause after it.
  await page.waitForTimeout(((SIM.rollTicks + SIM.stuntCooldownTicks) / 60) * 1000 + 300);
  await tapTwice(page, 'ArrowRight');
  await expect.poll(async () => (await flown(page)).stunts).toContain(STUNT_ROLL_RIGHT);
  await page.waitForTimeout(((SIM.rollTicks + SIM.stuntCooldownTicks) / 60) * 1000 + 300);

  const before = await flown(page);
  await page.keyboard.press('KeyB');
  await expect.poll(async () => (await flown(page)).stunts).toContain(STUNT_FLIP);
  await page.waitForTimeout((SIM.flipTicks / 60) * 1000 + 600);
  const after = await flown(page);

  // The flip leaves the ship higher than it went in, and on the heading it had.
  expect(after.ship.stunt).toBe(0);
  expect(after.ship.y - before.ship.y).toBeGreaterThan(SIM.flipRise * 0.8);
  expect(after.ship.yaw).toBeCloseTo(before.ship.yaw, 6);
  // The ship was drawn turning right round, both ways.
  expect(after.drawnRoll).toBeGreaterThan(Math.PI);
  expect(after.drawnPitch).toBeGreaterThan(Math.PI);
  expect(after.corrections).toEqual([]);
  expect(problems).toEqual([]);
});
