// Runs headless bots against a game server. The load test starts this in a
// process of its own, so the bots' work does not show up in the server's timings.
//
// Usage: node scripts/bots.ts <ws url> <count>

import { hunter } from '../src/net/behaviours.ts';
import { createBot } from '../src/net/bot.ts';

const url = process.argv[2];
const count = Number(process.argv[3] ?? 16);
if (!url) {
  console.error('usage: node scripts/bots.ts <ws url> <count>');
  process.exit(2);
}

const bots = Array.from({ length: count }, () =>
  createBot({
    openSocket: () => new WebSocket(url),
    behaviour: hunter(),
    now: () => performance.now(),
  }),
);

// About 120 updates a second each, like a fast display.
setInterval(() => {
  for (const bot of bots) bot.update();
}, 8);

const report = (): void => {
  const corrections = bots.reduce((sum, bot) => sum + bot.corrections.length, 0);
  const playing = bots.filter((bot) => bot.session.core.status === 'playing').length;
  const reconnects = bots.reduce((sum, bot) => sum + bot.session.reconnects, 0);
  const missed = bots.reduce((sum, bot) => sum + bot.session.core.counters.missedInputs, 0);
  const sent = bots.reduce((sum, bot) => sum + bot.session.core.counters.inputsSent, 0);
  process.stdout.write(`${JSON.stringify({ playing, corrections, reconnects, missed, sent })}\n`);
};
setInterval(report, 10_000);
process.on('SIGTERM', () => {
  report();
  process.exit(0);
});
