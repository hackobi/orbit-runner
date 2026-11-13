import { expect, test } from '@playwright/test';
import { SERVER_PORT } from '../../playwright.config.ts';
import type { DebugHook } from '../../src/client/debugHook.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

// One run in a browser outside the full suite: it connects, flies, sees a
// second player, and computes the simulation the same way as the server.
test('connects, flies and sees another player', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // The server holds seats for ten seconds after a disconnect; wait out
  // whoever the previous test left behind.
  for (let attempt = 0; attempt < 150; attempt++) {
    const health = (await (await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)).json()) as {
      players: number;
    };
    if (health.players === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const other = await (await browser.newContext()).newPage();
  await other.goto('/');
  await page.goto('/');
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  await other.waitForFunction(() => window.__orbit?.status().status === 'playing');

  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(4000);
  await page.keyboard.up('KeyA');
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(1000);

  const result = await page.evaluate(() => {
    const hook = window.__orbit;
    const last = hook?.frames.at(-1);
    if (!hook || !last) throw new Error('nothing recorded');
    const intervals = hook.frames.slice(1).map((f) => f.elapsedMs);
    return {
      status: hook.status(),
      webgl: !!document.createElement('canvas').getContext('webgl2'),
      framesPerSecond: (1000 * intervals.length) / intervals.reduce((sum, v) => sum + v, 0),
      topSpeed: Math.max(...hook.frames.map((f) => f.predicted.speed)),
      yawSpan:
        Math.max(...hook.frames.map((f) => f.predicted.yaw)) -
        Math.min(...hook.frames.map((f) => f.predicted.yaw)),
      remotes: last.remotes.length,
      corrections: hook.corrections.filter((c) => !c.teleport).length,
    };
  });
  console.log(
    `[firefox] ${result.framesPerSecond.toFixed(0)} frames a second, WebGL2 ${result.webgl}, ` +
      `${result.corrections} corrections, slack ${result.status.leadTicks.toFixed(2)} ticks`,
  );

  expect(errors).toEqual([]);
  expect(result.webgl).toBe(true);
  expect(result.status.status).toBe('playing');
  expect(result.topSpeed).toBeGreaterThan(40);
  expect(result.yawSpan).toBeGreaterThan(1);
  expect(result.remotes).toBe(1);
  expect(result.corrections).toBe(0);
  await other.context().close();
});
