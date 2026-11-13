// Helpers for the multi-client specs: opening clients of different browsers
// in one room, driving the server's test hooks, and turning what the pages
// recorded into the numbers the thresholds are written against.

import { chromium, devices, webkit } from '@playwright/test';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { CHROMIUM_ARGS, CLIENT_PORT, SERVER_PORT } from '../../playwright.config.ts';
import type { DebugHook, DebugStatus, RemoteFrame } from '../../src/client/debugHook.ts';
import type { BehaviourSpec } from '../../src/net/behaviours.ts';
import type { CorrectionEvent, ViewHit } from '../../src/net/client.ts';
import type { Truth, TruthRow } from '../../src/server/recorder.ts';
import type { ShipState } from '../../src/shared/sim/ship.ts';
import { hitAgreement, percentile, snapExcess } from '../support/metrics.ts';
import { THRESHOLDS } from '../thresholds.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

const SERVER = `http://127.0.0.1:${SERVER_PORT}`;
const CLIENT = `http://127.0.0.1:${CLIENT_PORT}`;

export interface ClientKind {
  name: string;
  engine: 'chromium' | 'webkit';
  context: BrowserContextOptions;
}

function device(name: string): BrowserContextOptions {
  const descriptor = devices[name];
  if (!descriptor) throw new Error(`Playwright has no device called ${name}`);
  // The descriptor names a browser too; a context does not take that.
  return {
    viewport: descriptor.viewport,
    userAgent: descriptor.userAgent,
    deviceScaleFactor: descriptor.deviceScaleFactor,
    isMobile: descriptor.isMobile,
    hasTouch: descriptor.hasTouch,
  };
}

/** The four browser profiles the brief names. */
export const CLIENT_KINDS: ClientKind[] = [
  { name: 'Chromium desktop', engine: 'chromium', context: device('Desktop Chrome') },
  { name: 'WebKit desktop', engine: 'webkit', context: device('Desktop Safari') },
  { name: 'iPhone 15 (WebKit)', engine: 'webkit', context: device('iPhone 15 landscape') },
  { name: 'Pixel 7 (Chromium)', engine: 'chromium', context: device('Pixel 7 landscape') },
];

export interface Browsers {
  chromium: Browser;
  webkit: Browser;
  close(): Promise<void>;
}

export async function launchBrowsers(): Promise<Browsers> {
  const [c, w] = await Promise.all([chromium.launch({ args: CHROMIUM_ARGS }), webkit.launch()]);
  return {
    chromium: c,
    webkit: w,
    close: async () => {
      await Promise.all([c.close(), w.close()]);
    },
  };
}

export interface Client {
  kind: ClientKind;
  page: Page;
  playerId: number;
  problems: string[];
}

/** Opens a client and waits until it is in the game. `socketUrl` is the proxy address to use. */
export async function openClient(
  browsers: Browsers,
  kind: ClientKind,
  socketUrl: string,
): Promise<Client> {
  const context = await browsers[kind.engine].newContext(kind.context);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`${kind.name}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`${kind.name}: ${message.text()}`);
  });
  await page.goto(`${CLIENT}/?server=${encodeURIComponent(socketUrl)}`);
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  const playerId = await page.evaluate(() => window.__orbit?.status().playerId ?? -1);
  return { kind, page, playerId, problems };
}

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${SERVER}${path}`, { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
}

export const placeShip = (id: number, ship: Partial<ShipState>): Promise<void> =>
  post('/debug/place', { id, ship });

export const sustain = (on: boolean): Promise<void> => post('/debug/sustain', { on });

export async function serverTick(): Promise<number> {
  const health = (await (await fetch(`${SERVER}/health`)).json()) as { tick: number };
  return health.tick;
}

export async function serverHealth(): Promise<{ tick: number; players: number }> {
  return (await (await fetch(`${SERVER}/health`)).json()) as { tick: number; players: number };
}

/**
 * Waits until nobody is left in the room. The server holds a seat for ten
 * seconds after a player disconnects, so the previous test's players are
 * still there for a while.
 */
export async function waitForEmptyRoom(): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await serverHealth()).players === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the room did not empty within 15 s');
}

export async function readTruth(fromTick: number, toTick: number): Promise<Truth> {
  return (await (
    await fetch(`${SERVER}/debug/truth?from=${fromTick}&to=${toTick}`)
  ).json()) as Truth;
}

/** Puts ships in a ring 300 units across in the belt, all facing the middle, at cruise speed. */
export async function placeInRing(clients: Client[], centreX = 0, centreZ = 4400): Promise<void> {
  await Promise.all(
    clients.map((client, i) => {
      const angle = (i / clients.length) * 2 * Math.PI;
      const facing = angle + Math.PI;
      return placeShip(client.playerId, {
        x: centreX + Math.sin(angle) * 150,
        y: 0,
        z: centreZ + Math.cos(angle) * 150,
        yaw: facing > Math.PI ? facing - 2 * Math.PI : facing,
        pitch: 0,
        roll: 0,
        speed: 20,
        targetSpeed: 20,
        invulnTicks: 0,
      });
    }),
  );
}

export const setBehaviour = (client: Client, spec: BehaviourSpec | null): Promise<void> =>
  client.page.evaluate((s) => window.__orbit?.setBehaviour(s), spec);

export const clearRecording = (client: Client): Promise<void> =>
  client.page.evaluate(() => window.__orbit?.clear());

export const status = (client: Client): Promise<DebugStatus> =>
  client.page.evaluate(() => {
    const hook = window.__orbit;
    if (!hook) throw new Error('debug hook missing');
    return hook.status();
  });

export interface Recording {
  status: DebugStatus;
  /** Per frame: real time since the previous frame, and the other ships as drawn. */
  frames: { elapsedMs: number; remotes: RemoteFrame[] }[];
  corrections: CorrectionEvent[];
  viewHits: ViewHit[];
  /** Ticks the server simulated without this client's input, while recording. */
  missedInputs: number;
  inputsSent: number;
}

export const readRecording = (client: Client): Promise<Recording> =>
  client.page.evaluate(() => {
    const hook = window.__orbit;
    if (!hook) throw new Error('debug hook missing');
    return {
      status: hook.status(),
      frames: hook.frames.map((frame) => ({ elapsedMs: frame.elapsedMs, remotes: frame.remotes })),
      corrections: hook.corrections,
      viewHits: hook.viewHits,
      missedInputs: hook.snapshots.reduce((sum, snapshot) => sum + snapshot.missedInputs, 0),
      // One input per tick and one snapshot per two ticks.
      inputsSent: hook.snapshots.length * 2,
    };
  });

export interface Measured {
  client: string;
  frames: number;
  framesPerSecond: number;
  /** Other ships: drawn position against the server's at the moment drawn, in units. */
  remoteSamples: number;
  remoteErrorP50: number;
  remoteErrorP95: number;
  remoteErrorMax: number;
  /** Share of remote-ship frames drawn past the newest sample. */
  extrapolatedShare: number;
  /** Frames in which a remote ship moved more than the no-snap rule allows. */
  snaps: number;
  worstSnapExcess: number;
  /** Own ship: prediction corrections, not counting deaths and respawns. */
  corrections: number;
  correctionP95: number;
  correctionMax: number;
  /** Shooter-view hits and how many the server confirmed. */
  hitsSeen: number;
  hitsConfirmed: number;
  hitAgreement: number;
  serverHitsNotSeen: number;
  roundTripMs: number;
  inputSlackTicks: number;
  viewDelayMs: number;
  interpolationDelayMs: number;
  /** Share of this client's inputs that reached the server too late to be used. */
  missedInputShare: number;
}

function truthAt(
  truth: Map<number, Record<number, TruthRow>>,
  id: number,
  tick: number,
): TruthRow | null {
  const a = truth.get(Math.floor(tick))?.[id];
  const b = truth.get(Math.ceil(tick))?.[id];
  if (!a || !b || a[6] !== b[6]) return null;
  const t = tick - Math.floor(tick);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    Math.max(a[3], b[3]),
    Math.max(a[4], b[4]),
    Math.min(a[5], b[5]),
    a[6],
  ];
}

/** Turns one or more recordings from a client, and the server's truth, into the measured numbers. */
export function measure(client: Client, recordings: Recording[], truths: Truth[]): Measured {
  const errors: number[] = [];
  const correctionSizes: number[] = [];
  let frames = 0;
  let elapsedMs = 0;
  let remoteFrames = 0;
  let extrapolated = 0;
  let snaps = 0;
  let worstSnapExcess = -Infinity;
  let seen = 0;
  let confirmed = 0;
  let unseen = 0;
  let missedInputs = 0;
  let inputsSent = 0;

  recordings.forEach((recording, index) => {
    const truth = truths[index];
    if (!truth) return;
    const byTick = new Map(truth.ticks.map((entry) => [entry.tick, entry.ships]));
    const previous = new Map<number, RemoteFrame>();

    for (const frame of recording.frames) {
      frames++;
      elapsedMs += frame.elapsedMs;
      const present = new Set<number>();
      for (const remote of frame.remotes) {
        present.add(remote.id);
        if (!remote.full || !remote.alive) {
          previous.delete(remote.id);
          continue;
        }
        const actual = truthAt(byTick, remote.id, remote.viewTick);
        const before = previous.get(remote.id);
        previous.set(remote.id, remote);
        if (!actual || actual[5] === 0 || actual[6] !== remote.spawnSeq) continue;

        remoteFrames++;
        if (remote.extrapolatedTicks > 0) extrapolated++;
        errors.push(Math.hypot(remote.x - actual[0], remote.y - actual[1], remote.z - actual[2]));

        if (before && before.spawnSeq === remote.spawnSeq) {
          const moved = Math.hypot(remote.x - before.x, remote.y - before.y, remote.z - before.z);
          const limit = Math.max(actual[3], actual[4]);
          const excess = snapExcess(moved, frame.elapsedMs, limit, THRESHOLDS.snapFactor);
          worstSnapExcess = Math.max(worstSnapExcess, excess);
          // A hundredth of a unit of slack for rounding in the recorded numbers.
          if (excess > 0.01) snaps++;
        }
      }
      for (const id of previous.keys()) if (!present.has(id)) previous.delete(id);
    }

    for (const correction of recording.corrections) {
      if (!correction.teleport) correctionSizes.push(correction.distance);
    }
    missedInputs += recording.missedInputs;
    inputsSent += recording.inputsSent;

    // Judge only hits from the middle of the recording: both logs are
    // complete there. A hit has the same tick number in both. The margin is
    // more than the furthest a client runs ahead of the server.
    const firstTick = truth.ticks[0]?.tick ?? 0;
    const lastTick = truth.ticks[truth.ticks.length - 1]?.tick ?? 0;
    const inWindow = (tick: number): boolean => tick >= firstTick + 150 && tick <= lastTick - 60;
    const mine = truth.hits.filter((hit) => hit.ownerId === client.playerId && inWindow(hit.tick));
    const judged = recording.viewHits.filter((hit) => inWindow(hit.tick));
    const result = hitAgreement(judged, mine);
    seen += result.seen;
    confirmed += result.confirmed;
    unseen += result.unseen;
  });

  const last = recordings[recordings.length - 1]?.status;
  return {
    client: client.kind.name,
    frames,
    framesPerSecond: elapsedMs > 0 ? (frames * 1000) / elapsedMs : 0,
    remoteSamples: errors.length,
    remoteErrorP50: percentile(errors, 0.5),
    remoteErrorP95: percentile(errors, 0.95),
    remoteErrorMax: errors.length ? Math.max(...errors) : 0,
    extrapolatedShare: remoteFrames ? extrapolated / remoteFrames : 0,
    snaps,
    worstSnapExcess,
    corrections: correctionSizes.length,
    correctionP95: percentile(correctionSizes, 0.95),
    correctionMax: correctionSizes.length ? Math.max(...correctionSizes) : 0,
    hitsSeen: seen,
    hitsConfirmed: confirmed,
    hitAgreement: seen ? confirmed / seen : 1,
    serverHitsNotSeen: unseen,
    roundTripMs: last?.rttMs ?? 0,
    inputSlackTicks: last?.leadTicks ?? 0,
    viewDelayMs: ((last?.viewDelayTicks ?? 0) * 1000) / 60,
    interpolationDelayMs: ((last?.interpolationDelayTicks ?? 0) * 1000) / 60,
    missedInputShare: inputsSent ? missedInputs / inputsSent : 0,
  };
}

/** One line per client, for the test log. */
export function describeMeasured(m: Measured): string {
  return (
    `${m.client.padEnd(20)} ${m.framesPerSecond.toFixed(0).padStart(3)} fps | ` +
    `remote err p95 ${m.remoteErrorP95.toFixed(3)} max ${m.remoteErrorMax.toFixed(3)} ` +
    `(n ${m.remoteSamples}, extrap ${(m.extrapolatedShare * 100).toFixed(1)}%) | ` +
    `snaps ${m.snaps} | corrections ${m.corrections} p95 ${m.correctionP95.toFixed(3)} ` +
    `max ${m.correctionMax.toFixed(3)} | hits ${m.hitsConfirmed}/${m.hitsSeen} ` +
    `(${(m.hitAgreement * 100).toFixed(1)}%), unseen ${m.serverHitsNotSeen} | ` +
    `rtt ${m.roundTripMs.toFixed(0)} ms, slack ${m.inputSlackTicks.toFixed(1)}, ` +
    `view delay ${m.viewDelayMs.toFixed(0)} ms, interp ${m.interpolationDelayMs.toFixed(0)} ms, ` +
    `late inputs ${(m.missedInputShare * 100).toFixed(1)}%`
  );
}
