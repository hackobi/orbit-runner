import { describe, expect, it } from 'vitest';
import { hunter, wanderer } from '../../src/net/behaviours.ts';
import type { Behaviour } from '../../src/net/behaviours.ts';
import { createBot } from '../../src/net/bot.ts';
import type { Bot } from '../../src/net/bot.ts';
import { SIM } from '../../src/shared/constants.ts';
import { CAUSE_PLAYER } from '../../src/shared/protocol.ts';
import { shipStatesEqual } from '../../src/shared/sim/ship.ts';
import type { DeathRecord, HitRecord } from '../../src/server/room.ts';
import { startServer } from '../../src/server/server.ts';
import type { RunningServer } from '../../src/server/server.ts';
import { hitAgreement } from '../support/metrics.ts';
import { startProxy } from '../support/netProxy.ts';

// Real sockets and real timers: these take as long as they say. They run at
// the same time, each against its own server.
const FLIGHT_MS = 60_000;
const WARM_UP_MS = 2000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fly(url: string, behaviours: Behaviour[]): { bots: Bot[]; stop: () => void } {
  const bots = behaviours.map((behaviour) =>
    createBot({ openSocket: () => new WebSocket(url), behaviour, now: () => performance.now() }),
  );
  const timer = setInterval(() => {
    for (const bot of bots) bot.update();
  }, 4);
  return {
    bots,
    stop: () => {
      clearInterval(timer);
      for (const bot of bots) bot.close();
    },
  };
}

/** Puts the bots' ships in a ring, facing inwards, so the fight starts at once. */
function cluster(server: RunningServer, bots: Bot[]): void {
  bots.forEach((bot, i) => {
    const angle = (i / bots.length) * 2 * Math.PI;
    server.room.placeShip(bot.session.core.playerId, (ship) => ({
      ...ship,
      x: Math.sin(angle) * 150,
      y: 0,
      z: 4400 + Math.cos(angle) * 150,
      yaw: angle > Math.PI ? angle - Math.PI : angle + Math.PI,
      pitch: 0,
      roll: 0,
      invulnTicks: 0,
      hp: SIM.maxHp,
    }));
  });
}

describe.concurrent('headless bots over real WebSockets', () => {
  it(
    'one bot flies for 60 s with zero corrections',
    async () => {
      const server = await startServer({ port: 0, seed: 77 });
      const startedAtMs = performance.now();
      const { bots, stop } = fly(`ws://127.0.0.1:${server.port}/ws`, [wanderer(404)]);
      await sleep(FLIGHT_MS);
      const bot = bots[0];
      if (!bot) throw new Error('no bot');
      const core = bot.session.core;

      const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as {
        ok: boolean;
        players: number;
      };
      expect(health).toMatchObject({ ok: true, players: 1 });
      // Without the test-hooks flag the debug endpoints do not exist.
      expect((await fetch(`http://127.0.0.1:${server.port}/debug/truth`)).status).toBe(404);
      expect(
        (await fetch(`http://127.0.0.1:${server.port}/debug/place`, { method: 'POST', body: '{}' }))
          .status,
      ).toBe(404);

      const afterWarmUp = bot.corrections.filter((c) => c.timeMs - startedAtMs > WARM_UP_MS);
      console.log(
        `one bot: ${core.counters.inputsSent} inputs, ${core.counters.snapshots} snapshots, ` +
          `${bot.corrections.length} corrections (${afterWarmUp.length} after warm-up), ` +
          `server missed ${server.room.stats.missedInputs}, late ${server.room.stats.lateInputs}, ` +
          `rtt ${core.rttMs.toFixed(2)} ms, slack ${core.leadTicks.toFixed(2)} ticks`,
      );

      expect(core.status).toBe('playing');
      expect(core.counters.inputsSent).toBeGreaterThan(3400);
      expect(core.counters.snapshots).toBeGreaterThan(1700);
      expect(bot.corrections).toEqual([]);
      expect(server.room.stats.missedInputs).toBe(0);
      expect(server.room.stats.malformedMessages).toBe(0);
      expect(bot.session.reconnects).toBe(0);

      // The prediction and the server agree bit for bit at the last acknowledged tick.
      const predicted = core.predictedAt(core.ackTick);
      expect(predicted && core.ackState && shipStatesEqual(predicted, core.ackState)).toBe(true);
      stop();
      await server.close();
    },
    FLIGHT_MS + 15_000,
  );

  it(
    'four hunters for 60 s: all join, see each other, register kills, and the hit logs agree',
    async () => {
      const hits: HitRecord[] = [];
      const deaths: DeathRecord[] = [];
      const server = await startServer({
        port: 0,
        seed: 5,
        listener: { hit: (hit) => hits.push(hit), playerDied: (death) => deaths.push(death) },
      });
      const { bots, stop } = fly(`ws://127.0.0.1:${server.port}/ws`, [
        hunter(),
        hunter(),
        hunter(),
        hunter(),
      ]);
      await sleep(1000);
      expect(server.room.playerCount).toBe(4);
      cluster(server, bots);
      await sleep(FLIGHT_MS);

      const seen = bots.flatMap((bot) => bot.viewHits);
      const result = hitAgreement(seen, hits);
      const kills = deaths.filter((d) => d.cause === CAUSE_PLAYER);
      console.log(
        `four hunters: ${server.room.stats.bulletsFired} bullets, ${hits.length} server hits, ` +
          `${result.seen} seen by shooters, ${result.confirmed} of those confirmed ` +
          `(${(result.agreement * 100).toFixed(1)}%), ${result.unseen} server hits not seen, ` +
          `${kills.length} kills, server missed ${server.room.stats.missedInputs} inputs`,
      );

      for (const bot of bots) {
        const core = bot.session.core;
        expect(core.status).toBe('playing');
        expect(core.remoteViews()).toHaveLength(3);
        expect(core.kills).toBe(server.room.killsOf(core.playerId));
        expect(bot.session.reconnects).toBe(0);
      }
      expect(hits.length).toBeGreaterThan(10);
      expect(kills.length).toBeGreaterThanOrEqual(1);
      expect(result.seen).toBeGreaterThan(10);
      // In a free-for-all some hits land on a ship another bot has just destroyed.
      expect(result.agreement).toBeGreaterThanOrEqual(0.8);
      stop();
      await server.close();
    },
    FLIGHT_MS + 20_000,
  );

  it('four hunters through 200 ms with 2% of inputs and snapshots dropped: nobody ends in a wrong state', async () => {
    const deaths: DeathRecord[] = [];
    const server = await startServer({
      port: 0,
      seed: 6,
      listener: { playerDied: (death) => deaths.push(death) },
    });
    const proxy = await startProxy({ port: 0, target: `ws://127.0.0.1:${server.port}/ws` });
    const bots = [1, 2, 3, 4].map((seed) =>
      createBot({
        openSocket: () => new WebSocket(proxy.url('200ms-drop', seed)),
        behaviour: hunter(),
        now: () => performance.now(),
      }),
    );
    const timer = setInterval(() => {
      for (const bot of bots) bot.update();
    }, 4);
    await sleep(1500);
    expect(server.room.playerCount).toBe(4);
    cluster(server, bots);
    await sleep(40_000);
    // Let the last messages through, then compare.
    await sleep(1000);

    console.log(
      `drop mode: proxy forwarded ${proxy.stats.forwarded}, dropped ${proxy.stats.dropped}, ` +
        `stalled ${proxy.stats.stalled}; ${server.room.stats.hits} hits, ${deaths.length} deaths, ` +
        `server missed ${server.room.stats.missedInputs} inputs`,
    );
    expect(proxy.stats.dropped).toBeGreaterThan(100);
    expect(server.room.stats.hits).toBeGreaterThan(5);
    for (const bot of bots) {
      const core = bot.session.core;
      expect(core.status).toBe('playing');
      expect(bot.session.reconnects).toBe(0);
      const mine = server.room.shipOf(core.playerId);
      expect(core.ackState?.spawnSeq).toBe(mine?.spawnSeq);
      // No death was missed: each bot heard of every one.
      const told = bot.events.filter((e) => e.kind === 'death').map((e) => e.deathId);
      expect(told.sort()).toEqual(deaths.map((d) => d.deathId).sort());
      for (const view of core.remoteViews()) {
        expect(view.spawnSeq).toBe(server.room.shipOf(view.id)?.spawnSeq);
      }
    }
    clearInterval(timer);
    for (const bot of bots) bot.close();
    await proxy.close();
    await server.close();
  }, 60_000);
});
