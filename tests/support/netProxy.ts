// A WebSocket proxy that sits between a client and the game server and
// makes the link worse in a controlled, repeatable way. It is a separate
// piece from the server, works the same for every browser, and draws its
// randomness from a seed.
//
// A client picks its conditions in the URL it connects to:
//   ws://127.0.0.1:<port>/ws?profile=100ms&seed=7

import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { Rng } from '../../src/shared/rng.ts';

export interface NetProfile {
  /** Delay in each direction, milliseconds. The round trip is twice this. */
  oneWayMs: number;
  /** Each message's delay varies by up to this much either way. */
  jitterMs: number;
  /** Share of messages that are "lost". */
  loss: number;
  /**
   * What losing a message means.
   * - stall: it arrives late by `stallMs`, and everything behind it waits,
   *   as on a real WebSocket, where TCP resends and delivers in order.
   * - drop: inputs and snapshots are discarded; other messages stall.
   */
  lossMode: 'stall' | 'drop';
  /** How late a stalled message is: about one round trip plus a retransmission timer. */
  stallMs: number;
}

/**
 * The brief's three profiles. Latency figures are round trip (decision D3):
 * "100 ms ± 20 ms" is 50 ± 10 each way. Loss is a TCP-style stall (decision D4).
 */
export const NET_PROFILES = {
  clean: { oneWayMs: 0, jitterMs: 0, loss: 0, lossMode: 'stall', stallMs: 0 },
  '100ms': { oneWayMs: 50, jitterMs: 10, loss: 0, lossMode: 'stall', stallMs: 0 },
  '200ms-lossy': { oneWayMs: 100, jitterMs: 25, loss: 0.02, lossMode: 'stall', stallMs: 260 },
  /** Not one of the brief's profiles: real loss, to prove the protocol survives it. */
  '200ms-drop': { oneWayMs: 100, jitterMs: 25, loss: 0.02, lossMode: 'drop', stallMs: 260 },
} as const satisfies Record<string, NetProfile>;

export type NetProfileName = keyof typeof NET_PROFILES;

export interface ProxyStats {
  connections: number;
  forwarded: number;
  stalled: number;
  dropped: number;
}

export interface RunningProxy {
  readonly port: number;
  readonly stats: ProxyStats;
  /** The URL a client should connect to for the given conditions. */
  url(profile: NetProfileName, seed: number): string;
  /** Cuts every client connection, as a network drop would. */
  dropClients(): void;
  close(): Promise<void>;
}

const CLIENT_INPUT = 2;
const SERVER_SNAPSHOT = 3;

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}

/**
 * One direction of one connection: delays messages and keeps them in order.
 * Order is kept by construction: messages wait in one queue and are handed
 * over from its head by a single timer, so two messages due at the same
 * moment can never swap.
 */
class Lane {
  private lastDeliveryMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly queue: { dueMs: number; data: Buffer }[] = [];
  private readonly profile: NetProfile;
  private readonly rng: Rng;
  private readonly droppableType: number;
  private readonly stats: ProxyStats;
  private readonly deliver: (data: Buffer) => void;

  constructor(
    profile: NetProfile,
    seed: number,
    droppableType: number,
    stats: ProxyStats,
    deliver: (data: Buffer) => void,
  ) {
    this.profile = profile;
    this.rng = new Rng(seed);
    this.droppableType = droppableType;
    this.stats = stats;
    this.deliver = deliver;
  }

  push(data: Buffer): void {
    const profile = this.profile;
    let delay = profile.oneWayMs + (this.rng.next() * 2 - 1) * profile.jitterMs;
    if (profile.loss > 0 && this.rng.next() < profile.loss) {
      if (profile.lossMode === 'drop' && data[0] === this.droppableType) {
        this.stats.dropped += 1;
        return;
      }
      this.stats.stalled += 1;
      delay += profile.stallMs;
    }
    const now = performance.now();
    // A message never overtakes the one before it.
    this.lastDeliveryMs = Math.max(this.lastDeliveryMs, now + delay);
    this.stats.forwarded += 1;
    this.queue.push({ dueMs: this.lastDeliveryMs, data });
    // Due times never decrease, so a timer already set for the head still
    // holds. Only start one if none is running.
    if (!this.timer) this.drain();
  }

  private readonly drain = (): void => {
    this.timer = null;
    const now = performance.now();
    for (let head = this.queue[0]; head && head.dueMs <= now; head = this.queue[0]) {
      this.queue.shift();
      this.deliver(head.data);
    }
    const next = this.queue[0];
    if (next) this.timer = setTimeout(this.drain, Math.max(0, next.dueMs - performance.now()));
  };

  /** Drops whatever is still waiting. Called when the connection ends. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
  }
}

export function startProxy(options: { port: number; target: string }): Promise<RunningProxy> {
  const stats: ProxyStats = { connections: 0, forwarded: 0, stalled: 0, dropped: 0 };
  const server = new WebSocketServer({ port: options.port, host: '127.0.0.1', path: '/ws' });

  server.on('connection', (client, request) => {
    const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
    const name = query.get('profile') ?? 'clean';
    const profile: NetProfile =
      name in NET_PROFILES ? NET_PROFILES[name as NetProfileName] : NET_PROFILES.clean;
    const seed = Number(query.get('seed') ?? 1);
    stats.connections += 1;

    const upstream = new WebSocket(options.target, { perMessageDeflate: false });
    const waiting: Buffer[] = [];
    const up = new Lane(profile, seed, CLIENT_INPUT, stats, (data) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: true });
      else if (upstream.readyState === WebSocket.CONNECTING) waiting.push(data);
    });
    const down = new Lane(profile, seed + 7919, SERVER_SNAPSHOT, stats, (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true });
    });

    upstream.on('open', () => {
      for (const data of waiting) upstream.send(data, { binary: true });
      waiting.length = 0;
    });
    client.on('message', (data) => {
      up.push(toBuffer(data));
    });
    upstream.on('message', (data) => {
      down.push(toBuffer(data));
    });
    client.on('close', () => {
      up.stop();
      upstream.close();
    });
    upstream.on('close', () => {
      down.stop();
      client.close();
    });
    client.on('error', () => {
      upstream.terminate();
    });
    upstream.on('error', () => {
      client.terminate();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port,
        stats,
        url: (profile, seed) => `ws://127.0.0.1:${port}/ws?profile=${profile}&seed=${seed}`,
        dropClients: () => {
          for (const client of server.clients) client.terminate();
        },
        close: () =>
          new Promise<void>((done) => {
            for (const client of server.clients) client.terminate();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
