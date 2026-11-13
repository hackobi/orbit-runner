import { expect, test } from '@playwright/test';
import type { DebugHook } from '../../src/client/debugHook.ts';
import { SIM_FINGERPRINT, fusedMultiplyProbe, runTrace } from '../../src/shared/sim/fingerprint.ts';

import { writeResult } from '../support/results.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

// The whole "no corrections on a clean network" design rests on this: the
// browser's JavaScript engine must produce the same simulation bits as Node.
// Chromium shares V8 with Node; WebKit runs JavaScriptCore. The page under
// test is the minified production build, so the bundler is covered too.
test('the simulation produces the same bits here as in Node', async ({ page }) => {
  const seed = 20261113;
  const ticks = 10_000;
  const expected = runTrace(seed, ticks);

  await page.goto('/');
  await page.waitForFunction(() => window.__orbit !== undefined);
  const actual = await page.evaluate(
    ([s, t]) => {
      const hook = window.__orbit;
      if (!hook) throw new Error('debug hook missing');
      return {
        trace: hook.runTrace(s, t),
        fused: hook.fusedMultiplyProbe(2_000_000),
        fingerprint: hook.simFingerprint,
      };
    },
    [seed, ticks] as const,
  );

  writeResult(`determinism-${test.info().project.name}`, {
    browserVersion: page.context().browser()?.version() ?? 'unknown',
    traceHash: actual.trace.hash,
    nodeTraceHash: expected.hash,
    fusedMultiplyAdds: actual.fused,
    fingerprintMatchesNode: actual.fingerprint === SIM_FINGERPRINT,
  });

  expect(actual.trace.hash).toBe(expected.hash);
  expect(actual.trace.deaths).toBe(expected.deaths);
  expect(actual.trace.final).toEqual(expected.final);
  expect(actual.fused).toBe(0);
  expect(fusedMultiplyProbe(2_000_000)).toBe(0);
  expect(actual.fingerprint).toBe(SIM_FINGERPRINT);
});
