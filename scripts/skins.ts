// Pictures for judging the looks a ship can wear:
//   node scripts/skins.ts <directory> [webkit] [only=<look>,<look>]
// It starts its own server and dev server, flies one browser client, and for
// every look and both shapes takes the player's own ship as it is flown (the
// look chosen in the settings panel, as a player would) and another ship
// close by and side-on. Then a fight with every bot in a different look, and
// one sheet with all of it.

import { writeFileSync } from 'node:fs';
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { createBot } from '../src/net/bot.ts';
import { circler } from '../src/net/behaviours.ts';
import { skinsFor } from '../src/client/skins.ts';
import type { Looks, ShipForm } from '../src/client/skins.ts';
import type { DebugHook } from '../src/client/debugHook.ts';
import { startServer } from '../src/server/server.ts';
import { SIM } from '../src/shared/constants.ts';
import type { ShipState } from '../src/shared/sim/ship.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/skins.ts <directory> [webkit]');
// Safari's engine instead of Chrome's.
const safari = process.argv.includes('webkit');
/** Some looks only, while one is being worked on. The sheet then holds only those. */
const only = process.argv
  .find((word) => word.startsWith('only='))
  ?.slice(5)
  .split(',');
const BOTS = 14;

const SERVER_PORT = 8813;
const CLIENT_PORT = 5313;
process.env.ORBIT_SERVER_PORT = String(SERVER_PORT);
process.env.ORBIT_CLIENT_PORT = String(CLIENT_PORT);
// Dressing another player's ship is done through the test hook.
process.env.VITE_TEST_HOOKS = '1';

const server = await startServer({ port: SERVER_PORT, seed: 5 });
const vite = await createServer();
await vite.listen();
const room = server.room;

const browser = safari
  ? await webkit.launch()
  : await chromium.launch({ args: ['--use-angle=metal'] });
// Two pixels to a point, as a phone or a Mac draws.
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 2,
});
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
    behaviour: circler(0.25 + (i % 5) * 0.08, false),
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
const clearBots = (): void => {
  for (const [i, id] of others.entries()) place(id, { x: 6000 + i * 40, y: 900, z: -6000 });
};
const suffix = safari ? '-webkit' : '';
const shot = async (
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<string> => {
  const path = `${out}/${name}${suffix}.png`;
  await page.screenshot({ path, ...(clip ? { clip } : {}) });
  return path;
};
/** Chooses a look in the settings panel, as a player would. */
const wear = async (form: ShipForm, skin: string): Promise<void> => {
  await page.click('#settings-button');
  await page.selectOption(form === 'saucer' ? '#ship-look' : '#fenix-look', skin);
  await page.click('#settings-button');
};
const dress = (id: number, looks: Looks): Promise<void> =>
  page.evaluate(([shipId, wanted]) => window.__orbit?.dress(shipId, wanted), [id, looks] as const);

/** The part of the picture the player's own ship is in, and the part the ship beside it is in. */
const OWN = { x: 400, y: 250, width: 480, height: 330 };
const CLOSE = { x: 400, y: 120, width: 480, height: 330 };

interface Row {
  name: string;
  tier: string;
  form: ShipForm;
  own: string;
  close: string;
}
const rows: Row[] = [];
for (const form of ['saucer', 'fenix'] as const) {
  for (const skin of skinsFor(form)) {
    if (only && !only.includes(skin.id)) continue;
    const looks: Looks = { saucer: 'standard', fenix: 'standard', [form]: skin.id };
    const fenix = form === 'fenix';
    await wear(form, skin.id);
    await dress(other, looks);
    clearBots();
    // Flying along the belt, as it is seen in play.
    place(me, { x: 0, y: 10, z: 4300, speed: 40, targetSpeed: 40, fenix });
    await page.waitForTimeout(900);
    const own = await shot(`${form}-${skin.id}-own`, OWN);
    // Slow, with the other ship close ahead and turned side-on.
    place(me, { x: 0, y: 10, z: 4300, fenix });
    place(other, {
      x: fenix ? 5 : 3,
      y: fenix ? 15 : 13.5,
      z: fenix ? 4322 : 4314,
      yaw: 2.2,
      pitch: 0.35,
      roll: -0.25,
      speed: 0,
      targetSpeed: 0,
      fenix,
    });
    await page.waitForTimeout(900);
    const close = await shot(`${form}-${skin.id}-close`, CLOSE);
    rows.push({ name: skin.name, tier: skin.tier, form, own, close });
  }
}

// A fight: every bot in a different look, half of them as the Fenix, circling the player.
const saucers = skinsFor('saucer');
const fenixes = skinsFor('fenix');
for (const [i, id] of others.entries()) {
  await dress(id, {
    saucer: saucers[i % saucers.length]?.id ?? 'standard',
    fenix: fenixes[i % fenixes.length]?.id ?? 'standard',
  });
}
await wear('saucer', 'standard');
await wear('fenix', 'standard');
const gather = (): void => {
  place(me, { x: 0, y: 14, z: 4300, pitch: 0.12, invulnTicks: 6000 });
  // Two rows ahead of the player, flying away: the ships as they are seen when chased.
  for (const [i, id] of others.entries()) {
    const row = i < saucers.length ? 0 : 1;
    const column = row === 0 ? i : i - saucers.length;
    place(id, {
      x: (column - 3) * (row === 0 ? 9 : 13),
      y: row === 0 ? 4 : 13,
      z: row === 0 ? 4332 : 4352,
      speed: 10,
      targetSpeed: 10,
      invulnTicks: 6000,
      fenix: row === 1,
    });
  }
};
gather();
await page.waitForTimeout(1200);
const fight = await shot('fight');

// One sheet with everything on it, as a page and as a picture of that page.
const file = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const cell = (row: Row): string =>
  `<figure><img src="${file(row.own)}"><img src="${file(row.close)}">` +
  `<figcaption><b>${row.name}</b> ${row.tier} · ${row.form === 'saucer' ? 'ship' : 'Fenix'}</figcaption></figure>`;
const section = (title: string, form: ShipForm): string =>
  `<h2>${title}</h2><div class="grid">${rows
    .filter((row) => row.form === form)
    .map(cell)
    .join('')}</div>`;
writeFileSync(
  `${out}/sheet${suffix}.html`,
  `<!doctype html><meta charset="utf-8"><title>Orbit Runner: ship looks</title><style>
  body { margin: 0; padding: 24px; background: #05070d; color: #dfe6f5; font: 15px system-ui; }
  h2 { margin: 28px 0 10px; font-size: 18px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  figure { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 2px; }
  figure img, .wide { width: 100%; display: block; }
  figcaption { grid-column: 1 / -1; padding: 6px 2px; }
  figcaption b { font-size: 16px; margin-right: 8px; }
</style>
${section('The ship: as flown, and close', 'saucer')}
${section('The Fenix: as flown, and close', 'fenix')}
<h2>A fight, every ship in a different look</h2><img class="wide" src="${file(fight)}">`,
);
const sheet = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await sheet.goto(`file://${out}/sheet${suffix}.html`);
// A big picture can be fetched and still not drawn: wait for every one to have its size.
await sheet.waitForFunction(() =>
  [...document.images].every((image) => image.complete && image.naturalWidth > 0),
);
for (const image of await sheet.locator('img').all()) await image.scrollIntoViewIfNeeded();
await sheet.screenshot({ path: `${out}/sheet${suffix}.png`, fullPage: true });

console.log(problems.length === 0 ? 'no console problems' : problems);
clearInterval(botTimer);
for (const bot of bots) bot.close();
await browser.close();
await vite.close();
await server.close();
process.exit(0);
