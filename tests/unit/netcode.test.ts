import { describe, expect, it } from 'vitest';
import { wanderer } from '../../src/net/behaviours.ts';
import { TICK_MS } from '../../src/shared/constants.ts';
import { decodeClientMessage } from '../../src/shared/protocol.ts';
import { shipStatesEqual } from '../../src/shared/sim/ship.ts';
import type { ShipView } from '../../src/net/client.ts';
import type { Controls } from '../../src/shared/sim/ship.ts';
import { TestWorld, delay } from '../support/harness.ts';
import type { TestClient } from '../support/harness.ts';

const WARM_UP_MS = 2000;

/** Every acknowledged tick the client still remembers must equal the server's. */
function expectPredictionMatchesTruth(world: TestWorld, client: TestClient): number {
  const truth = world.truth.get(client.core.playerId);
  expect(truth).toBeDefined();
  let compared = 0;
  for (const snapshot of client.snapshots) {
    const predicted = client.core.predictedAt(snapshot.serverTick);
    const actual = truth?.get(snapshot.serverTick);
    if (!predicted || !actual) continue;
    expect(shipStatesEqual(predicted, actual)).toBe(true);
    compared++;
  }
  return compared;
}

describe('prediction on a clean link', () => {
  it('60 s of steering with no latency: zero corrections', () => {
    const world = new TestWorld(11);
    const client = world.addClient({ controls: wanderer(5) });
    world.run(60_000);

    expect(client.core.status).toBe('playing');
    expect(client.corrections).toEqual([]);
    expect(world.room.stats.missedInputs).toBe(0);
    expect(world.room.stats.lateInputs).toBe(0);
    expect(client.core.counters.inputsSent).toBeGreaterThan(3550);
    expect(client.snapshots.length).toBeGreaterThan(1750);
    expect(expectPredictionMatchesTruth(world, client)).toBeGreaterThan(400);
    // The ship really flew: it is far from where it spawned.
    const truth = world.truth.get(client.core.playerId);
    const first = truth?.get(10);
    const last = truth?.get(world.room.tick);
    expect(first && last && Math.hypot(last.x - first.x, last.z - first.z)).toBeGreaterThan(200);
  });

  it.each([
    ['30 fps (Low Power Mode)', 1000 / 30],
    ['100 fps (headless WebKit)', 10],
    ['120 fps', 1000 / 120],
  ])('zero corrections after warm-up at %s', (_name, frameMs) => {
    const world = new TestWorld(4);
    const client = world.addClient({ controls: wanderer(21), frameMs });
    world.run(30_000);
    const late = client.corrections.filter((c) => c.timeMs > WARM_UP_MS);
    expect(late).toEqual([]);
    expect(expectPredictionMatchesTruth(world, client)).toBeGreaterThan(400);
  });
});

describe('prediction with latency and jitter', () => {
  it.each([
    ['100 ms ± 20 ms round trip', 50, 10],
    ['200 ms ± 50 ms round trip', 100, 25],
  ])('%s: zero corrections once no input arrives late', (_name, oneWayMs, jitterMs) => {
    const world = new TestWorld(8);
    const client = world.addClient({
      controls: wanderer(13),
      link: { up: delay(oneWayMs, jitterMs, 101), down: delay(oneWayMs, jitterMs, 202) },
    });
    world.run(WARM_UP_MS);
    const missedInWarmUp = world.room.stats.missedInputs;
    world.run(60_000);

    // The claim under test: a correction happens only when an input was late.
    expect(world.room.stats.missedInputs - missedInWarmUp).toBe(0);
    expect(client.corrections.filter((c) => c.timeMs > WARM_UP_MS)).toEqual([]);
    expect(expectPredictionMatchesTruth(world, client)).toBeGreaterThan(400);

    // The round-trip estimate is close to the real figure.
    expect(client.core.rttMs).toBeGreaterThan(oneWayMs * 2 - 2 * jitterMs - TICK_MS);
    expect(client.core.rttMs).toBeLessThan(oneWayMs * 2 + 2 * jitterMs + 2 * TICK_MS);
  });
});

describe('the tick clock', () => {
  it.each([
    ['a clean link at 60 fps', 0, 0, 1000 / 60],
    ['a clean link at 100 fps', 0, 0, 10],
    ['a clean link at 30 fps', 0, 0, 1000 / 30],
    ['100 ms ± 20 ms', 50, 10, 1000 / 60],
    ['200 ms ± 50 ms', 100, 25, 1000 / 60],
    ['200 ms ± 50 ms at 100 fps', 100, 25, 10],
  ])(
    'settles on %s: steady rate, worst slack just above two ticks',
    (_name, oneWayMs, jitterMs, frameMs) => {
      const world = new TestWorld(8);
      const client = world.addClient({
        controls: wanderer(13),
        frameMs,
        link: oneWayMs
          ? { up: delay(oneWayMs, jitterMs, 101), down: delay(oneWayMs, jitterMs, 202) }
          : {},
      });
      world.run(10_000);

      // From ten seconds on, look once a second for the rest of a minute.
      let worstRateError = 0;
      let lowestSlack = Infinity;
      let highestTypical = 0;
      for (let second = 10; second < 60; second++) {
        world.run(1000);
        worstRateError = Math.max(worstRateError, Math.abs(client.core.rate - 1));
        lowestSlack = Math.min(lowestSlack, client.core.leadLowTicks);
        highestTypical = Math.max(highestTypical, client.core.leadTicks);
      }
      // The clock is not hunting: it never runs more than 0.2% off real time.
      expect(worstRateError).toBeLessThan(0.002);
      // The worst recent input still had about two ticks in hand, and no more than 3.5.
      expect(lowestSlack).toBeGreaterThan(1.8);
      expect(client.core.leadLowTicks).toBeLessThan(3.5);
      // Typical slack covers the jitter and stays well under the cap of six.
      expect(highestTypical).toBeLessThan(2 + 1.25 + (2 * jitterMs) / TICK_MS + 0.5);
      expect(highestTypical).toBeLessThanOrEqual(6);
      // And nothing was late at any point, including the first seconds.
      expect(world.room.stats.missedInputs).toBe(0);
      expect(client.corrections).toEqual([]);
    },
  );

  it('gives up slack it no longer needs when the link improves', () => {
    const world = new TestWorld(8);
    let jitterMs = 25;
    let seed = 1;
    const jittery = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return 60 + (seed / 4294967296) * 2 * jitterMs;
    };
    const client = world.addClient({
      controls: wanderer(13),
      link: { up: jittery, down: jittery },
    });
    world.run(15_000);
    const aheadBefore = client.core.tick - world.room.tick;
    jitterMs = 0;
    world.run(1000);
    // With the jitter gone every input arrives early: far more slack than needed.
    expect(client.snapshots[client.snapshots.length - 1]?.inputLead).toBeGreaterThan(4);
    world.run(20_000);
    // The clock slowed until the worst case was back near two ticks.
    expect(aheadBefore - (client.core.tick - world.room.tick)).toBeGreaterThanOrEqual(1);
    expect(client.core.leadLowTicks).toBeGreaterThan(1.8);
    expect(client.core.leadLowTicks).toBeLessThan(3.5);
    expect(world.room.stats.missedInputs).toBe(0);
  });

  it('caps the slack on a link too erratic to cover, and accepts late inputs instead', () => {
    const world = new TestWorld(8);
    // Now and then a message takes 250 ms longer: far more than six ticks.
    let count = 0;
    const client = world.addClient({
      controls: wanderer(13),
      link: { up: () => (count++ % 97 === 0 ? 270 : 20), down: () => 20 },
    });
    world.run(30_000);
    expect(client.core.leadTicks).toBeLessThanOrEqual(6.5);
    expect(world.room.stats.missedInputs).toBeGreaterThan(0);
    expect(client.core.status).toBe('playing');
  });
});

describe('death and respawn through the client', () => {
  it('predicts its own death, is teleported once at respawn, and never draws the jump as motion', () => {
    const world = new TestWorld(5);
    // Steer at the planet using the client's own predicted state.
    const holder: { client?: TestClient } = {};
    let previous: ShipView | null = null;
    let jumps = 0;
    let framesDead = 0;
    let worstOrdinaryMove = 0;
    const client = world.addClient({
      // Look at what a renderer would draw, once per frame.
      onFrame: (core) => {
        const view = core.view();
        if (view && previous) {
          const moved = Math.hypot(view.x - previous.x, view.y - previous.y, view.z - previous.z);
          if (moved > 500) jumps++;
          else worstOrdinaryMove = Math.max(worstOrdinaryMove, moved);
          if (!view.alive) framesDead++;
        }
        previous = view;
      },
      controls: (): Controls => {
        const ship = holder.client?.core.state;
        if (!ship?.alive) return { yaw: 0, pitch: 0, throttle: 1, fire: false };
        let error = Math.atan2(-ship.x, -ship.z) - ship.yaw;
        if (error > Math.PI) error -= 2 * Math.PI;
        if (error < -Math.PI) error += 2 * Math.PI;
        return { yaw: Math.max(-1, Math.min(1, error * 4)), pitch: 0, throttle: 1, fire: false };
      },
      link: { up: delay(50, 10, 7), down: delay(50, 10, 8) },
    });
    holder.client = client;

    world.run(100_000);

    const truth = world.truth.get(client.core.playerId);
    const deaths = [...(truth?.entries() ?? [])].filter(
      ([tick, ship]) => !ship.alive && truth?.get(tick - 1)?.alive === true,
    );
    expect(deaths).toHaveLength(1);

    // Death was predicted on the same tick: no correction of any kind for it.
    const ordinary = client.corrections.filter((c) => !c.teleport);
    expect(ordinary).toEqual([]);
    // Respawn is the server's decision: exactly one flagged jump.
    expect(client.corrections).toHaveLength(1);
    expect(client.core.counters.teleports).toBe(1);
    const deathTick = deaths[0]?.[0] ?? 0;
    expect(client.corrections[0]?.ackTick).toBeGreaterThanOrEqual(deathTick + 180);
    expect(client.corrections[0]?.ackTick).toBeLessThanOrEqual(deathTick + 181);

    // The drawn ship was hidden for about three seconds, jumped once, and
    // otherwise never moved further in a frame than a ship can fly.
    expect(framesDead).toBeGreaterThan(170);
    expect(framesDead).toBeLessThan(200);
    expect(jumps).toBe(1);
    expect(worstOrdinaryMove).toBeLessThan(1.5 * 60 * (TICK_MS / 1000));

    // After the respawn the client is flying the new ship in step with the server.
    expect(client.core.state?.alive).toBe(true);
    expect(client.core.state?.spawnSeq).toBe(1);
    const predicted = client.core.predictedAt(client.core.ackTick);
    const actual = truth?.get(client.core.ackTick);
    expect(predicted && actual && shipStatesEqual(predicted, actual)).toBe(true);
  });
});

describe('reconciliation', () => {
  it('an input that never arrives in time gives exactly one correction, then matches again', () => {
    const TAP_TICK = 301;
    const world = new TestWorld(2);
    let dropped = 0;
    const client = world.addClient({
      // One tick of full left turn; everything else is neutral.
      controls: (tick): Controls => ({
        yaw: tick === TAP_TICK ? 1 : 0,
        pitch: 0,
        throttle: 0,
        fire: false,
      }),
      link: {
        // Lose every message that carries the tap (the original and its two
        // redundant copies), so the server has to reuse the previous input.
        up: (data) => {
          const message = decodeClientMessage(data);
          if (message?.type !== 'input') return 0;
          const carriesTap =
            message.tick >= TAP_TICK && message.tick - message.inputs.length < TAP_TICK;
          if (carriesTap) dropped++;
          return carriesTap ? null : 0;
        },
      },
    });
    world.run(10_000);

    expect(dropped).toBe(3);
    expect(world.room.stats.missedInputs).toBeGreaterThanOrEqual(1);
    expect(client.corrections).toHaveLength(1);
    const [correction] = client.corrections;
    expect(correction?.teleport).toBe(false);
    expect(correction?.ackTick).toBeGreaterThanOrEqual(TAP_TICK);
    expect(correction?.ackTick).toBeLessThan(TAP_TICK + 2);
    // One tick of turning at 20 u/s is a small error.
    expect(correction?.distance).toBeGreaterThan(0);
    expect(correction?.distance).toBeLessThan(0.5);

    // After the replay the client equals the server at every later acknowledged tick.
    const truth = world.truth.get(client.core.playerId);
    const after = client.snapshots.filter((s) => s.serverTick > (correction?.ackTick ?? 0));
    expect(after.length).toBeGreaterThan(100);
    for (const snapshot of after) {
      const predicted = client.core.predictedAt(snapshot.serverTick);
      const actual = truth?.get(snapshot.serverTick);
      if (!predicted || !actual) continue;
      expect(shipStatesEqual(predicted, actual)).toBe(true);
    }
    // The server never saw the tap, so the ship did not turn.
    expect(world.room.shipOf(client.core.playerId)?.yaw).toBe(0);
    expect(client.core.state?.yaw).toBe(0);
  });

  it('one lost message is covered by the redundant copies: no correction', () => {
    const world = new TestWorld(2);
    let dropped = 0;
    const client = world.addClient({
      controls: wanderer(31),
      link: {
        up: (data) => {
          const message = decodeClientMessage(data);
          if (message?.type === 'input' && message.tick % 50 === 0) {
            dropped++;
            return null;
          }
          return 0;
        },
      },
    });
    world.run(20_000);
    expect(dropped).toBeGreaterThan(15);
    expect(world.room.stats.missedInputs).toBe(0);
    expect(client.corrections).toEqual([]);
  });

  it('a lost snapshot changes nothing', () => {
    const world = new TestWorld(2);
    let count = 0;
    const client = world.addClient({
      controls: wanderer(32),
      link: { down: (_data, channel) => (channel === 'droppable' && count++ % 7 === 3 ? null : 0) },
    });
    world.run(20_000);
    expect(client.corrections).toEqual([]);
    expect(expectPredictionMatchesTruth(world, client)).toBeGreaterThan(300);
  });

  it('a 300 ms upstream stall causes corrections, and then prediction matches again', () => {
    const world = new TestWorld(6);
    let stallUntilMs = 0;
    const client = world.addClient({
      controls: wanderer(41),
      // During the stall nothing gets through, then it all arrives at once.
      link: { up: () => Math.max(0, stallUntilMs - world.clock.now()) },
    });
    world.run(5000);
    expect(client.corrections).toEqual([]);

    stallUntilMs = world.clock.now() + 300;
    world.run(5000);
    expect(world.room.stats.missedInputs).toBeGreaterThan(5);
    expect(client.corrections.length).toBeGreaterThan(0);
    const lastCorrectionMs = Math.max(...client.corrections.map((c) => c.timeMs));
    expect(lastCorrectionMs).toBeLessThan(5000 + 300 + 500);
    expect(Math.max(...client.corrections.map((c) => c.distance))).toBeLessThan(20);
    expect(client.core.counters.resyncs).toBe(0);

    const missedBefore = world.room.stats.missedInputs;
    const correctionsBefore = client.corrections.length;
    world.run(10_000);
    expect(world.room.stats.missedInputs).toBe(missedBefore);
    expect(client.corrections).toHaveLength(correctionsBefore);
    const predictedNow = client.core.predictedAt(world.room.tick);
    const actualNow = world.truth.get(client.core.playerId)?.get(world.room.tick);
    expect(predictedNow && actualNow && shipStatesEqual(predictedNow, actualNow)).toBe(true);
  });

  it('a frozen client skips ahead instead of replaying the gap', () => {
    const world = new TestWorld(6);
    // Flying straight, so repeating the last input is exactly what happened.
    const client = world.addClient();
    world.run(3000);
    client.pause();
    world.run(1500);
    client.resume();
    world.run(5000);

    expect(client.core.counters.skippedTicks).toBeGreaterThan(80);
    expect(client.core.tick).toBeGreaterThan(world.room.tick);
    expect(client.corrections).toEqual([]);
    expect(client.core.counters.inputsSent).toBeLessThan((3000 + 5000) / TICK_MS + 10);
  });

  it('a client whose clock runs 10% slow resyncs and keeps playing', () => {
    const world = new TestWorld(6);
    const client = world.addClient({ controls: wanderer(51), clockRate: 0.9 });
    world.run(30_000);
    expect(client.core.status).toBe('playing');
    expect(client.core.counters.resyncs).toBeGreaterThan(0);
    // It never drifts far: the server keeps hearing from it.
    expect(client.core.tick).toBeGreaterThan(world.room.tick - 30);
    expect(world.room.shipOf(client.core.playerId)?.alive).toBe(true);
  });
});

describe('drawing the own ship', () => {
  it('the view moves smoothly between ticks at 120 fps', () => {
    const world = new TestWorld(4);
    const client = world.addClient({
      controls: () => ({ yaw: 0, pitch: 0, throttle: 0, fire: false }),
      frameMs: 1000 / 120,
    });
    world.run(3000);
    const seen: number[] = [];
    world.clock.every(1000 / 120, () => {
      const view = client.core.view();
      if (view) seen.push(view.z);
    });
    world.run(1000);
    expect(seen.length).toBeGreaterThan(100);
    // 20 u/s at 120 fps is one sixth of a unit per frame, every frame.
    for (let i = 1; i < seen.length; i++) {
      expect((seen[i] ?? 0) - (seen[i - 1] ?? 0)).toBeCloseTo(20 / 120, 2);
    }
  });

  it('a correction does not move the drawn ship at once; the offset fades', () => {
    const TAP_TICK = 301;
    const world = new TestWorld(2);
    let previous: ShipView | null = null;
    let worstJump = 0;
    let frames = 0;
    const client = world.addClient({
      onFrame: (core) => {
        const view = core.view();
        if (view && previous) {
          const moved = Math.hypot(view.x - previous.x, view.y - previous.y, view.z - previous.z);
          // Never more than 1.5× a frame of travel at the current speed.
          worstJump = Math.max(worstJump, moved - 1.5 * view.speed * (TICK_MS / 1000));
          frames++;
        }
        previous = view;
      },
      controls: (tick): Controls => ({
        yaw: tick >= TAP_TICK && tick < TAP_TICK + 3 ? 1 : 0,
        pitch: 0,
        throttle: 1,
        fire: false,
      }),
      link: {
        up: (data) => {
          const message = decodeClientMessage(data);
          return message?.type === 'input' &&
            message.tick >= TAP_TICK &&
            message.tick < TAP_TICK + 8
            ? null
            : 0;
        },
      },
    });
    world.run(10_000);
    expect(client.corrections.length).toBeGreaterThan(0);
    expect(frames).toBeGreaterThan(500);
    expect(worstJump).toBeLessThanOrEqual(0);
    // Long after the correction the drawn ship is the predicted ship.
    const view = client.core.view();
    const state = client.core.state;
    expect(view && state && Math.abs(view.x - state.x)).toBeLessThan(1);
  });
});
