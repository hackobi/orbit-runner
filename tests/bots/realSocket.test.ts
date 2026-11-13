import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClientCore } from '../../src/net/client.ts';
import type { CorrectionEvent } from '../../src/net/client.ts';
import { WebSocketTransport } from '../../src/net/wsTransport.ts';
import { shipStatesEqual } from '../../src/shared/sim/ship.ts';
import { startServer } from '../../src/server/server.ts';
import type { RunningServer } from '../../src/server/server.ts';
import { wanderingControls } from '../support/harness.ts';

// Real sockets and real timers: this takes as long as it says.
const FLIGHT_MS = 60_000;
const WARM_UP_MS = 2000;

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({ port: 0, seed: 77 });
});

afterAll(async () => {
  await server.close();
});

describe('a headless bot over a real WebSocket', () => {
  it(
    'flies for 60 s with zero corrections',
    async () => {
      const corrections: CorrectionEvent[] = [];
      const core = new ClientCore({
        transport: new WebSocketTransport(new WebSocket(`ws://127.0.0.1:${server.port}/ws`)),
        now: () => performance.now(),
        controls: wanderingControls(404),
        onCorrection: (event) => corrections.push(event),
      });
      const startedAtMs = performance.now();
      const frames = setInterval(() => {
        core.update();
      }, 4);
      await new Promise((resolve) => setTimeout(resolve, FLIGHT_MS));
      clearInterval(frames);

      const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as {
        ok: boolean;
        players: number;
      };
      expect(health).toMatchObject({ ok: true, players: 1 });

      const afterWarmUp = corrections.filter((c) => c.timeMs - startedAtMs > WARM_UP_MS);
      console.log(
        `real socket: ${core.counters.inputsSent} inputs, ${core.counters.snapshots} snapshots, ` +
          `${corrections.length} corrections (${afterWarmUp.length} after warm-up), ` +
          `server missed ${server.room.stats.missedInputs}, late ${server.room.stats.lateInputs}, ` +
          `rtt ${core.rttMs.toFixed(2)} ms, slack ${core.leadTicks.toFixed(2)} ticks`,
      );

      expect(core.status).toBe('playing');
      expect(core.counters.inputsSent).toBeGreaterThan(3400);
      expect(core.counters.snapshots).toBeGreaterThan(1700);
      expect(corrections).toEqual([]);
      expect(server.room.stats.missedInputs).toBe(0);
      expect(server.room.stats.malformedMessages).toBe(0);

      // The prediction and the server agree bit for bit at the last acknowledged tick.
      const predicted = core.predictedAt(core.ackTick);
      expect(predicted && core.ackState && shipStatesEqual(predicted, core.ackState)).toBe(true);
      core.close();
    },
    FLIGHT_MS + 15_000,
  );
});
