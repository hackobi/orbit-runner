// Pictures and a frame-rate number for judging how the game looks:
//   node scripts/looks.ts <directory> [phone]
// It starts its own server (with the server's ships) and dev server, flies
// one browser client, stages a set of views by placing ships, and then
// measures frames a second in a crowded fight with the frame-rate limit off.
// The number compares one build with another on this machine. It says
// nothing about a real phone.

import { chromium, devices } from '@playwright/test';
import { createServer } from 'vite';
import { createBot } from '../src/net/bot.ts';
import { circler } from '../src/net/behaviours.ts';
import { startServer } from '../src/server/server.ts';
import { SIM } from '../src/shared/constants.ts';
import { FIRST_RAIDER_ID, WARLORD_ID } from '../src/shared/progress.ts';
import type { OrbKind } from '../src/shared/sim/orbs.ts';
import type { ShipState } from '../src/shared/sim/ship.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/looks.ts <directory> [phone]');
const phone = process.argv[3] === 'phone';
const BOTS = 15;

const SERVER_PORT = 8812;
const CLIENT_PORT = 5312;
process.env.ORBIT_SERVER_PORT = String(SERVER_PORT);
process.env.ORBIT_CLIENT_PORT = String(CLIENT_PORT);

const server = await startServer({ port: SERVER_PORT, seed: 5, npcs: true });
const vite = await createServer();
await vite.listen();
const room = server.room;

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
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
await page.waitForTimeout(2000);
const me = room.playerIds()[0] ?? 0;

const bots = Array.from({ length: BOTS }, (_, i) =>
  createBot({
    openSocket: () => new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`),
    behaviour: circler(0.25 + (i % 5) * 0.08, true),
    now: () => performance.now(),
  }),
);
const botTimer = setInterval(() => {
  for (const bot of bots) bot.update();
}, 1000 / 60);
await page.waitForTimeout(1500);
const others = room.playerIds().filter((id) => id !== me);
const other = others[0] ?? 1;

const place = (id: number, change: Partial<ShipState>): void => {
  room.placeShip(id, (ship) => ({
    ...ship,
    yaw: 0,
    pitch: 0,
    roll: 0,
    speed: 10,
    targetSpeed: 10,
    invulnTicks: 600,
    hp: SIM.maxHp,
    fenix: false,
    ...change,
  }));
};
/** Sends every bot far away, so a view holds only what it is about. */
const clearBots = (): void => {
  for (const [i, id] of others.entries()) place(id, { x: 6000 + i * 40, y: 900, z: -6000 });
};
const orbOf = (kind: OrbKind) => {
  const orb = room.world.orbs.orbs.find((candidate) => candidate.kind === kind);
  if (!orb) throw new Error(`no ${kind} orb`);
  return orb;
};
const shot = async (name: string, wait = 900): Promise<void> => {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}${phone ? '-phone' : ''}.png` });
};
const behind = (id: number, distance: number): void => {
  const ship = room.shipOf(id);
  if (!ship) throw new Error(`no ship ${id}`);
  place(me, {
    x: ship.x - Math.sin(ship.yaw) * distance,
    y: ship.y + 4,
    z: ship.z - Math.cos(ship.yaw) * distance,
    yaw: ship.yaw,
    speed: ship.speed,
    targetSpeed: ship.speed,
  });
};

// The own ship from behind, another close ahead and side-on, in the belt.
clearBots();
place(me, { x: 0, y: 10, z: 4300 });
place(other, { x: 7, y: 13, z: 4322, yaw: 2.2, pitch: 0.3, speed: 0, targetSpeed: 0 });
await shot('ships');

// The planet, from between it and the belt.
place(me, { x: 0, y: 500, z: 3000, yaw: Math.PI, pitch: 0.12, speed: 30, targetSpeed: 30 });
await shot('planet');

// Along the belt, at speed.
place(me, { x: 0, y: 0, z: 4400, yaw: Math.PI / 2, speed: 60, targetSpeed: 60 });
await shot('belt');

// Far out, looking back at the whole scene.
place(me, { x: 0, y: 1500, z: 8000, yaw: Math.PI, pitch: 0.18 });
await shot('far');

const boost = orbOf('boost');
place(me, { x: boost.x, y: boost.y + 3, z: boost.z - 45, speed: 12, targetSpeed: 12 });
await shot('boost-orb', 500);

const wormhole = orbOf('wormhole');
place(me, { x: wormhole.x + 3, y: wormhole.y + 2, z: wormhole.z - 40, speed: 12, targetSpeed: 12 });
await shot('wormhole', 400);

// Two Fenix ships.
place(me, { x: 0, y: 10, z: 4300, fenix: true });
place(other, {
  x: -6,
  y: 14,
  z: 4320,
  yaw: 2.4,
  pitch: 0.4,
  speed: 0,
  targetSpeed: 0,
  fenix: true,
});
await shot('fenix');
clearBots();

behind(FIRST_RAIDER_ID, 30);
await shot('raider', 400);

// The Warlock arrives 45 s after the room opens.
while (!room.shipOf(WARLORD_ID)?.alive) await page.waitForTimeout(500);
await page.waitForTimeout(600);
behind(WARLORD_ID, 55);
await shot('warlock', 400);

// A crowded fight: every bot circling and firing around the player.
const gather = (): void => {
  place(me, { x: 0, y: 10, z: 4300, invulnTicks: 6000 });
  for (const [i, id] of others.entries()) {
    const angle = (i / others.length) * Math.PI * 2;
    place(id, {
      x: Math.sin(angle) * 70,
      y: 10 + ((i % 3) - 1) * 12,
      z: 4380 + Math.cos(angle) * 70,
      yaw: angle,
      speed: 40,
      targetSpeed: 40,
      invulnTicks: 6000,
    });
  }
};
gather();
await page.keyboard.down('Space');
await page.keyboard.down('e');
await shot('fight', 1500);
await page.keyboard.up('e');

// Frames a second over five seconds of that fight, after the picture
// quality has had time to settle.
gather();
await page.waitForTimeout(12_000);
gather();
await page.waitForTimeout(500);
const fps = await page.evaluate(
  () =>
    new Promise<number>((resolve) => {
      let frames = 0;
      const start = performance.now();
      const count = (now: number): void => {
        frames += 1;
        if (now - start >= 5000) resolve((frames * 1000) / (now - start));
        else requestAnimationFrame(count);
      };
      requestAnimationFrame(count);
    }),
);
await page.keyboard.up('Space');
console.log(
  `${phone ? 'phone size' : 'desktop size'}: ${fps.toFixed(0)} frames a second, ` +
    `${others.length + 1} players and the server's ships`,
);

console.log(problems.length === 0 ? 'no console problems' : problems);
clearInterval(botTimer);
for (const bot of bots) bot.close();
await browser.close();
await vite.close();
await server.close();
process.exit(0);
