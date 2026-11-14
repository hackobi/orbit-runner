// Runs the production build of the game in a real browser window on this
// machine's GPU and records two things a headless browser cannot tell us:
//
// - everything the browser's console says, looking for the "GPU stall due
//   to ReadPixels" warning v1's audit reported (DECISIONS.md 3.2);
// - the browser's own verdict on whether the page can be installed as an
//   app. Headless Chromium answers "no objections" for any page at all, even
//   one with no manifest, so that question is only worth asking here.
//
//   node scripts/console-check.ts
// It opens a window for about forty seconds. The result goes to
// docs/results/console-headed.json.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import { startServer } from '../src/server/server.ts';
import { writeResult } from '../tests/support/results.ts';

const SERVER_PORT = 8812;
const CLIENT_PORT = 5312;
const PLAY_MS = 30_000;
process.env.ORBIT_SERVER_PORT = String(SERVER_PORT);
process.env.ORBIT_CLIENT_PORT = String(CLIENT_PORT);

const server = await startServer({ port: SERVER_PORT });
await build({ logLevel: 'error' });
const web = await preview({ preview: { port: CLIENT_PORT, strictPort: true } });

// No flags: the browser picks its own renderer, as it does for a player. A
// profile folder of its own, because a private window may never install anything.
const profile = mkdtempSync(join(tmpdir(), 'orbit-runner-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1280, height: 720 },
});
const page = context.pages()[0] ?? (await context.newPage());
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

// Can it be installed? And, as a control, can a page with no manifest?
await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
const installErrors = async (target: typeof page): Promise<string[]> => {
  const cdp = await context.newCDPSession(target);
  const verdict = await cdp.send('Page.getInstallabilityErrors');
  return verdict.installabilityErrors.map((error) => error.errorId);
};
const gameInstallErrors = await installErrors(page);
const bare = await context.newPage();
await bare.goto(`http://127.0.0.1:${SERVER_PORT}/health`);
await bare.waitForTimeout(1000);
const bareInstallErrors = await installErrors(bare);

const browserVersion = context.browser()?.version() ?? 'unknown';
await context.close();
rmSync(profile, { recursive: true, force: true });
await new Promise<void>((resolve) => {
  web.httpServer.close(() => {
    resolve();
  });
});
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
  installabilityErrors: gameInstallErrors,
  installabilityErrorsForAPageWithNoManifest: bareInstallErrors,
};
writeResult('console-headed', result);
console.log(JSON.stringify(result, null, 2));
const installable = gameInstallErrors.length === 0 && bareInstallErrors.length > 0;
process.exit(readPixels.length === 0 && !result.softwareRendering && installable ? 0 : 1);
