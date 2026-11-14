// Takes pictures of the running game for a look at the HUD and the scene:
//   node scripts/screenshot.ts <directory> [phone]
// It starts its own server and dev server, flies one browser client with a
// bot for company, and stages a few moments by placing ships on the server.

import { chromium, devices } from '@playwright/test';
import { createServer } from 'vite';
import { createBot } from '../src/net/bot.ts';
import { circler } from '../src/net/behaviours.ts';
import { startServer } from '../src/server/server.ts';
import { SIM } from '../src/shared/constants.ts';
import type { OrbKind } from '../src/shared/sim/orbs.ts';
import type { ShipState } from '../src/shared/sim/ship.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/screenshot.ts <directory> [phone]');
const phone = process.argv[3] === 'phone';

const SERVER_PORT = 8811;
const CLIENT_PORT = 5311;
process.env.ORBIT_SERVER_PORT = String(SERVER_PORT);
process.env.ORBIT_CLIENT_PORT = String(CLIENT_PORT);

const server = await startServer({ port: SERVER_PORT, seed: 5 });
const vite = await createServer();
await vite.listen();
const room = server.room;

const browser = await chromium.launch({ args: ['--use-angle=metal'] });
// The phone's screen size, touch and pixel ratio, in this desktop engine.
const profile = devices['iPhone 15 landscape'];
const iPhone = {
  viewport: profile.viewport,
  userAgent: profile.userAgent,
  deviceScaleFactor: profile.deviceScaleFactor,
  isMobile: profile.isMobile,
  hasTouch: profile.hasTouch,
};
const context = await browser.newContext(
  phone ? iPhone : { viewport: { width: 1280, height: 720 } },
);
const page = await context.newPage();
const problems: string[] = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
});
page.on('pageerror', (error) => problems.push(String(error)));
await page.goto(`http://localhost:${CLIENT_PORT}/`);
await page.waitForTimeout(2000);
const me = room.playerIds()[0] ?? 0;

const bot = createBot({
  openSocket: () => new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`),
  behaviour: circler(0.2),
  now: () => performance.now(),
});
const botTimer = setInterval(() => {
  bot.update();
}, 1000 / 60);
await page.waitForTimeout(800);
const other = room.playerIds().find((id) => id !== me) ?? 1;

const place = (id: number, change: Partial<ShipState>): void => {
  room.placeShip(id, (ship) => ({
    ...ship,
    yaw: 0,
    pitch: 0,
    roll: 0,
    speed: 10,
    targetSpeed: 10,
    invulnTicks: 250,
    hp: SIM.maxHp,
    ...change,
  }));
};
const orbOf = (kind: OrbKind) => {
  const orb = room.world.orbs.orbs.find((candidate) => candidate.kind === kind);
  if (!orb) throw new Error(`no ${kind} orb`);
  return orb;
};
const shot = async (name: string): Promise<void> => {
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${name}${phone ? '-phone' : ''}.png` });
};

// Flying in the belt with another player ahead.
place(me, { x: 0, y: 10, z: 4300, hp: 72, shield: 40 });
place(other, { x: 12, y: 14, z: 4380 });
room.addScore(me, 12_340);
room.addScore(other, 800);
await shot('flying');

// At a boost orb, about to take it.
const boost = orbOf('boost');
place(me, { x: boost.x, y: boost.y + 4, z: boost.z - 60, speed: 20, targetSpeed: 20 });
await shot('boost-orb');

// The store, opened by a Zaphire orb.
const zaphire = orbOf('zaphire');
place(me, { x: zaphire.x, y: zaphire.y, z: zaphire.z - 12, speed: 30, targetSpeed: 30, hp: 40 });
await shot('store');

// A Fenix firing, outside the combat zone.
place(me, { x: 0, y: 0, z: SIM.combatZoneRadius + 200, fenix: true, invulnTicks: 0 });
await page.keyboard.down('Space');
await shot('fenix-outside-zone');
await page.keyboard.up('Space');

// Destroyed.
place(me, { x: 0, y: 0, z: 0, invulnTicks: 0 });
await shot('destroyed');

console.log(problems.length === 0 ? 'no console problems' : problems);
clearInterval(botTimer);
bot.close();
await browser.close();
await vite.close();
await server.close();
process.exit(0);
