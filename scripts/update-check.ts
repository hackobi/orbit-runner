// A real update, from one build of the client to the next, with a browser
// profile that is kept between visits:
//   node scripts/update-check.ts
//
// In Chromium: visit with build A; put build B on the server; visit again
// and see the old build keep flying with the new one waiting; destroy the
// ship and see the page load build B and come back to the same seat and
// points; visit a third time and see build B from the start.
//
// In the Mac app, pointed at the same address: four starts with one
// profile, the second after build B is on the server. (The app has no
// service worker; under Electron 45 a start with a worker's update waiting
// never finished loading.)
//
// The two builds differ in the debug hook: A has it, B does not. The result
// goes to docs/results/update-check.json.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import { preview } from 'vite';
import { startServer } from '../src/server/server.ts';
import { writeResult } from '../tests/support/results.ts';

const SERVER_PORT = 8816;
const CLIENT_PORT = 5316;
const OUT = 'dist-update-check';
const ORIGIN = `http://127.0.0.1:${CLIENT_PORT}/`;
process.env.ORBIT_SERVER_PORT = String(SERVER_PORT);
process.env.ORBIT_CLIENT_PORT = String(CLIENT_PORT);

const build = (withHook: boolean): void => {
  execFileSync('npx', ['vite', 'build', '--outDir', OUT, '--logLevel', 'error'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_TEST_HOOKS: withHook ? '1' : '0' },
  });
};

interface Seen {
  build: 'A' | 'B';
  hull: string;
  status: string;
  serviceWorkers: number;
}
const look = (page: Page): Promise<Seen> =>
  page.evaluate(async () => ({
    build: '__orbit' in window ? ('A' as const) : ('B' as const),
    hull: document.getElementById('hull')?.textContent ?? '',
    status: document.getElementById('status')?.textContent ?? '',
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
const playing = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => document.getElementById('hull')?.textContent === 'Hull 100', null, {
    timeout: 20_000,
  });

let joined = 0;
const server = await startServer({
  port: SERVER_PORT,
  listener: {
    playerJoined: () => {
      joined += 1;
    },
  },
});
const room = server.room;
build(true);
const web = await preview({
  build: { outDir: OUT },
  preview: { port: CLIENT_PORT, strictPort: true, host: '127.0.0.1' },
});

// --- Chromium -----------------------------------------------------------------

const browserProfile = mkdtempSync(join(tmpdir(), 'orbit-update-browser-'));
const visit = async <T>(during: (page: Page) => Promise<T>): Promise<T> => {
  const context = await chromium.launchPersistentContext(browserProfile, {
    args: ['--use-angle=metal'],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(ORIGIN);
  await playing(page);
  const result = await during(page);
  await context.close();
  return result;
};

const first = await visit(async (page) => {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.waitForFunction(async () => (await caches.keys()).length > 0);
  return look(page);
});

build(false);

const second = await visit(async (page) => {
  // The old build is what opens, and it is told a new one is waiting.
  await page.waitForFunction(
    () => (document.getElementById('status')?.textContent ?? '').includes('new version'),
    null,
    { timeout: 20_000 },
  );
  const whileFlying = await look(page);
  // It goes on flying for as long as the ship lives.
  await page.waitForTimeout(3000);
  const stillFlying = await look(page);

  // Then the ship is destroyed, and the page takes the moment to update.
  // (The old build has the debug hook, which says which player this page is;
  // the first visit's seat may still be held for a few seconds more.)
  const id = await page.evaluate(
    () =>
      (window as unknown as { __orbit: { status(): { playerId: number } } }).__orbit.status()
        .playerId,
  );
  room.addScore(id, 4321);
  const scoreBefore = room.scoreOf(id);
  const joinedBefore = joined;
  room.placeShip(id, (ship) => ({ ...ship, x: 0, y: 0, z: 0, invulnTicks: 0 }));
  await page.waitForFunction(() => !('__orbit' in window), null, { timeout: 15_000 });
  await playing(page);
  await page.waitForTimeout(500);
  return {
    whileFlying,
    stillFlying,
    afterTheShipWasDestroyed: await look(page),
    // The reloaded page took no new seat: it is the same player, with its points.
    sameSeat: joined === joinedBefore && room.playerIds().includes(id),
    pointsKept: room.scoreOf(id) >= scoreBefore,
  };
});

const third = await visit(look);
rmSync(browserProfile, { recursive: true, force: true });

// --- The Mac app -----------------------------------------------------------------

const appProfile = mkdtempSync(join(tmpdir(), 'orbit-update-app-'));
build(true);
const start = async (): Promise<Seen> => {
  const app = await _electron.launch({
    args: ['app/main.mjs'],
    env: {
      ...(process.env as Record<string, string>),
      ORBIT_GAME_URL: ORIGIN,
      ORBIT_USER_DATA: appProfile,
    },
  });
  const page = await app.firstWindow({ timeout: 15_000 });
  await playing(page);
  const seen = await look(page);
  await app.close();
  return seen;
};
const appStarts: Seen[] = [await start()];
build(false);
for (let i = 0; i < 3; i++) appStarts.push(await start());
rmSync(appProfile, { recursive: true, force: true });

await new Promise<void>((resolve) => {
  web.httpServer.close(() => {
    resolve();
  });
});
await server.close();
rmSync(OUT, { recursive: true, force: true });

const result = {
  browser: { first, second, third },
  macApp: { starts: appStarts },
};
writeResult('update-check', result);
console.log(JSON.stringify(result, null, 2));

const ok =
  first.build === 'A' &&
  second.whileFlying.build === 'A' &&
  second.stillFlying.build === 'A' &&
  second.afterTheShipWasDestroyed.build === 'B' &&
  second.sameSeat &&
  second.pointsKept &&
  third.build === 'B' &&
  third.status === '' &&
  appStarts.map((seen) => seen.build).join('') === 'ABBB' &&
  appStarts.every((seen) => seen.serviceWorkers === 0);
console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
