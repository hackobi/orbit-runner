import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DebugHook } from '../../src/client/debugHook.ts';
import { skinsFor } from '../../src/client/skins.ts';
import { placeShip, waitForEmptyRoom } from './support.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

// The looks a ship can wear, in a real page: chosen in the settings panel,
// drawn by the real renderer in both of the ship's shapes, and kept in the
// browser. That each look is the right size is a unit test (skins.test.ts);
// how each one looks is for a person (scripts/skins.ts).

const playing = async (page: Page): Promise<number> => {
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  return page.evaluate(() => window.__orbit?.status().playerId ?? -1);
};

/** Waits until the game has drawn `count` more frames. */
const frames = async (page: Page, count: number): Promise<void> => {
  const from = await page.evaluate(() => window.__orbit?.frames.length ?? 0);
  await page.waitForFunction(
    ([start, more]) => (window.__orbit?.frames.length ?? 0) >= start + more,
    [from, count] as const,
  );
};

test('every look is worn the moment it is chosen and drawn without complaint, in both shapes', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  await waitForEmptyRoom();
  await page.goto('/');
  const id = await playing(page);
  await page.click('#settings-button');

  for (const form of ['saucer', 'fenix'] as const) {
    // The Fenix is the shape a ship takes after a Fenix orb; the server is told it took one.
    await placeShip(id, { fenix: form === 'fenix', invulnTicks: 6000 });
    const picker = page.locator(form === 'saucer' ? '#ship-look' : '#fenix-look');
    const offered = await picker
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(offered).toEqual(skinsFor(form).map((skin) => skin.id));
    for (const skin of offered) {
      await picker.selectOption(skin);
      // Choosing hands the keys back to the game.
      await expect(page.locator('#game')).toBeFocused();
      await frames(page, 20);
    }
  }
  expect(problems).toEqual([]);
});

test('a look is kept for the next visit, and one this build does not have is the standard look', async ({
  page,
}) => {
  await waitForEmptyRoom();
  await page.goto('/');
  await playing(page);
  await page.click('#settings-button');
  await page.selectOption('#ship-look', 'solar');
  await page.selectOption('#fenix-look', 'frostbite');

  await page.reload();
  await playing(page);
  await expect(page.locator('#ship-look')).toHaveValue('solar');
  await expect(page.locator('#fenix-look')).toHaveValue('frostbite');

  // A look for the other shape, and a look that does not exist.
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('orbit-runner.settings') ?? '{}') as object;
    localStorage.setItem(
      'orbit-runner.settings',
      JSON.stringify({ ...stored, saucerSkin: 'frostbite', fenixSkin: 'from-a-later-build' }),
    );
  });
  await page.reload();
  await playing(page);
  await expect(page.locator('#ship-look')).toHaveValue('standard');
  await expect(page.locator('#fenix-look')).toHaveValue('standard');
  await frames(page, 20);
});
