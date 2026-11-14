// Writes the latest-results section of docs/PLAN.md from the numbers the
// tests recorded in docs/results/, judging each gate against
// tests/thresholds.ts. The gates are Phase 2's; from Phase 3 on they are
// measured with the full belt, every orb and scoring switched on. Exits with an error if any gate fails, after writing
// the section, so the plan shows the failure.
//
// Run: npm run results   (after test:integration, test:e2e, test:load, console-check,
// update-check and package:mac)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Measured } from '../tests/e2e/support.ts';
import { NET_PROFILES } from '../tests/support/netProxy.ts';
import type { NetProfileName } from '../tests/support/netProxy.ts';
import { readResult } from '../tests/support/results.ts';
import { THRESHOLDS } from '../tests/thresholds.ts';

const PLAN = join(dirname(fileURLToPath(import.meta.url)), '../docs/PLAN.md');
const START = '<!-- RESULTS:START (written by scripts/results.ts; do not edit by hand) -->';
const END = '<!-- RESULTS:END -->';

interface Load {
  bots: number;
  seconds: number;
  ticksPerSecond: number;
  tickWorkMs: { p50: number; p99: number; max: number };
  catchUps: number;
  droppedTicks: number;
  heapMB: { atBaseline: number; atEnd: number };
  heapGrowth: number;
  bytesPerClientPerSecond: number;
  messagesPerClientPerSecond: number;
  bulletsPerSecond: number;
  lateInputShare: number;
}
interface BotsOne {
  seconds: number;
  inputs: number;
  snapshots: number;
  corrections: number;
  missedInputs: number;
  roundTripMs: number;
  inputSlackTicks: number;
}
interface BotsHunters {
  seconds: number;
  bullets: number;
  serverHits: number;
  hitsSeen: number;
  hitsConfirmed: number;
  hitAgreement: number;
  serverHitsNotSeen: number;
  kills: number;
  missedInputs: number;
}
interface BotsDrop {
  seconds: number;
  forwarded: number;
  dropped: number;
  stalled: number;
  hits: number;
  deaths: number;
  missedInputs: number;
}
interface BotsFreeForAll {
  seconds: number;
  hitsSeen: number;
  hitsConfirmed: number;
  hitAgreement: number;
  unconfirmed: number;
  unconfirmedOnDestroyedShip: number;
  serverHitsNotSeen: number;
  kills: number;
}
interface Firefox {
  framesPerSecond: number;
  webgl2: boolean;
  corrections: number;
  remotesSeen: number;
  browserVersion: string;
}
interface Determinism {
  browserVersion: string;
  traceHash: number;
  nodeTraceHash: number;
  fusedMultiplyAdds: number;
  fingerprintMatchesNode: boolean;
}

const multiplayer = (profile: NetProfileName): Measured[] =>
  readResult(`multiplayer-${profile}`).data as Measured[];

const clean = multiplayer('clean');
const p100 = multiplayer('100ms');
const lossy = multiplayer('200ms-lossy');
const browserSuiteAt = readResult('multiplayer-100ms').measuredAt;
const loadResult = readResult('load');
const load = { measuredAt: loadResult.measuredAt, data: loadResult.data as Load };
const botsOne = readResult('bots-one').data as BotsOne;
const hunters = readResult('bots-four-hunters').data as BotsHunters;
const drop = readResult('bots-drop').data as BotsDrop;
const freeForAll = readResult('bots-free-for-all-100ms').data as BotsFreeForAll;
const hiddenTab = readResult('resilience-hidden-tab').data as Measured;
const lateJoiner = readResult('resilience-late-joiner').data as Measured;
const firefox = readResult('firefox-smoke').data as Firefox;
const headed = readResult('console-headed').data as {
  browser: string;
  renderer: string;
  playedSeconds: number;
  framesPerSecond: number;
  warningsAndErrors: unknown[];
  readPixelsMessages: unknown[];
  softwareRendering: boolean;
  installabilityErrors: string[];
  installabilityErrorsForAPageWithNoManifest: string[];
};
const macApp = readResult('macapp').data as {
  electron: string;
  chrome: string;
  display: { hertz: number };
  framesPerSecond: number;
  frameMsP50: number;
  frameMsP99: number;
  frameMsMax: number;
  seconds: number;
  corrections: number;
  largestCorrection: number;
};
const packaged = readResult('macapp-packaged').data as {
  bundle: string;
  sizeMB: number;
  hull: string;
  players: number;
  packaged: boolean;
  debugHook: boolean;
  consoleProblems: unknown[];
};
interface UpdateSeen {
  build: string;
  serviceWorkers: number;
}
const update = readResult('update-check').data as {
  browser: {
    first: UpdateSeen;
    second: {
      whileFlying: UpdateSeen;
      stillFlying: UpdateSeen;
      afterTheShipWasDestroyed: UpdateSeen;
      sameSeat: boolean;
      pointsKept: boolean;
    };
    third: UpdateSeen;
  };
  macApp: { starts: UpdateSeen[] };
};
const engines = ['chromium', 'webkit', 'firefox'].map((name) => ({
  name,
  ...(readResult(`determinism-${name}`).data as Determinism),
}));

const worst = (results: Measured[], pick: (m: Measured) => number): number =>
  Math.max(...results.map(pick));
const sum = (results: Measured[], pick: (m: Measured) => number): number =>
  results.reduce((total, m) => total + pick(m), 0);
const least = (results: Measured[], pick: (m: Measured) => number): number =>
  Math.min(...results.map(pick));
const percent = (share: number, digits = 1): string => `${(share * 100).toFixed(digits)}%`;

// --- Gates ------------------------------------------------------------------

interface Gate {
  name: string;
  limit: string;
  measured: string;
  pass: boolean;
}

const everyProfile = [...clean, ...p100, ...lossy];
const gates: Gate[] = [
  {
    name: 'Remote position error p95, 100 ms profile',
    limit: `< ${THRESHOLDS.remoteErrorP95.toFixed(1)}`,
    measured: `${worst(p100, (m) => m.remoteErrorP95).toFixed(3)} (worst of four clients)`,
    pass: p100.every((m) => m.remoteErrorP95 < THRESHOLDS.remoteErrorP95),
  },
  {
    name: 'Remote position error max, 100 ms profile',
    limit: `< ${THRESHOLDS.remoteErrorMax.toFixed(1)}`,
    measured: `${worst(p100, (m) => m.remoteErrorMax).toFixed(3)} (worst of four)`,
    pass: p100.every((m) => m.remoteErrorMax < THRESHOLDS.remoteErrorMax),
  },
  {
    name: 'No visible snaps, every profile',
    limit: `0 frames over ${THRESHOLDS.snapFactor} × speed limit × frame time`,
    measured: `${worst(everyProfile, (m) => m.snaps)} (worst of four clients on three profiles)`,
    pass: everyProfile.every((m) => m.snaps === 0),
  },
  {
    name: 'Own-ship corrections, 200 ms lossy profile',
    limit: `p95 < ${THRESHOLDS.lossyCorrectionP95.toFixed(1)}`,
    measured: `${worst(lossy, (m) => m.correctionP95).toFixed(3)} (worst of four)`,
    pass: lossy.every((m) => m.correctionP95 < THRESHOLDS.lossyCorrectionP95),
  },
  {
    name: 'Own-ship corrections, clean network',
    limit: `none over ${THRESHOLDS.cleanCorrectionMax}`,
    measured: `largest ${worst(clean, (m) => m.correctionMax).toFixed(3)}; ${worst(clean, (m) => m.corrections)} corrections of any size`,
    pass: clean.every((m) => m.correctionMax <= THRESHOLDS.cleanCorrectionMax),
  },
  {
    name: 'Hit agreement, 100 ms profile (ships kept alive)',
    limit: `≥ ${percent(THRESHOLDS.hitAgreementMin, 0)}`,
    measured: `${percent(least(p100, (m) => m.hitAgreement))} (lowest of four; fewest hits seen by one client: ${least(p100, (m) => m.hitsSeen)}; server hits not shown: ${sum(p100, (m) => m.serverHitsNotSeen)})`,
    pass: p100.every((m) => m.hitAgreement >= THRESHOLDS.hitAgreementMin && m.hitsSeen >= 15),
  },
  {
    name: `Load: tick time p99, ${load.data.bots} bots, ${load.data.seconds} s`,
    limit: `≤ ${THRESHOLDS.tickP99Ms.toFixed(2)} ms`,
    measured: `${load.data.tickWorkMs.p99.toFixed(2)} ms (p50 ${load.data.tickWorkMs.p50.toFixed(2)}, worst single tick ${load.data.tickWorkMs.max.toFixed(2)})`,
    pass: load.data.tickWorkMs.p99 <= THRESHOLDS.tickP99Ms && load.data.seconds >= 300,
  },
  {
    name: 'Load: heap after garbage collection, end against 1 minute',
    limit: `growth ≤ ${percent(THRESHOLDS.heapGrowthMax, 0)}`,
    measured: `${load.data.heapMB.atBaseline.toFixed(1)} MB → ${load.data.heapMB.atEnd.toFixed(1)} MB (${load.data.heapGrowth >= 0 ? '+' : ''}${percent(load.data.heapGrowth)})`,
    pass: load.data.heapGrowth <= THRESHOLDS.heapGrowthMax,
  },
];
const failed = gates.filter((gate) => !gate.pass);

// --- Tables -----------------------------------------------------------------

function clientTable(results: Measured[]): string {
  const head =
    '| Client | Frames/s | Remote error p95 | Remote error max | Drawn past newest sample | Snaps | Own corrections | Correction p95 | Correction max | Hits confirmed of seen | Server hits not shown | Late inputs | View delay | Interp. delay |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = results.map(
    (m) =>
      `| ${m.client} | ${m.framesPerSecond.toFixed(0)} | ${m.remoteErrorP95.toFixed(3)} | ${m.remoteErrorMax.toFixed(3)} | ` +
      `${percent(m.extrapolatedShare)} | ${m.snaps} | ${m.corrections} | ${m.correctionP95.toFixed(3)} | ${m.correctionMax.toFixed(3)} | ` +
      `${m.hitsConfirmed} of ${m.hitsSeen} (${percent(m.hitAgreement)}) | ${m.serverHitsNotSeen} | ${percent(m.missedInputShare)} | ` +
      `${m.viewDelayMs.toFixed(0)} ms | ${m.interpolationDelayMs.toFixed(0)} ms |`,
  );
  return [head, ...rows].join('\n');
}

function profileTitle(name: NetProfileName): string {
  const net = NET_PROFILES[name];
  if (net.oneWayMs === 0) return 'Clean profile (no added latency)';
  const loss =
    net.loss > 0 ? `, ${percent(net.loss, 0)} loss as an in-order ${net.stallMs} ms stall` : '';
  return `${name} profile (${net.oneWayMs * 2} ms round trip ± ${net.jitterMs * 2} ms${loss})`;
}

const yesNo = (value: boolean): string => (value ? 'Pass' : '**FAIL**');

const lines: string[] = [
  START,
  '',
  '### Latest results, with all content switched on',
  '',
  'The Phase 2 suite run again on the current build: 2,000 rocks, 1,360 orbs, Fenix ships, scoring and the store all in play. ' +
    `Measured on this Mac (M3 Ultra) with headless browsers. Browser suite: ${browserSuiteAt.slice(0, 16)}Z. Load test: ${load.measuredAt.slice(0, 10)}. ` +
    'Thresholds are in `tests/thresholds.ts`; raw numbers are in `docs/results/`. Distances are world units; a ship is 4.0 long. ' +
    'This section is generated from those files by `npm run results`.',
  '',
  '**Thresholds from the brief**',
  '',
  '| Threshold | Limit | Measured | Result |',
  '|---|---|---|---|',
  ...gates.map(
    (gate) => `| ${gate.name} | ${gate.limit} | ${gate.measured} | ${yesNo(gate.pass)} |`,
  ),
  `| Load: bandwidth per client | reported | ${(load.data.bytesPerClientPerSecond / 1000).toFixed(1)} kB/s down in ${load.data.messagesPerClientPerSecond.toFixed(0)} messages/s | Reported |`,
  '',
  failed.length === 0
    ? 'No threshold failed.'
    : `**${failed.length} threshold${failed.length === 1 ? '' : 's'} failed:** ${failed.map((gate) => gate.name).join('; ')}.`,
  '',
  `**${profileTitle('clean')}**`,
  '',
  clientTable(clean),
  '',
  `**${profileTitle('100ms')}**`,
  '',
  clientTable(p100),
  '',
  `**${profileTitle('200ms-lossy')}.** Only the snap and correction columns are gated on this profile; the rest is reported.`,
  '',
  clientTable(lossy),
  '',
  'How to read the tables:',
  '',
  '- Each test takes two 20-second measurements. In each, two clients hunt and shoot while two fly erratically; then they swap. Ships are kept alive by a test hook, so the hit column measures lag compensation and not who died first.',
  '- "Remote error" is the distance between where a client drew another ship and where the server had that ship at the moment being drawn.',
  '- "Late inputs" is the share of the client\'s inputs that reached the server after their tick had been simulated.',
  '- "View delay" is how far behind its own ship a client sees the others. The server honours up to 350 ms of it. "Interp. delay" is the part of that spent waiting so there are two samples to draw between.',
  '- "Hits confirmed of seen" counts the hits a shooter\'s screen showed and whether the server agreed. "Server hits not shown" is the other direction: hits the server counted that the shooter\'s own test did not find, so the bullet vanishes and the damage lands without a hit flash.',
  `- On the lossy profile the shooters' screens showed ${sum(lossy, (m) => m.hitsSeen)} hits and the server confirmed ${sum(lossy, (m) => m.hitsConfirmed)} of them (${percent(
    sum(lossy, (m) => m.hitsConfirmed) /
      Math.max(
        1,
        sum(lossy, (m) => m.hitsSeen),
      ),
  )}), and the server counted ${sum(lossy, (m) => m.serverHitsNotSeen)} hits that were not shown (${percent(
    sum(lossy, (m) => m.serverHitsNotSeen) /
      Math.max(1, sum(lossy, (m) => m.hitsConfirmed) + sum(lossy, (m) => m.serverHitsNotSeen)),
  )} of the server's hits; worst client ${worst(lossy, (m) => m.serverHitsNotSeen)}). Neither figure is gated on this profile, where the view delay is pinned at the 350 ms cap.`,
  "- A correction of size 0.000 moved nothing; a field other than position differed. Here it is the hull: the fights run among the rocks, a client rightly predicts the hull lost in a crash, and the test's keep-alive hook then gives it back on the server. One crash under the hook is one such correction (checked in virtual time: none without the hook).",
  '- Frame rates are headless browsers on a desktop GPU. They say nothing about phones.',
  '',
  '**Hit agreement in real play (reported, not gated)**',
  '',
  `Four hunter bots over real sockets through the proxy on the 100 ms profile, with real kills, regrouped every 12 s, ${freeForAll.seconds} s: ` +
    `**${freeForAll.hitsConfirmed} of ${freeForAll.hitsSeen} hits seen by shooters were confirmed (${percent(freeForAll.hitAgreement)})**, with ${freeForAll.kills} kills. ` +
    `Of the ${freeForAll.unconfirmed} not confirmed, ${freeForAll.unconfirmedOnDestroyedShip} were on a ship another player had already destroyed on the server. ` +
    `The server decided ${freeForAll.serverHitsNotSeen} hits that the shooter's screen did not show. ` +
    `The gated figure above is higher because its ships cannot die; ${freeForAll.hitAgreement >= THRESHOLDS.hitAgreementMin ? 'this run also clears 95%' : 'this run is below the 95% line and is the number to expect in a free-for-all'}.`,
  '',
  '**Other acceptance checks**',
  '',
  '| Check | Measured |',
  '|---|---|',
  `| One bot, real socket, ${botsOne.seconds} s | ${botsOne.inputs} inputs, ${botsOne.snapshots} snapshots, ${botsOne.corrections} corrections, ${botsOne.missedInputs} late inputs, round trip ${botsOne.roundTripMs.toFixed(1)} ms |`,
  `| Four hunters, real sockets, no added latency, ${hunters.seconds} s | all joined and saw each other; ${hunters.bullets} bullets, ${hunters.serverHits} server hits, ${hunters.hitsConfirmed} of ${hunters.hitsSeen} seen hits confirmed (${percent(hunters.hitAgreement)}), ${hunters.kills} kills |`,
  `| Loss mode \`drop\`: four hunters, 200 ms, 2% of inputs and snapshots discarded, ${drop.seconds} s | ${drop.dropped} messages dropped of ${drop.forwarded + drop.dropped}; ${drop.hits} hits, ${drop.deaths} deaths; the server ran ${drop.missedInputs} ticks without an input; every bot ended in the right life of its ship and had heard of every death |`,
  `| Tab hidden for 3 s, 100 ms profile | the other player saw ${hiddenTab.snaps} snaps and at most ${hiddenTab.remoteErrorMax.toFixed(3)} units of error over ${hiddenTab.remoteSamples} frames; the hidden client resumed in its seat without reconnecting |`,
  '| Connections cut, 100 ms profile | both clients reconnected once and kept their player ids; nobody died (asserted by the test; no numbers) |',
  `| Late joiner, 100 ms profile | drew both other ships within ${lateJoiner.remoteErrorP95.toFixed(3)} units (p95) of the server, ${lateJoiner.snaps} snaps, and drew their bullets |`,
  `| Firefox ${firefox.browserVersion} smoke run | WebGL2 ${firefox.webgl2 ? 'yes' : 'no'}, ${firefox.framesPerSecond.toFixed(0)} frames a second, saw ${firefox.remotesSeen} other player, ${firefox.corrections} corrections |`,
  ...engines.map(
    (engine) =>
      `| Same simulation bits as Node: ${engine.name} ${engine.browserVersion} | 10,000-tick hash ${engine.traceHash === engine.nodeTraceHash ? 'equal' : '**DIFFERENT**'}, ${engine.fusedMultiplyAdds} fused multiply-adds in 2,000,000 tries, handshake fingerprint ${engine.fingerprintMatchesNode ? 'equal' : '**DIFFERENT**'} |`,
  ),
  `| Headed browser on this Mac's GPU, ${headed.playedSeconds} s of play | ${headed.browser}; ${headed.renderer}; ${headed.framesPerSecond} frames a second; ${headed.warningsAndErrors.length} console warnings or errors; ${headed.readPixelsMessages.length} "ReadPixels" messages; software rendering ${headed.softwareRendering ? '**yes**' : 'no'} |`,
  `| Can it be installed? The browser's own verdict, same headed run, production build | objections to the game: ${headed.installabilityErrors.length === 0 ? 'none' : `**${headed.installabilityErrors.join(', ')}**`}; to a control page with no manifest: ${headed.installabilityErrorsForAPageWithNoManifest.join(', ') || '**none, so the check proves nothing**'} |`,
  `| A real update in Chromium, profile kept between visits (\`npm run update-check\`) | first visit: build ${update.browser.first.build}. Build B put on the server. Second visit: build ${update.browser.second.whileFlying.build} opens and is still flying 3 s later (${update.browser.second.stillFlying.build}) with the new one waiting; when the ship is destroyed the page loads build ${update.browser.second.afterTheShipWasDestroyed.build}, in the same seat (${update.browser.second.sameSeat ? 'yes' : '**no**'}) with its points (${update.browser.second.pointsKept ? 'yes' : '**no**'}). Third visit: build ${update.browser.third.build} |`,
  `| The same update in the Mac app, four starts with one profile | builds shown: ${update.macApp.starts.map((seen) => seen.build).join(', ')}; service workers registered: ${Math.max(...update.macApp.starts.map((seen) => seen.serviceWorkers))} |`,
  `| Mac app from source, in a window on this Mac's ${macApp.display.hertz} Hz display, ${macApp.seconds.toFixed(0)} s of flying | Electron ${macApp.electron} (Chromium ${macApp.chrome}); ${macApp.framesPerSecond.toFixed(1)} frames a second; frame time p50 ${macApp.frameMsP50.toFixed(1)} ms, p99 ${macApp.frameMsP99.toFixed(1)} ms, worst ${macApp.frameMsMax.toFixed(1)} ms; ${macApp.corrections} corrections, largest ${macApp.largestCorrection.toFixed(3)} |`,
  `| The packaged, ad hoc signed app (\`npm run package:mac\`), started once | ${packaged.bundle}, ${packaged.sizeMB} MB; opened, connected (${packaged.players} player in the room), showed "${packaged.hull}"; packaged build ${packaged.packaged ? 'yes' : '**no**'}; debug hook in it ${packaged.debugHook ? '**yes**' : 'no'}; ${packaged.consoleProblems.length} console warnings or errors |`,
  '',
  `Load test detail: ${load.data.bots} bots in one place firing without pause for ${load.data.seconds} s, about ${load.data.bulletsPerSecond.toFixed(0)} bullets a second, each tested against ${load.data.bots - 1} targets every tick. ` +
    `The server held ${load.data.ticksPerSecond.toFixed(2)} ticks a second with ${load.data.catchUps} catch-ups and ${load.data.droppedTicks} dropped ticks; ${percent(load.data.lateInputShare, 2)} of inputs were late. ` +
    'Bandwidth is payload bytes handed to the sockets; WebSocket and TCP framing are extra.',
  '',
  END,
];

const plan = readFileSync(PLAN, 'utf8');
const from = plan.indexOf(START);
const to = plan.indexOf(END);
if (from < 0 || to < 0) throw new Error(`docs/PLAN.md has no ${START} … ${END} section`);
writeFileSync(PLAN, plan.slice(0, from) + lines.join('\n') + plan.slice(to + END.length));

for (const gate of gates)
  console.log(`${gate.pass ? 'pass' : 'FAIL'}  ${gate.name}: ${gate.measured}`);
if (failed.length > 0) {
  console.error(`\n${failed.length} threshold(s) failed.`);
  process.exit(1);
}
