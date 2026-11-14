import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { CLIENT_PORT, SERVER_PORT } from '../../playwright.config.ts';
import type { DebugHook } from '../../src/client/debugHook.ts';
import { writeResult } from '../support/results.ts';
import { THRESHOLDS } from '../thresholds.ts';
import { waitForEmptyRoom } from './support.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
    /** What the app's preload script tells the page (app/preload.cjs). */
    orbitApp?: { serverUrl: string | null };
  }
}

// The Mac app, started from its source by Electron in a real window on this
// machine's display. The client it shows is the same test build the browser
// specs use, so the same debug hook reports what happened.

const FLIGHT_MS = 15_000;

// Each test gets an empty profile folder of its own, removed afterwards, so
// that a run starts from nothing and leaves nothing in the user's Library.
let profile = '';
test.beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'orbit-runner-app-'));
});
test.afterEach(() => {
  rmSync(profile, { recursive: true, force: true });
});

async function launch(
  env: Record<string, string>,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    args: ['app/main.mjs'],
    env: { ...(process.env as Record<string, string>), ORBIT_USER_DATA: profile, ...env },
  });
  const page = await app.firstWindow();
  return { app, page };
}

test('shows its packed copy of the client, connects to the configured server, and flies uncorrected', async () => {
  await waitForEmptyRoom();
  const { app, page } = await launch({
    ORBIT_CLIENT_DIR: 'dist-e2e',
    ORBIT_SERVER_URL: `ws://127.0.0.1:${SERVER_PORT}/ws`,
  });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });

  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  expect(page.url()).toBe('app://game/index.html');

  // The page is a web page: nothing of Node is within its reach, it may load
  // only its own files, and it cannot be sent anywhere else.
  const reach = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return { require: typeof w.require, process: typeof w.process, module: typeof w.module };
  });
  expect(reach).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined' });
  const policy = await page.evaluate(async () =>
    (await fetch('/index.html')).headers.get('content-security-policy'),
  );
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain(`connect-src 'self' ws://127.0.0.1:${SERVER_PORT}`);
  expect(await page.evaluate(() => window.open('https://example.com/') === null)).toBe(true);
  expect(await page.evaluate(() => window.orbitApp?.serverUrl)).toBe(
    `ws://127.0.0.1:${SERVER_PORT}/ws`,
  );
  await page.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe('app://game/index.html');
  // A file outside the client's folder is not served, however the path is
  // written, and a file that does not exist is an ordinary "not found".
  const statuses = await page.evaluate(async () => {
    const status = async (path: string): Promise<number> => (await fetch(path)).status;
    return {
      escaped: await status('/%2e%2e%2fmain.mjs'),
      escapedTwice: await status('/assets/%2e%2e%2f%2e%2e%2fpackage.json'),
      missing: await status('/no-such-file.js'),
      present: await status('/index.html'),
    };
  });
  expect(statuses).toEqual({ escaped: 404, escapedTwice: 404, missing: 404, present: 200 });
  // Those refusals were asked for; what the console says from here on counts.
  problems.length = 0;

  // Fly with real key events and measure, as the browser flight test does.
  await page.evaluate(() => window.__orbit?.clear());
  const hold = async (key: string, ms: number): Promise<void> => {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
  };
  const flight = (async () => {
    await hold('KeyW', 2500);
    await hold('KeyA', 1800);
    await hold('KeyK', 900);
    await hold('ArrowRight', 2600);
    await hold('KeyI', 900);
    await hold('KeyS', 1500);
    await hold('Space', 1500);
  })();
  await Promise.all([flight, page.waitForTimeout(FLIGHT_MS)]);

  const result = await page.evaluate((warmUpMs) => {
    const hook = window.__orbit;
    if (!hook) throw new Error('debug hook missing');
    const frames = hook.frames;
    const first = frames[0];
    const last = frames[frames.length - 1];
    if (!first || !last) throw new Error('no frames recorded');
    const intervals = frames.map((frame) => frame.elapsedMs).sort((a, b) => a - b);
    const at = (q: number): number => intervals[Math.floor(q * (intervals.length - 1))] ?? 0;
    const seconds = (last.timeMs - first.timeMs) / 1000;
    return {
      frames: frames.length,
      seconds,
      framesPerSecond: (frames.length - 1) / seconds,
      frameMsP50: at(0.5),
      frameMsP99: at(0.99),
      frameMsMax: at(1),
      corrections: hook.corrections.filter((c) => c.timeMs - first.timeMs > warmUpMs && !c.teleport)
        .length,
      largestCorrection: Math.max(0, ...hook.corrections.map((c) => (c.teleport ? 0 : c.distance))),
      moved: Math.hypot(last.predicted.x - first.predicted.x, last.predicted.z - first.predicted.z),
      shotsFired: hook.status().counters.shotsFired,
      quality: hook.status().quality,
    };
  }, THRESHOLDS.warmUpMs);
  const display = await app.evaluate(({ screen }) => {
    const primary = screen.getPrimaryDisplay();
    return {
      hertz: primary.displayFrequency,
      width: primary.size.width,
      height: primary.size.height,
      scale: primary.scaleFactor,
    };
  });
  const versions = await app.evaluate(() => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }));
  await app.close();

  console.log(
    `[mac app] Electron ${versions.electron} (Chromium ${versions.chrome}) on a ${display.hertz} Hz display: ` +
      `${result.framesPerSecond.toFixed(1)} frames a second over ${result.seconds.toFixed(1)} s ` +
      `(frame ms p50 ${result.frameMsP50.toFixed(1)}, p99 ${result.frameMsP99.toFixed(1)}, max ${result.frameMsMax.toFixed(1)}); ` +
      `${result.corrections} corrections; quality ${result.quality}`,
  );
  writeResult('macapp', { ...versions, display, ...result });

  expect(problems).toEqual([]);
  expect(result.moved).toBeGreaterThan(100);
  expect(result.shotsFired).toBeGreaterThan(3);
  // The clean-network rule from the browser suite holds here too.
  expect(result.largestCorrection).toBeLessThanOrEqual(THRESHOLDS.cleanCorrectionMax);
  // The window keeps up with the display, whatever its rate.
  expect(result.framesPerSecond).toBeGreaterThan(display.hertz * 0.9);
});

test('pointed at the address the game is served from, it shows the page from there', async () => {
  await waitForEmptyRoom();
  const origin = `http://127.0.0.1:${CLIENT_PORT}`;
  const { app, page } = await launch({ ORBIT_GAME_URL: `${origin}/` });
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  expect(new URL(page.url()).origin).toBe(origin);
  // The served page finds its own socket: the app gives it no address.
  expect(await page.evaluate(() => window.orbitApp)).toEqual({ serverUrl: null });
  // And it registers no service worker inside the app.
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
  ).toBe(0);
  // And it still cannot be sent elsewhere.
  await page.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await page.waitForTimeout(500);
  expect(new URL(page.url()).origin).toBe(origin);
  await app.close();
});
