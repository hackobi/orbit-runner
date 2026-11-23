// Pictures for judging the stunts (decision D38) as another pilot sees them:
//   node scripts/stunts.ts <directory>
// It starts its own server and dev server and flies one browser client behind
// a second ship, which rolls and then flips. A picture is taken part of the
// way through each.

import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { createBot } from '../src/net/bot.ts';
import { startServer } from '../src/server/server.ts';
import { SIM } from '../src/shared/constants.ts';
import { STUNT_FLIP, STUNT_NONE, STUNT_ROLL_LEFT } from '../src/shared/sim/ship.ts';
import type { ShipState, Stunt } from '../src/shared/sim/ship.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/stunts.ts <directory>');

const SERVER_PORT = 8817;
const CLIENT_PORT = 5317;
process.env.ORBIT_SERVER_PORT = String(SERVER_PORT);
process.env.ORBIT_CLIENT_PORT = String(CLIENT_PORT);

const server = await startServer({ port: SERVER_PORT, seed: 5 });
const vite = await createServer();
await vite.listen();
const room = server.room;

const browser = await chromium.launch({ args: ['--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems: string[] = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
});
page.on('pageerror', (error) => problems.push(String(error)));
await page.goto(`http://localhost:${CLIENT_PORT}/`);
await page.waitForTimeout(2000);
const me = room.playerIds()[0] ?? 0;

// The other ship flies straight and does the stunt it is told to, once.
let asked: Stunt = STUNT_NONE;
const bot = createBot({
  openSocket: () => new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`),
  behaviour: () => {
    const stunt = asked;
    asked = STUNT_NONE;
    return { yaw: 0, pitch: 0, throttle: 0, fire: false, stunt };
  },
  now: () => performance.now(),
});
const botTimer = setInterval(() => {
  bot.update();
}, 1000 / 60);
await page.waitForTimeout(1500);
const other = room.playerIds().find((id) => id !== me) ?? 1;

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
    energy: SIM.maxEnergy,
    stunt: STUNT_NONE,
    stuntTicks: 0,
    stuntCooldown: 0,
    ...change,
  }));
};
/** Lines the two ships up, has the one ahead do `stunt`, and takes pictures at these moments of it. */
const watch = async (name: string, stunt: Stunt, atMs: readonly number[]): Promise<void> => {
  place(me, { x: 0, y: 10, z: 4300 });
  place(other, { x: 0, y: 12, z: 4316 });
  await page.waitForTimeout(1200);
  asked = stunt;
  let waited = 0;
  for (const [i, at] of atMs.entries()) {
    await page.waitForTimeout(at - waited);
    waited = at;
    await page.screenshot({ path: `${out}/${name}-${i + 1}.png` });
  }
  await page.waitForTimeout(1500);
};

await watch('other-rolls-left', STUNT_ROLL_LEFT, [250, 400]);
await watch('other-flips', STUNT_FLIP, [350, 650, 950]);

console.log(problems.length === 0 ? 'no console problems' : problems);
clearInterval(botTimer);
bot.close();
await browser.close();
await vite.close();
await server.close();
process.exit(0);
