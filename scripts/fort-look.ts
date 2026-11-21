// Takes pictures of the way into the fort and out again, and times both:
//   node scripts/fort-look.ts <directory> [phone]
// It starts its own game server and dev server and flies one browser client.
// With ORBIT_FORT_URL, ORBIT_BRIDGE_SECRET and ORBIT_FORT_ID_KEY set (a
// SpaceFort server to keep forts in) the fort is the pilot's real one, with a
// crate to open and a crew member out on a job; without them the screen says
// the fort is not connected, and that is what is pictured.

import { chromium, devices } from '@playwright/test';
import { createServer } from 'vite';
import { MemoryCrateStore } from '../src/server/crates.ts';
import { MemoryPilotStore } from '../src/server/pilots.ts';
import { startServer } from '../src/server/server.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/fort-look.ts <directory> [phone]');
const phone = process.argv[3] === 'phone';

const SERVER_PORT = 8813;
const CLIENT_PORT = 5313;
process.env.ORBIT_SERVER_PORT = String(SERVER_PORT);
process.env.ORBIT_CLIENT_PORT = String(CLIENT_PORT);
const fortUrl = process.env.ORBIT_FORT_URL;
const bridgeSecret = process.env.ORBIT_BRIDGE_SECRET;
const fortIdKey = process.env.ORBIT_FORT_ID_KEY;
const fortConnected = Boolean(fortUrl && bridgeSecret && fortIdKey);

const crates = new MemoryCrateStore();
const server = await startServer({
  port: SERVER_PORT,
  seed: 5,
  npcs: true,
  pilots: new MemoryPilotStore(),
  crates,
  ...(fortUrl ? { fortUrl } : {}),
  ...(bridgeSecret ? { bridgeSecret } : {}),
  ...(fortIdKey ? { fortIdKey } : {}),
});
const vite = await createServer();
await vite.listen();
const room = server.room;

const browser = await chromium.launch({ args: ['--use-angle=metal'] });
const profile = devices['iPhone 15 landscape'];
const context = await browser.newContext(
  phone
    ? {
        viewport: profile.viewport,
        userAgent: profile.userAgent,
        deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
      }
    : { viewport: { width: 1280, height: 720 } },
);
const page = await context.newPage();
const problems: string[] = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
});
page.on('pageerror', (error) => problems.push(String(error)));
await page.goto(`http://localhost:${CLIENT_PORT}/`);
await page.waitForTimeout(2500);
const me = room.playerIds().find((id) => id < 200) ?? 0;

const name = (label: string): string => `${out}/${phone ? 'phone-' : ''}${label}.png`;
const shot = async (label: string, settleMs = 400): Promise<void> => {
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: name(label) });
};

// With a fort behind the server: two crates won in flight, which come into the
// hold when the fort opens.
const key = await page.evaluate(() => localStorage.getItem('orbit-runner.pilot'));
if (fortConnected) {
  if (!key) throw new Error('the page kept no pilot key');
  crates.add(key, 'Rare', 'raider', 2);
  crates.add(key, 'Common', 'orb', 2);
  room.refreshCrates();
}

// A sortie worth reporting, flown in the belt, where ships are usually lost.
room.placeShip(me, (ship) => ({ ...ship, x: 2600, y: 60, z: 900, yaw: 2.2, pitch: 0, roll: 0 }));
room.addScore(me, 4200);
room.addXp(me, 600);
// Long enough for the level-up banner to have gone.
await page.waitForTimeout(6000);
room.placeShip(me, (ship) => ({ ...ship, hp: 0, alive: false, respawnTicks: 180 }));
await page.locator('#death').waitFor({ state: 'visible' });
await shot('1-destroyed', 300);
// What the death screen offers. With a fort that has something waiting, a
// pilot's first death holds the ship and names it.
const deathOffer = {
  fortButton: ((await page.locator('#death-fort-label').textContent()) ?? '').trim(),
  launchOffered: await page.locator('#death-launch').isVisible(),
  waitingInFlight: ((await page.locator('#fort-waiting').textContent()) ?? '').trim(),
};

/** Milliseconds from a press of Tab to the page showing (or hiding) the fort, as the page saw it. */
const timeToggle = (wantOpen: boolean): Promise<number> =>
  page.evaluate(
    (open) =>
      new Promise<number>((resolve) => {
        const fort = document.getElementById('fort');
        const started = performance.now();
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: 'Tab',
            key: 'Tab',
            bubbles: true,
            cancelable: true,
          }),
        );
        const check = (): void => {
          if (fort && fort.hidden !== open) {
            // One more frame: the browser has now painted it.
            requestAnimationFrame(() => {
              resolve(performance.now() - started);
            });
          } else requestAnimationFrame(check);
        };
        check();
      }),
    wantOpen,
  );

const openMs = await timeToggle(true);
await shot('2-fort-just-opened', 0);
await shot('3-fort', 2500);

// Orders, given as a player gives them: open a crate, wear what it held if it
// can be worn, send the recruit out, spend their skill points in one press.
const said: string[] = [];
if (fortConnected) {
  const press = async (name: string | RegExp): Promise<boolean> => {
    const button = page.locator('#fort').getByRole('button', { name }).first();
    if ((await button.count()) === 0) return false;
    await button.click();
    await page.waitForTimeout(700);
    said.push((await page.locator('#fort-state').textContent()) ?? '');
    return true;
  };
  await page.locator('#fort-hold').getByRole('button', { name: 'Open' }).first().waitFor();
  await press('Open');
  await shot('3a-crate-opened', 200);
  await press(/^Wear /);
  await press('Send');
  await press(/^Train \+/);
  // Affordable only if the day's challenge paid for it (spending skill points is one).
  await press(/^Recruit$/);
  await shot('3b-orders-given', 400);
}
const bunk = fortConnected
  ? ((await page.locator('#fort-crew li.bunk').first().textContent()) ?? '')
  : null;
// Longer than the three seconds a ship takes to come back: it is being held.
await page.waitForTimeout(3000);
const heldBack = !room.shipOf(me)?.alive && room.inFort(me);

const launchedAt = Date.now();
const closeMs = await timeToggle(false);
while (!room.shipOf(me)?.alive && Date.now() - launchedAt < 5000) await page.waitForTimeout(5);
const flyingMs = Date.now() - launchedAt;
await shot('4-launched', 1200);

console.log(
  JSON.stringify(
    {
      screen: phone ? 'phone' : 'desktop',
      fortConnected,
      cratesLeftAboard: key ? crates.count(key) : null,
      deathOffer,
      fortSaid: said,
      nextBunk: bunk,
      pressToFortShownMs: Math.round(openMs),
      shipHeldBackWhileInFort: heldBack,
      pressToFortHiddenMs: Math.round(closeMs),
      pressToShipFlyingMs: flyingMs,
      shipFlying: room.shipOf(me)?.alive ?? false,
      consoleProblems: problems,
    },
    null,
    2,
  ),
);

await browser.close();
await vite.close();
await server.close();
process.exit(0);
