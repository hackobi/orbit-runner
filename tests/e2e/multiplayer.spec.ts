import { expect, test } from '@playwright/test';
import { PROXY_PORT, SERVER_PORT } from '../../playwright.config.ts';
import type { BehaviourSpec } from '../../src/net/behaviours.ts';
import { NET_PROFILES, startProxy } from '../support/netProxy.ts';
import type { NetProfileName, RunningProxy } from '../support/netProxy.ts';
import { writeResult } from '../support/results.ts';
import { THRESHOLDS } from '../thresholds.ts';
import {
  CLIENT_KINDS,
  clearRecording,
  describeMeasured,
  launchBrowsers,
  measure,
  openClient,
  placeInRing,
  readRecording,
  readTruth,
  serverTick,
  setBehaviour,
  sustain,
  waitForEmptyRoom,
} from './support.ts';
import type { Browsers, Client, Measured, Recording } from './support.ts';
import type { Truth } from '../../src/server/recorder.ts';

// Four clients in one room: desktop Chromium, desktop WebKit, an iPhone
// profile and a Pixel profile, each through the network proxy. Two hunt and
// shoot while two fly erratically, then they swap, so every browser profile
// is measured in both roles.

const MEASURE_MS = 20_000;
const SETTLE_MS = 2500;

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

const HUNT: BehaviourSpec = { kind: 'hunter' };
const flyAbout = (seed: number): BehaviourSpec => ({ kind: 'wanderer', seed });

async function measurePhase(
  clients: Client[],
  hunters: number[],
): Promise<{ recordings: Recording[]; truth: Truth }> {
  await placeInRing(clients);
  await Promise.all(
    clients.map((client, i) => setBehaviour(client, hunters.includes(i) ? HUNT : flyAbout(11 + i))),
  );
  // Being moved is a correction the server intends. Let it pass, and let the
  // clocks settle, before recording anything.
  await clients[0]?.page.waitForTimeout(Math.max(SETTLE_MS, THRESHOLDS.warmUpMs));
  await Promise.all(clients.map(clearRecording));
  const fromTick = await serverTick();
  await clients[0]?.page.waitForTimeout(MEASURE_MS);
  const recordings = await Promise.all(clients.map(readRecording));
  const toTick = await serverTick();
  // Other ships are drawn a little in the past, so read from a little earlier.
  return { recordings, truth: await readTruth(fromTick - 60, toTick) };
}

for (const profile of ['clean', '100ms', '200ms-lossy'] as NetProfileName[]) {
  test(`four browsers on the ${profile} profile`, async () => {
    test.setTimeout(180_000);
    await waitForEmptyRoom();
    await sustain(true);
    const clients: Client[] = [];
    for (const [i, kind] of CLIENT_KINDS.entries()) {
      clients.push(await openClient(browsers, kind, proxy.url(profile, 100 + i)));
    }

    const first = await measurePhase(clients, [0, 2]);
    const second = await measurePhase(clients, [1, 3]);
    const results: Measured[] = clients.map((client, i) => {
      const recordings = [first.recordings[i], second.recordings[i]].filter(
        (r): r is Recording => r !== undefined,
      );
      return measure(client, recordings, [first.truth, second.truth]);
    });

    await sustain(false);
    const problems = clients.flatMap((client) => client.problems);
    await Promise.all(clients.map((client) => client.page.context().close()));

    const net = NET_PROFILES[profile];
    console.log(
      `\n${profile}: ${net.oneWayMs * 2} ms round trip ± ${net.jitterMs * 2} ms, ` +
        `${net.loss * 100}% loss (${net.lossMode})`,
    );
    for (const result of results) console.log(describeMeasured(result));
    writeResult(`multiplayer-${profile}`, results);

    expect(problems).toEqual([]);
    for (const m of results) {
      const who = `${m.client} on ${profile}`;
      // Every client drew the others, in full, for most of the run.
      expect(m.remoteSamples, `${who}: remote ships drawn`).toBeGreaterThan(1000);

      // No visible snaps: every profile.
      expect(m.snaps, `${who}: frames where a remote ship jumped`).toBe(0);

      if (profile === 'clean') {
        expect(m.correctionMax, `${who}: largest own-ship correction`).toBeLessThanOrEqual(
          THRESHOLDS.cleanCorrectionMax,
        );
      }
      if (profile === 'clean' || profile === '100ms') {
        expect(m.remoteErrorP95, `${who}: remote position error p95`).toBeLessThan(
          THRESHOLDS.remoteErrorP95,
        );
        expect(m.remoteErrorMax, `${who}: remote position error max`).toBeLessThan(
          THRESHOLDS.remoteErrorMax,
        );
        expect(m.hitsSeen, `${who}: hits seen by the shooter`).toBeGreaterThanOrEqual(15);
        expect(
          m.hitAgreement,
          `${who}: share of seen hits the server confirmed`,
        ).toBeGreaterThanOrEqual(THRESHOLDS.hitAgreementMin);
      }
      if (profile === '200ms-lossy') {
        expect(m.correctionP95, `${who}: own-ship correction p95`).toBeLessThan(
          THRESHOLDS.lossyCorrectionP95,
        );
      }
    }
  });
}
