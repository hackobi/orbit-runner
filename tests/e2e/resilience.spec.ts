import { expect, test } from '@playwright/test';
import { PROXY_PORT, SERVER_PORT } from '../../playwright.config.ts';
import { startProxy } from '../support/netProxy.ts';
import type { RunningProxy } from '../support/netProxy.ts';
import { THRESHOLDS } from '../thresholds.ts';
import {
  CLIENT_KINDS,
  clearRecording,
  describeMeasured,
  launchBrowsers,
  measure,
  openClient,
  placeInRing,
  placeShip,
  readRecording,
  readTruth,
  serverHealth,
  serverTick,
  setBehaviour,
  status,
  sustain,
  waitForEmptyRoom,
} from './support.ts';
import type { Browsers, Client, ClientKind } from './support.ts';

// Things going wrong, on the 100 ms profile: a tab hidden for three seconds,
// a connection cut, and a player arriving late.

let browsers: Browsers;
let proxy: RunningProxy;

test.beforeAll(async () => {
  proxy = await startProxy({ port: PROXY_PORT, target: `ws://127.0.0.1:${SERVER_PORT}/ws` });
  browsers = await launchBrowsers();
});

test.afterAll(async () => {
  await browsers.close();
  await proxy.close();
});

/**
 * Makes the page believe its tab was hidden or shown, and fires the event a
 * browser fires. This runs the game's own visibility handler; what it cannot
 * reproduce is the browser freezing timers or dropping the socket.
 */
const setTabHidden = (client: Client, hidden: boolean): Promise<void> =>
  client.page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (value ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

const kind = (index: number): ClientKind => {
  const found = CLIENT_KINDS[index];
  if (!found) throw new Error(`no client kind ${index}`);
  return found;
};

test('a tab hidden for 3 s: the other player sees no snap, and the tab resumes', async () => {
  await waitForEmptyRoom();
  await sustain(true);
  const watcher = await openClient(browsers, kind(0), proxy.url('100ms', 1));
  const hider = await openClient(browsers, kind(2), proxy.url('100ms', 2));
  await placeInRing([watcher, hider]);
  await setBehaviour(hider, { kind: 'wanderer', seed: 5 });
  await watcher.page.waitForTimeout(2500);
  await clearRecording(watcher);
  const fromTick = await serverTick();

  await watcher.page.waitForTimeout(2000);
  await setTabHidden(hider, true);
  await watcher.page.waitForTimeout(3000);
  expect((await status(hider)).status).toBe('away');
  await setTabHidden(hider, false);
  await watcher.page.waitForTimeout(3000);

  const hiderStatus = await status(hider);
  expect(hiderStatus.status).toBe('playing');
  expect(hiderStatus.playerId).toBe(hider.playerId);
  expect(hiderStatus.reconnects).toBe(0);

  const recording = await readRecording(watcher);
  const measured = measure(
    watcher,
    [recording],
    [await readTruth(fromTick - 60, await serverTick())],
  );
  console.log(`hidden tab, as the other player saw it:\n${describeMeasured(measured)}`);
  expect(measured.remoteSamples).toBeGreaterThan(300);
  expect(measured.snaps).toBe(0);
  expect(measured.remoteErrorMax).toBeLessThan(THRESHOLDS.remoteErrorMax);

  // After coming back the hidden client predicts cleanly again.
  await clearRecording(hider);
  await watcher.page.waitForTimeout(3000);
  const after = await readRecording(hider);
  expect(after.corrections.filter((c) => !c.teleport && c.distance > 0.01)).toEqual([]);
  expect([...watcher.problems, ...hider.problems]).toEqual([]);
  await sustain(false);
  await Promise.all([watcher.page.context().close(), hider.page.context().close()]);
});

test('a cut connection: the client reconnects and keeps its seat', async () => {
  await waitForEmptyRoom();
  const a = await openClient(browsers, kind(1), proxy.url('100ms', 3));
  const b = await openClient(browsers, kind(3), proxy.url('100ms', 4));
  await a.page.waitForTimeout(1500);
  const before = await serverHealth();
  expect(before.players).toBe(2);

  proxy.dropClients();
  // First retry after 250 ms, then the handshake over a 100 ms link.
  await a.page.waitForFunction(
    () => window.__orbit?.status().reconnects === 1 && window.__orbit.status().status === 'playing',
    undefined,
    { timeout: 8000 },
  );
  await b.page.waitForFunction(
    () => window.__orbit?.status().reconnects === 1 && window.__orbit.status().status === 'playing',
    undefined,
    { timeout: 8000 },
  );

  expect((await status(a)).playerId).toBe(a.playerId);
  expect((await status(b)).playerId).toBe(b.playerId);
  expect((await serverHealth()).players).toBe(2);

  // Each still sees the other, and neither was killed for leaving.
  await a.page.waitForTimeout(1500);
  const seenByA = await a.page.evaluate(() => window.__orbit?.frames.at(-1)?.remotes.length);
  const deathsSeen = await a.page.evaluate(
    () => window.__orbit?.events.filter((e) => e.kind === 'death').length,
  );
  expect(seenByA).toBe(1);
  expect(deathsSeen).toBe(0);
  // The page-level "WebSocket closed" messages are the cut itself, not a fault.
  await Promise.all([a.page.context().close(), b.page.context().close()]);
});

test('a late joiner sees the same world as those already playing', async () => {
  await waitForEmptyRoom();
  await sustain(true);
  const first = await openClient(browsers, kind(0), proxy.url('100ms', 5));
  const second = await openClient(browsers, kind(1), proxy.url('100ms', 6));
  await placeInRing([first, second]);
  await setBehaviour(first, { kind: 'hunter' });
  await setBehaviour(second, { kind: 'circler', yaw: 0.15 });
  await first.page.waitForTimeout(6000);

  const late = await openClient(browsers, kind(2), proxy.url('100ms', 7));
  // Bring the newcomer to the fight; it spawned somewhere else in the belt.
  await placeShip(late.playerId, {
    x: 80,
    y: 0,
    z: 4300,
    yaw: 0,
    pitch: 0,
    speed: 20,
    targetSpeed: 20,
  });
  await late.page.waitForTimeout(2500);
  await clearRecording(late);
  const fromTick = await serverTick();
  await late.page.waitForTimeout(5000);

  const recording = await readRecording(late);
  const measured = measure(late, [recording], [await readTruth(fromTick - 60, await serverTick())]);
  console.log(`late joiner:\n${describeMeasured(measured)}`);
  const lastFrame = recording.frames.at(-1);
  expect(lastFrame?.remotes.map((r) => r.id).sort()).toEqual(
    [first.playerId, second.playerId].sort(),
  );
  expect(measured.remoteSamples).toBeGreaterThan(400);
  expect(measured.remoteErrorP95).toBeLessThan(THRESHOLDS.remoteErrorP95);
  expect(measured.snaps).toBe(0);
  // It draws the bullets the others are firing.
  const bulletsDrawn = await late.page.evaluate(() =>
    Math.max(...(window.__orbit?.frames.map((f) => f.bullets) ?? [0])),
  );
  expect(bulletsDrawn).toBeGreaterThan(0);
  expect([...first.problems, ...second.problems, ...late.problems]).toEqual([]);
  await sustain(false);
  await Promise.all([first, second, late].map((client) => client.page.context().close()));
});
