import { expect, test } from '@playwright/test';
import type { DebugHook } from '../../src/client/debugHook.ts';
import { THRESHOLDS } from '../thresholds.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

const FLIGHT_MS = 20_000;

test('one client connects, flies by keyboard, and is never corrected', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  const consoleProblems: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      consoleProblems.push(message.text());
  });

  await page.goto('/');
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  const start = await page.evaluate(() => {
    const hook = window.__orbit;
    const first = hook?.frames[0];
    if (!hook || !first) throw new Error('no frames recorded');
    return { timeMs: first.timeMs, x: first.predicted.x, z: first.predicted.z };
  });

  // Fly a pattern with real key events: speed up, turn left, climb, turn right, slow down.
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
    await page.keyboard.down('KeyW');
    await hold('KeyD', 1200);
    await hold('ArrowLeft', 2200);
    await page.keyboard.up('KeyW');
  })();
  await Promise.all([flight, page.waitForTimeout(FLIGHT_MS)]);

  const result = await page.evaluate((warmUpMs) => {
    const hook = window.__orbit;
    if (!hook) throw new Error('debug hook missing');
    const frames = hook.frames;
    const first = frames[0];
    const last = frames[frames.length - 1];
    if (!first || !last) throw new Error('no frames recorded');
    const intervals = frames
      .slice(1)
      .map((f) => f.elapsedMs)
      .sort((a, b) => a - b);
    const at = (q: number): number => intervals[Math.floor(q * (intervals.length - 1))] ?? 0;
    const yaws = frames.map((f) => f.predicted.yaw);
    const speeds = frames.map((f) => f.predicted.speed);
    return {
      status: hook.status(),
      frames: frames.length,
      seconds: (last.timeMs - first.timeMs) / 1000,
      frameMs: { p50: at(0.5), p99: at(0.99), max: at(1) },
      // When the longest frame happened, in seconds after the first frame.
      worstFrameAtS:
        (frames.slice(1).reduce((worst, f) => (f.elapsedMs > worst.elapsedMs ? f : worst), first)
          .timeMs -
          first.timeMs) /
        1000,
      corrections: hook.corrections,
      correctionsAfterWarmUp: hook.corrections.filter((c) => c.timeMs - first.timeMs > warmUpMs),
      snapshots: hook.snapshots.length,
      missedInputs: hook.snapshots.reduce((sum, s) => sum + s.missedInputs, 0),
      yawSpan: Math.max(...yaws) - Math.min(...yaws),
      topSpeed: Math.max(...speeds),
      end: { x: last.predicted.x, z: last.predicted.z },
      // The server's newest state and the prediction for that same tick agree.
      ackedAlive: last.acked?.alive,
    };
  }, THRESHOLDS.warmUpMs);

  await page.screenshot({ path: testInfo.outputPath('flight.png') });
  const canvasHasPicture = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return !!canvas && canvas.width > 0 && canvas.height > 0;
  });

  console.log(
    `[${testInfo.project.name}] ${result.frames} frames in ${result.seconds.toFixed(1)} s ` +
      `(frame ms p50 ${result.frameMs.p50.toFixed(1)}, p99 ${result.frameMs.p99.toFixed(1)}, ` +
      `max ${result.frameMs.max.toFixed(1)} at ${result.worstFrameAtS.toFixed(1)} s); ${result.snapshots} snapshots; ` +
      `${result.corrections.length} corrections (${result.correctionsAfterWarmUp.length} after warm-up); ` +
      `server missed ${result.missedInputs} inputs; rtt ${result.status.rttMs.toFixed(1)} ms; ` +
      `slack ${result.status.leadTicks.toFixed(2)} ticks`,
  );

  expect(pageErrors).toEqual([]);
  expect(consoleProblems).toEqual([]);
  expect(canvasHasPicture).toBe(true);
  expect(result.status.status).toBe('playing');
  expect(result.ackedAlive).toBe(true);

  // It really flew: it turned both ways, changed speed, and covered ground.
  expect(result.yawSpan).toBeGreaterThan(1.5);
  expect(result.topSpeed).toBeGreaterThan(40);
  expect(Math.hypot(result.end.x - start.x, result.end.z - start.z)).toBeGreaterThan(100);
  expect(result.snapshots).toBeGreaterThan((FLIGHT_MS / 1000) * 28);

  // The acceptance check: no correction above the threshold once warm.
  const tooLarge = result.correctionsAfterWarmUp.filter(
    (c) => !c.teleport && c.distance > THRESHOLDS.cleanCorrectionMax,
  );
  expect(tooLarge).toEqual([]);
  // Stricter than the threshold, and expected on a local server: none at all.
  expect(result.correctionsAfterWarmUp).toEqual([]);
});
