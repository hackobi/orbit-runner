// Load test: 16 bots fighting in one place for five minutes.
//
// Run: npm run test:load            (five minutes)
//      npm run test:load -- 60     (a shorter run, in seconds, for a quick look)
//
// Pass: tick work p99 under half a tick, and heap after garbage collection
// at the end within 10% of what it was at one minute. Bandwidth is reported.
//
// The bots run in a second process. All 16 ships are kept within sight of
// each other and kept alive, which is the worst case: every ship is sent to
// every player in full, 30 times a second, and every bullet is tested
// against 15 targets.

import { spawn } from 'node:child_process';
import { SIM } from '../src/shared/constants.ts';
import { startServer } from '../src/server/server.ts';
import type { Room } from '../src/server/room.ts';
import { THRESHOLDS } from '../tests/thresholds.ts';

const BOTS = 16;
const seconds = Number(process.argv[2] ?? 300);
const baselineAtSeconds = Math.min(60, Math.floor(seconds / 5));

if (typeof globalThis.gc !== 'function') {
  console.error('run with --expose-gc (npm run test:load does)');
  process.exit(2);
}
const collect = globalThis.gc;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const work: number[] = [];
let catchUps = 0;

// Keep every ship alive and near the middle of the fight.
const CENTRE_Z = 4400;
const keepTogether = (_tick: number, room: Room): void => {
  for (const id of room.playerIds()) {
    room.placeShip(id, (ship) => {
      if (!ship.alive) return ship;
      const dx = ship.x;
      const dz = ship.z - CENTRE_Z;
      const strayed = dx * dx + dz * dz > 900 * 900;
      if (!strayed && ship.hp === SIM.maxHp) return ship;
      return strayed
        ? { ...ship, x: 0, y: 0, z: CENTRE_Z, hp: SIM.maxHp }
        : { ...ship, hp: SIM.maxHp };
    });
  }
};

const server = await startServer({
  port: 0,
  seed: 16,
  onTick: keepTogether,
  onWork: (durationMs, ticks) => {
    work.push(durationMs / ticks);
    if (ticks > 1) catchUps++;
  },
});
const room = server.room;

const child = spawn(
  process.execPath,
  ['scripts/bots.ts', `ws://127.0.0.1:${server.port}/ws`, String(BOTS)],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
let lastBotReport = '';
child.stdout.on('data', (chunk: Buffer) => {
  lastBotReport = chunk.toString().trim().split('\n').pop() ?? lastBotReport;
});

for (let waited = 0; room.playerCount < BOTS; waited += 100) {
  if (waited > 10_000) throw new Error(`only ${room.playerCount} of ${BOTS} bots joined`);
  await sleep(100);
}
room.playerIds().forEach((id, i) => {
  const angle = (i / BOTS) * 2 * Math.PI;
  room.placeShip(id, (ship) => ({
    ...ship,
    x: Math.sin(angle) * 300,
    y: 0,
    z: CENTRE_Z + Math.cos(angle) * 300,
    invulnTicks: 0,
  }));
});
console.log(`${BOTS} bots joined. Running for ${seconds} s.`);

const percentile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const heapAfterGc = (): number => {
  collect();
  collect();
  return process.memoryUsage().heapUsed;
};

work.length = 0;
const startedAt = performance.now();
const startBytes = room.stats.bytesSent;
const startMessages = room.stats.messagesSent;
const startTick = room.tick;
let heapBaseline = 0;

for (let elapsed = 10; elapsed <= seconds; elapsed += 10) {
  await sleep(startedAt + elapsed * 1000 - performance.now());
  if (elapsed >= baselineAtSeconds && heapBaseline === 0) heapBaseline = heapAfterGc();
  console.log(
    `${String(elapsed).padStart(4)} s  players ${room.playerCount}  bullets ${room.bulletCount}  ` +
      `tick p99 ${percentile(work.slice(-600), 0.99).toFixed(2)} ms  ` +
      `heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(1)} MB  bots ${lastBotReport}`,
  );
}

const heapEnd = heapAfterGc();
const elapsedSeconds = (performance.now() - startedAt) / 1000;
const ticks = room.tick - startTick;
const result = {
  bots: BOTS,
  seconds: Math.round(elapsedSeconds),
  ticksPerSecond: ticks / elapsedSeconds,
  tickWorkMs: {
    p50: percentile(work, 0.5),
    p99: percentile(work, 0.99),
    max: Math.max(...work),
  },
  catchUps,
  droppedTicks: room.stats.droppedTicks,
  heapMB: { atBaseline: heapBaseline / 1e6, atEnd: heapEnd / 1e6 },
  heapGrowth: heapEnd / heapBaseline - 1,
  // Payload bytes the server handed to the sockets. WebSocket and TCP
  // framing (a few bytes per message) are not included.
  bytesPerClientPerSecond: (room.stats.bytesSent - startBytes) / BOTS / elapsedSeconds,
  messagesPerClientPerSecond: (room.stats.messagesSent - startMessages) / BOTS / elapsedSeconds,
  bulletsFired: room.stats.bulletsFired,
  hits: room.stats.hits,
  lateInputShare: room.stats.missedInputs / (ticks * BOTS),
  malformedMessages: room.stats.malformedMessages,
  botsAtEnd: lastBotReport,
};
console.log(JSON.stringify(result, null, 2));

child.kill('SIGTERM');
await server.close();

const failures: string[] = [];
if (result.tickWorkMs.p99 > THRESHOLDS.tickP99Ms) {
  failures.push(
    `tick work p99 ${result.tickWorkMs.p99.toFixed(2)} ms is over ${THRESHOLDS.tickP99Ms.toFixed(2)} ms`,
  );
}
if (result.heapGrowth > THRESHOLDS.heapGrowthMax) {
  failures.push(`heap grew ${(result.heapGrowth * 100).toFixed(1)}% since the baseline`);
}
if (room.playerCount !== 0 && result.ticksPerSecond < 59.5) {
  failures.push(`the server ran ${result.ticksPerSecond.toFixed(2)} ticks a second`);
}
if (failures.length > 0) {
  console.error(`FAIL\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('PASS');
process.exit(0);
