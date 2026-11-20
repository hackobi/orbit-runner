import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DebugHook } from '../../src/client/debugHook.ts';
import { SIM } from '../../src/shared/constants.ts';
import { placeShip, waitForEmptyRoom } from './support.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
    __fortPad?: { held: boolean };
  }
}

// The way into the fort and out again, in a real page. This suite's server
// has no SpaceFort behind it, so the fort's own panels say it is not
// connected; what is tested is the transition: one press in, the ship held
// back while the pilot is there, one press out and flying.

/** The longest the page may take to show the fort after the press (the proposal's gate). */
const OPEN_WITHIN_MS = 150;
/** The longest from Launch to a ship in space, when no respawn time is still owed. */
const FLYING_WITHIN_MS = 300;

const start = async (page: Page): Promise<number> => {
  await waitForEmptyRoom();
  await page.goto('/');
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  await expect(page.locator('#hull')).toHaveText('Hull 100');
  return page.evaluate(() => window.__orbit?.status().playerId ?? -1);
};

const crash = async (page: Page, id: number): Promise<void> => {
  await placeShip(id, { x: 0, y: 0, z: SIM.planetRadius - 100, invulnTicks: 0 });
  await expect(page.locator('#death')).toBeVisible();
};

/**
 * Presses Tab inside the page and returns how long the page took to reach
 * `done`, by the page's own clock, with one more frame for the paint.
 */
const pressTab = (page: Page, done: 'fort-shown' | 'flying'): Promise<number> =>
  page.evaluate(
    (wanted) =>
      new Promise<number>((resolve) => {
        const started = performance.now();
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: 'Tab',
            key: 'Tab',
            bubbles: true,
            cancelable: true,
          }),
        );
        const reached = (): boolean =>
          wanted === 'fort-shown'
            ? document.getElementById('fort')?.hidden === false
            : document.getElementById('hull')?.textContent === 'Hull 100' &&
              document.getElementById('death')?.hidden === true;
        const check = (): void => {
          if (reached()) {
            requestAnimationFrame(() => {
              resolve(performance.now() - started);
            });
          } else requestAnimationFrame(check);
        };
        check();
      }),
    done,
  );

const problemsOf = (page: Page): string[] => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  return problems;
};

test('one press into the fort, the ship is held back, one press out and flying', async ({
  page,
}) => {
  const problems = problemsOf(page);
  let fortRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/fort') fortRequests += 1;
  });
  const id = await start(page);
  await expect(page.locator('#fort')).toBeHidden();

  // Tab does nothing to a pilot who is flying: the fort is not a way out of a fight.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  await expect(page.locator('#fort')).toBeHidden();
  await expect(page.locator('#hull')).toHaveText('Hull 100');

  await crash(page, id);
  await expect(page.locator('#death-fort')).toBeVisible();

  const openMs = await pressTab(page, 'fort-shown');
  console.log(`press to fort shown: ${openMs.toFixed(0)} ms (limit ${OPEN_WITHIN_MS})`);
  expect(openMs).toBeLessThanOrEqual(OPEN_WITHIN_MS);
  await expect(page.locator('#fort')).toBeVisible();
  await expect(page.locator('#fort-launch')).toBeVisible();
  // The cockpit's instruments are put away, and the death screen with them.
  await expect(page.locator('#death')).toBeHidden();
  await expect(page.locator('#gauges')).toBeHidden();
  // What the sortie earned is on the card.
  await expect(page.locator('#fort-debrief-title')).toHaveText('Sortie report');
  await expect(page.locator('#fort-debrief-lines')).toContainText('Flown');
  await expect(page.locator('#fort-pilot')).toContainText('1');
  // No fort behind this server, and the screen says so in words.
  await expect(page.locator('#fort-state')).toContainText('no fort connected');

  // Well past the three seconds a ship takes to come back: it is being held.
  await page.waitForTimeout(5000);
  await expect(page.locator('#fort')).toBeVisible();
  await expect(page.locator('#hull')).toHaveText('Hull 0');

  const flyingMs = await pressTab(page, 'flying');
  console.log(`launch to flying: ${flyingMs.toFixed(0)} ms (limit ${FLYING_WITHIN_MS})`);
  expect(flyingMs).toBeLessThanOrEqual(FLYING_WITHIN_MS);
  await expect(page.locator('#fort')).toBeHidden();
  await expect(page.locator('#gauges')).toBeVisible();
  await expect(page.locator('#hull')).toHaveText('Hull 100');

  // Once when the game connected and once when the screen opened; never once a frame.
  expect(fortRequests).toBeGreaterThanOrEqual(1);
  expect(fortRequests).toBeLessThanOrEqual(3);

  expect(problems).toEqual([]);
});

test('the buttons on screen do the same, and a pilot who never presses flies again by themselves', async ({
  page,
}) => {
  const problems = problemsOf(page);
  const id = await start(page);

  // Left alone, the death screen is what it always was: back in three seconds.
  await crash(page, id);
  await expect(page.locator('#death')).toBeHidden({ timeout: 6000 });
  await expect(page.locator('#fort')).toBeHidden();
  await expect(page.locator('#hull')).toHaveText('Hull 100');

  await crash(page, id);
  await page.locator('#death-fort').click();
  await expect(page.locator('#fort')).toBeVisible();
  // A fire key held through the death must not launch: the button is not focused.
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await expect(page.locator('#fort')).toBeVisible();

  await page.waitForTimeout(3200);
  await page.locator('#fort-launch').click();
  await expect(page.locator('#fort')).toBeHidden();
  await expect(page.locator('#hull')).toHaveText('Hull 100');

  expect(problems).toEqual([]);
});

test("a controller's View button or touchpad goes in and comes out", async ({ page }) => {
  await page.addInitScript(() => {
    window.__fortPad = { held: false };
    navigator.getGamepads = () => [
      {
        id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
        index: 0,
        connected: true,
        mapping: 'standard',
        timestamp: performance.now(),
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 18 }, (_, index) => {
          const value = index === 17 && window.__fortPad?.held ? 1 : 0;
          return { pressed: value === 1, touched: value === 1, value };
        }),
      } as unknown as Gamepad,
      null,
      null,
      null,
    ];
  });
  const press = async (): Promise<void> => {
    await page.evaluate(() => {
      if (window.__fortPad) window.__fortPad.held = true;
    });
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      if (window.__fortPad) window.__fortPad.held = false;
    });
    await page.waitForTimeout(120);
  };
  const id = await start(page);
  await crash(page, id);
  await press();
  await expect(page.locator('#fort')).toBeVisible();
  // Held down, it is one press, not one a frame.
  await page.waitForTimeout(3500);
  await expect(page.locator('#fort')).toBeVisible();
  await press();
  await expect(page.locator('#fort')).toBeHidden();
  await expect(page.locator('#hull')).toHaveText('Hull 100');
});

test('a pilot whose ship was lost while the tab was hidden comes back to the fort', async ({
  page,
}) => {
  const setHidden = (hidden: boolean): Promise<void> =>
    page.evaluate((value) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (value ? 'hidden' : 'visible'),
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

  await start(page);
  await setHidden(true);
  // Ten seconds away and the ship is destroyed.
  await page.waitForTimeout(12_000);
  await setHidden(false);
  await expect(page.locator('#fort')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#fort-debrief-title')).toHaveText('While you were away');
  // And it stays: nothing brings the ship back until the pilot says.
  await page.waitForTimeout(4000);
  await expect(page.locator('#fort')).toBeVisible();
  await page.locator('#fort-launch').click();
  await expect(page.locator('#fort')).toBeHidden();
  await expect(page.locator('#hull')).toHaveText('Hull 100');
});

test('a page reloaded in the fort opens in the fort', async ({ page }) => {
  const id = await start(page);
  await crash(page, id);
  await page.keyboard.press('Tab');
  await expect(page.locator('#fort')).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  await expect(page.locator('#fort')).toBeVisible({ timeout: 5000 });
  expect(await page.evaluate(() => window.__orbit?.status().playerId)).toBe(id);
  await page.keyboard.press('Tab');
  await expect(page.locator('#fort')).toBeHidden();
  await expect(page.locator('#hull')).toHaveText('Hull 100', { timeout: 6000 });
});
