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

// Orders. The game's server is stood in for at /api/fort and /api/fort/order,
// with a small fort that answers each order as SpaceFort would, so what is
// tested is the screen: that each button sends the order it names, once, and
// that the screen then shows the fort as it stands after it.
test('orders: a crate is opened, its item worn, a point spent, and a crew member sent out and heard from in flight', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const problems = problemsOf(page);
  const gear = (worn: { id: string; name: string; rarity: string } | null) => [
    { slot: 'PRIMARY_WEAPON', item: worn },
    { slot: 'SECONDARY_WEAPON', item: null },
    { slot: 'ARMOR_SYSTEM', item: null },
    { slot: 'UTILITY_MODULE', item: null },
  ];
  const rifle = { id: 'upg_9', name: 'Rare Plasma Rifle', rarity: 'rare' };
  const fort = {
    now: Date.now(),
    currencies: { credits: 100, upgradePoints: 50, renown: 0 },
    crew: [
      {
        id: 'nft_1',
        name: 'Maya "Comet" Ranger',
        className: 'Space Recruit',
        level: 4,
        experience: 30,
        nextLevel: 150,
        state: 'ready',
        until: null as number | null,
        doing: null as string | null,
        points: 1,
        skills: [{ name: 'COMBAT', value: 12 }],
        gear: gear(null),
      },
    ],
    hold: {
      crates: [{ id: 'c'.repeat(24), tier: 'Rare', source: 'raider' }],
      itemCount: 0,
      items: [] as object[],
    },
    // A new pilot is level 1, so this bunk is open to them and the next is not.
    bunks: [
      { price: 100, level: 1 },
      { price: 400, level: 4 },
    ],
    jobs: [
      {
        id: 'task_7',
        title: 'Sweep the outer beacons',
        rarity: 'common',
        lasts: 240_000,
        cost: 0,
        pays: { credits: 30, upgradePoints: 2, experience: 40 },
        open: ['nft_1'],
      },
    ],
    reports: [{ id: 'in_1', at: Date.now(), title: 'Maya reports for duty', detail: null }],
  };
  const maya = fort.crew[0];
  if (!maya) throw new Error('the fort has no crew');
  const orders: { kind: string }[] = [];
  await page.route('**/api/fort', (route) =>
    route.fulfill({ json: { ok: true, fort: { ...fort, now: Date.now() } } }),
  );
  await page.route('**/api/fort/order', (route) => {
    const { order } = route.request().postDataJSON() as { order: { kind: string } };
    orders.push(order);
    let message = '';
    if (order.kind === 'open') {
      fort.hold.crates = [];
      fort.hold.items = [
        { ...rifle, slot: 'PRIMARY_WEAPON', bonus: 20, wornBy: null, fits: ['nft_1'] },
      ];
      fort.hold.itemCount = 1;
      message = rifle.name;
    } else if (order.kind === 'equip') {
      fort.hold.items = [
        { ...rifle, slot: 'PRIMARY_WEAPON', bonus: 20, wornBy: 'nft_1', fits: ['nft_1'] },
      ];
      maya.gear = gear(rifle);
      message = 'Rare Plasma Rifle equipped';
    } else if (order.kind === 'train') {
      maya.points = 0;
      maya.skills = [{ name: 'COMBAT', value: 13 }];
      message = 'Maya: combat +1';
    } else if (order.kind === 'send') {
      maya.state = 'mission';
      maya.until = Date.now() + 240_000;
      maya.doing = 'Sweep the outer beacons';
      fort.jobs = [];
      message = 'Maya is on the way';
    } else if (order.kind === 'recruit') {
      fort.crew.push({
        ...maya,
        id: 'nft_2',
        name: 'Ivan "Frost" Pilot',
        state: 'ready',
        until: null,
        doing: null,
        points: 6,
        gear: gear(null),
      });
      fort.bunks = fort.bunks.slice(1);
      fort.currencies = { ...fort.currencies, credits: 0 };
      message = 'Ivan "Frost" Pilot has joined your crew';
    } else if (order.kind === 'trainAll') {
      const ivan = fort.crew[1];
      if (ivan) {
        ivan.points = 0;
        ivan.skills = [{ name: 'COMBAT', value: 18 }];
      }
      message = 'Ivan: combat +6';
    }
    return route.fulfill({
      json: { ok: true, done: { ok: true, message }, fort: { ...fort, now: Date.now() } },
    });
  });

  const id = await start(page);
  await crash(page, id);
  await pressTab(page, 'fort-shown');

  // The one crew member's orders are showing without being asked for.
  const crew = page.locator('#fort-crew');
  await expect(crew.locator('.fort-pick')).toHaveAttribute('aria-expanded', 'true');
  await expect(crew).toContainText('1 skill point');
  await expect(crew).toContainText('level 4 · 30 / 150 to level 5');
  await expect(crew.locator('.fort-level i')).toHaveAttribute('style', 'width: 20%;');
  await expect(crew).toContainText(
    'about 30 credits, 2 upgrade points, 40 experience if it succeeds',
  );

  // Open the crate: what it held is said, and shown in the hold.
  const hold = page.locator('#fort-hold');
  await expect(hold).toContainText('Rare crate');
  await hold.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('#fort-state')).toHaveText(/The crate held: Rare Plasma Rifle/);
  await expect(hold.locator('li.fresh')).toContainText('Rare Plasma Rifle');
  await expect(hold.getByRole('button', { name: 'Open' })).toHaveCount(0);
  await expect(page.locator('#fort-crates')).toHaveText('0');

  // Wear it, from the keyboard: the place is kept when the list is redrawn.
  const wear = crew.getByRole('button', { name: 'Wear Rare Plasma Rifle +20' });
  await wear.focus();
  await page.keyboard.press('Enter');
  await expect(crew.getByRole('button', { name: 'Take off' })).toBeVisible();
  await expect(hold).toContainText('Worn by Maya "Comet" Ranger');
  expect(await page.evaluate(() => document.activeElement?.closest('#fort') !== null)).toBe(true);

  await crew.getByRole('button', { name: '+1', exact: true }).click();
  await expect(crew).toContainText('combat 13');
  await expect(crew.getByRole('button', { name: '+1', exact: true })).toHaveCount(0);

  await crew.getByRole('button', { name: 'Send' }).click();
  await expect(crew.locator('.status')).toContainText('On a mission');
  await expect(crew.locator('.status')).toContainText('Sweep the outer beacons');
  await expect(crew).toContainText('Busy until they are back.');

  // The next bunk is open to this pilot and paid for; the one after says what it takes.
  await expect(crew.locator('li.bunk').first()).toContainText('A recruit costs 100 credits');
  await expect(crew.locator('li.bunk').nth(1)).toHaveText('1 more bunk, at pilot level 4');
  await crew.getByRole('button', { name: 'Recruit', exact: true }).click();
  await expect(page.locator('#fort-state')).toHaveText(/Ivan "Frost" Pilot has joined your crew/);
  // The newcomer is picked out, with their orders open, and the bunk after is locked.
  await expect(crew.locator('li.fresh .fort-pick')).toHaveAttribute('aria-expanded', 'true');
  await expect(crew.locator('li.fresh')).toContainText('Ivan "Frost" Pilot');
  await expect(crew.locator('li.bunk.locked')).toContainText(
    'Opens at pilot level 4: you are level 1',
  );
  await expect(crew.getByRole('button', { name: 'Recruit', exact: true })).toHaveCount(0);
  await expect(page.locator('#fort-credits')).toHaveText('0');

  // One press spends all of the newcomer's points.
  await crew.getByRole('button', { name: 'Train +6' }).click();
  await expect(page.locator('#fort-state')).toHaveText(/Ivan: combat \+6/);
  await expect(crew.getByRole('button', { name: /Train/ })).toHaveCount(0);

  expect(orders).toEqual([
    { kind: 'open', crateId: 'c'.repeat(24) },
    { kind: 'equip', unitId: 'nft_1', itemId: 'upg_9' },
    { kind: 'train', unitId: 'nft_1', skill: 'COMBAT', points: 1 },
    { kind: 'send', unitId: 'nft_1', jobId: 'task_7' },
    { kind: 'recruit' },
    { kind: 'trainAll', unitId: 'nft_2' },
  ]);

  // Out flying, the job ends: the fort's word reaches the cockpit as a banner.
  await pressTab(page, 'flying');
  maya.state = 'ready';
  maya.until = null;
  maya.doing = null;
  fort.reports = [
    {
      id: 'in_2',
      at: Date.now(),
      title: 'Maya completed Sweep the outer beacons',
      detail: null,
    },
    ...fort.reports,
  ];
  await expect(page.locator('#banner')).toContainText('Maya completed Sweep the outer beacons', {
    timeout: 45_000,
  });
  await expect(page.locator('#fort')).toBeHidden();

  expect(problems).toEqual([]);
});

test('an order the fort refuses says why, and one that gets no answer says so', async ({
  page,
}) => {
  const fort = {
    now: Date.now(),
    currencies: { credits: 0, upgradePoints: 0, renown: 0 },
    crew: [],
    hold: {
      crates: [{ id: 'c'.repeat(24), tier: 'Common', source: 'orb' }],
      itemCount: 0,
      items: [],
    },
    bunks: [],
    jobs: [],
    reports: [],
  };
  let answer: object | null = {
    ok: true,
    done: { ok: false, message: 'No such crate in your hold' },
    fort,
  };
  let asked = 0;
  await page.route('**/api/fort', (route) => route.fulfill({ json: { ok: true, fort } }));
  await page.route('**/api/fort/order', (route) => {
    asked += 1;
    return answer ? route.fulfill({ json: answer }) : route.abort();
  });
  const id = await start(page);
  await crash(page, id);
  await pressTab(page, 'fort-shown');

  const open = page.locator('#fort-hold').getByRole('button', { name: 'Open' });
  await open.click();
  await expect(page.locator('#fort-state')).toHaveText(/No such crate in your hold/);
  await expect(page.locator('#fort-state')).toHaveClass(/refused/);
  // The crate is still there to try again.
  await expect(open).toBeVisible();

  answer = null;
  await open.click();
  await expect(page.locator('#fort-state')).toHaveText(/The fort is not answering/);
  await expect(open).toBeVisible();
  expect(asked).toBe(2);
});

test('a pilot who flies from the cockpit sees the fort without the canopy, and has it back on launching', async ({
  page,
}) => {
  const problems = problemsOf(page);
  const id = await start(page);
  await page.keyboard.press('KeyC');
  await expect(page.locator('#cockpit')).toBeVisible();

  await crash(page, id);
  await pressTab(page, 'fort-shown');
  await expect(page.locator('#fort')).toBeVisible();
  await expect(page.locator('#cockpit')).toBeHidden();

  await pressTab(page, 'flying');
  await expect(page.locator('#fort')).toBeHidden();
  await expect(page.locator('#cockpit')).toBeVisible();
  expect(problems).toEqual([]);
});

test('the first death with something waiting holds the ship and names what waits; later deaths do not', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const problems = problemsOf(page);
  const fort = {
    now: Date.now(),
    currencies: { credits: 100, upgradePoints: 50, renown: 0 },
    crew: [],
    hold: {
      crates: [{ id: 'c'.repeat(24), tier: 'Common', source: 'orb' }],
      itemCount: 0,
      items: [],
    },
    bunks: [],
    jobs: [],
    reports: [],
  };
  await page.route('**/api/fort', (route) => route.fulfill({ json: { ok: true, fort } }));
  const id = await start(page);

  // In flight the fort says, once as a banner and then beside the score, that something waits.
  await expect(page.locator('#banner')).toContainText('Your fort has work for you');
  await expect(page.locator('#banner')).toContainText('Open your crate');
  await expect(page.locator('#fort-waiting')).toHaveText('Fort · 1 waiting');

  await crash(page, id);
  await expect(page.locator('#death-fort')).toContainText('Open your crate');
  await expect(page.locator('#death-launch')).toBeVisible();
  await expect(page.locator('#death-respawn')).toHaveText('Your ship waits for your word.');
  // Well past the 3 s a ship normally takes to come back: it is still held.
  await page.waitForTimeout((SIM.respawnTicks / SIM.tickRate) * 1000 + 2000);
  await expect(page.locator('#death')).toBeVisible();
  await expect(page.locator('#fort')).toBeHidden();

  await page.locator('#death-launch').click();
  await expect(page.locator('#death')).toBeHidden();
  await expect(page.locator('#hull')).toHaveText('Hull 100');

  // The second death, with the same crate still waiting, comes back by itself.
  await crash(page, id);
  await expect(page.locator('#death-launch')).toBeHidden();
  await expect(page.locator('#death-fort')).toContainText('Open your crate');
  await expect(page.locator('#death')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#hull')).toHaveText('Hull 100');
  expect(problems).toEqual([]);
});

test('with nothing waiting, or no fort, a death is never held and the button says Fort', async ({
  page,
}) => {
  const id = await start(page);
  await expect(page.locator('#fort-waiting')).toBeHidden();
  await crash(page, id);
  await expect(page.locator('#death-fort')).toContainText('Fort');
  await expect(page.locator('#death-launch')).toBeHidden();
  await expect(page.locator('#death')).toBeHidden({ timeout: 10_000 });
});
