import { expect, test } from '@playwright/test';
import type { DebugHook } from '../../src/client/debugHook.ts';
import { SIM } from '../../src/shared/constants.ts';
import { STORE_PRICES } from '../../src/shared/scoring.ts';
import { addScore, placeShip, serverWorld, waitForEmptyRoom } from './support.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

// The store and the death screen, in a real page: what the player sees is
// what the server decided.

const points = async (page: import('@playwright/test').Page): Promise<number> =>
  Number(((await page.locator('#points').textContent()) ?? '').replace(/\D/g, ''));

test('a Zaphire orb opens the store, a key buys a repair, and a crash shows the death screen', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  await waitForEmptyRoom();
  await page.goto('/');
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  const id = await page.evaluate(() => window.__orbit?.status().playerId ?? -1);
  await expect(page.locator('#hull')).toHaveText('Hull 100');
  await expect(page.locator('#store')).toBeHidden();
  await expect(page.locator('#death')).toBeHidden();
  await expect(page.locator('#scoreboard li.me')).toContainText('You');

  // Fly through a Zaphire orb with a damaged hull. If someone took that orb
  // in the last half minute, try the next one.
  const world = await serverWorld();
  const zaphires = world.orbs.orbs.filter((orb) => orb.kind === 'zaphire');
  let open = false;
  for (const orb of zaphires.slice(0, 8)) {
    await placeShip(id, {
      x: orb.x,
      y: orb.y,
      z: orb.z - 15,
      yaw: 0,
      pitch: 0,
      speed: 30,
      targetSpeed: 30,
      hp: 40,
      // Protected from rocks for the three seconds this takes.
      invulnTicks: 180,
    });
    try {
      await page.waitForFunction(() => (window.__orbit?.status().storeTicks ?? 0) > 0, null, {
        timeout: 2500,
      });
      open = true;
      break;
    } catch {
      // Taken already. On to the next.
    }
  }
  expect(open, 'the store opened').toBe(true);
  await expect(page.locator('#store')).toBeVisible();
  await expect(page.locator('#hull')).toHaveText('Hull 40');

  // Too poor for anything: every button is dead, and the key buys nothing.
  await addScore(id, -1_000_000);
  await expect(page.locator('#store button[data-item="hp"]')).toBeDisabled();
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(700);
  await expect(page.locator('#hull')).toHaveText('Hull 40');

  // With points, the repair can be bought, and Fenix too; a full shield cannot be had twice.
  await addScore(id, 5000);
  await expect(page.locator('#store button[data-item="hp"]')).toBeEnabled();
  await expect(page.locator('#store button[data-item="fenix"]')).toBeEnabled();
  const before = await points(page);
  await page.keyboard.press('Digit1');
  await expect(page.locator('#hull')).toHaveText('Hull 100');
  await expect(page.locator('#store')).toBeHidden();
  const spent = before - (await points(page));
  // The price, less a point or two of belt income meanwhile.
  expect(spent).toBeGreaterThan(STORE_PRICES.hp - 10);
  expect(spent).toBeLessThanOrEqual(STORE_PRICES.hp);

  // Into the planet.
  await placeShip(id, { x: 0, y: 0, z: SIM.planetRadius - 100, invulnTicks: 0 });
  await expect(page.locator('#death')).toBeVisible();
  await expect(page.locator('#death-detail')).toHaveText('You flew into the planet.');
  await expect(page.locator('#death-respawn')).toContainText('Back');
  await expect(page.locator('#feed')).toContainText('You flew into the planet');
  // Three seconds later the ship is back, whole.
  await expect(page.locator('#death')).toBeHidden({ timeout: 6000 });
  await expect(page.locator('#hull')).toHaveText('Hull 100');

  expect(problems).toEqual([]);
});
