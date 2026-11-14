// Runs the game in a real browser window on this machine's GPU and records
// everything the browser's console says, looking for the "GPU stall due to
// ReadPixels" warning v1's audit reported (DECISIONS.md 3.2):
//   node scripts/console-check.ts
// It opens a window for about forty seconds. The result goes to
// docs/results/console-headed.json.

import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { startServer } from '../src/server/server.ts';
import { writeResult } from '../tests/support/results.ts';

const SERVER_PORT = 8812;
const CLIENT_PORT = 5312;
const PLAY_MS = 30_000;
process.env.ORBIT_SERVER_PORT = String(SERVER_PORT);
process.env.ORBIT_CLIENT_PORT = String(CLIENT_PORT);

const server = await startServer({ port: SERVER_PORT });
const vite = await createServer();
await vite.listen();

// No flags: the browser picks its own renderer, as it does for a player.
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const messages: { type: string; text: string }[] = [];
page.on('console', (message) => messages.push({ type: message.type(), text: message.text() }));
page.on('pageerror', (error) => messages.push({ type: 'pageerror', text: String(error) }));

const startedAt = Date.now();
await page.goto(`http://localhost:${CLIENT_PORT}/`);
await page.waitForSelector('#hull:not(:empty)');
const loadMs = Date.now() - startedAt;

const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown',
    version: gl ? String(gl.getParameter(gl.VERSION)) : 'none',
  };
});

// Play: fly, turn and shoot among the rocks, orbs and wormholes, counting frames.
await page.evaluate(() => {
  const counter = window as unknown as { frameCount: number };
  counter.frameCount = 0;
  const tick = (): void => {
    counter.frameCount += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.keyboard.down('Space');
await page.keyboard.down('KeyW');
for (let elapsed = 0; elapsed < PLAY_MS; elapsed += 3000) {
  const key = elapsed % 6000 === 0 ? 'KeyA' : 'KeyD';
  await page.keyboard.down(key);
  await page.waitForTimeout(1500);
  await page.keyboard.up(key);
  await page.waitForTimeout(1500);
}
await page.keyboard.up('Space');
await page.keyboard.up('KeyW');
const frames = await page.evaluate(() => (window as unknown as { frameCount: number }).frameCount);

const browserVersion = browser.version();
await browser.close();
await vite.close();
await server.close();

const problems = messages.filter(
  (m) => m.type === 'warning' || m.type === 'error' || m.type === 'pageerror',
);
const readPixels = messages.filter((m) => /readpixels|gpu stall/i.test(m.text));
const result = {
  browser: `Chromium ${browserVersion}, headed`,
  renderer: gpu.renderer,
  webgl: gpu.version,
  softwareRendering: /swiftshader|llvmpipe|software/i.test(gpu.renderer),
  loadMs,
  playedSeconds: PLAY_MS / 1000,
  framesPerSecond: Math.round((frames / PLAY_MS) * 1000),
  consoleMessages: messages.length,
  warningsAndErrors: problems,
  readPixelsMessages: readPixels,
};
writeResult('console-headed', result);
console.log(JSON.stringify(result, null, 2));
process.exit(readPixels.length === 0 && !result.softwareRendering ? 0 : 1);
