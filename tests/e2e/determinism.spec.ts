import { expect, test } from '@playwright/test';
import { runTrace } from '../support/trace.ts';

// The whole "no corrections on a clean network" design rests on this: the
// browser's JavaScript engine must produce the same simulation bits as Node.
// Chromium shares V8 with Node; WebKit runs JavaScriptCore.
test('the simulation produces the same bits here as in Node', async ({ page }) => {
  const seed = 20261113;
  const ticks = 10_000;
  const expected = runTrace(seed, ticks);

  await page.goto('/tests/e2e/fixtures/blank.html');
  const actual = await page.evaluate(
    async ([s, t]) => {
      const modulePath = '/tests/support/trace.ts';
      const trace = (await import(/* @vite-ignore */ modulePath)) as {
        runTrace: (seed: number, ticks: number) => { hash: number; deaths: number };
      };
      return trace.runTrace(s, t);
    },
    [seed, ticks] as const,
  );

  expect(actual.hash).toBe(expected.hash);
  expect(actual.deaths).toBe(expected.deaths);
});
