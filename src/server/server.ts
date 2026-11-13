// The game server process: one room, a WebSocket endpoint at /ws, and an
// HTTP health check.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { SIM, TICK_RATE } from '../shared/constants.ts';
import {
  MAX_CLIENT_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  SESSION_TOKEN_BYTES,
} from '../shared/protocol.ts';
import type { ShipState } from '../shared/sim/ship.ts';
import { Recorder } from './recorder.ts';
import { Room } from './room.ts';
import type { RoomListener } from './room.ts';
import { ServerSocketTransport } from './wsTransport.ts';

export interface ServerOptions {
  /** 0 picks a free port. */
  port: number;
  host?: string;
  seed?: number;
  /**
   * Adds the /debug endpoints: reading what the server simulated, moving
   * ships, and keeping them alive. For tests only. Without it those paths do
   * not exist.
   */
  testHooks?: boolean;
  listener?: RoomListener;
  /** Passed to the room. See RoomOptions. */
  onTick?: (tick: number, room: Room) => void;
  onWork?: (durationMs: number, ticks: number) => void;
}

export interface RunningServer {
  readonly room: Room;
  readonly port: number;
  close(): Promise<void>;
}

/** How often the loop checks whether a tick is due. The room decides how many run. */
const POLL_MS = 1;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 10_000) reject(new Error('body too large'));
    });
    request.on('end', () => {
      resolve(body);
    });
    request.on('error', reject);
  });
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const recorder = options.testHooks ? new Recorder() : null;
  // Test hook: while on, every living ship is topped up each tick, so a
  // measurement can run for as long as it needs without anyone dying.
  let sustain = false;
  const room: Room = new Room({
    now: () => performance.now(),
    seed: options.seed ?? (Date.now() ^ (process.pid << 16)) >>> 0,
    createToken: () => randomBytes(SESSION_TOKEN_BYTES),
    ...(recorder
      ? {
          listener: recorder.listener,
          onTick: (tick, current) => {
            recorder.onTick(tick, current);
            if (!sustain) return;
            for (const id of current.playerIds()) {
              current.placeShip(id, (ship) =>
                ship.alive && ship.hp < SIM.maxHp ? { ...ship, hp: SIM.maxHp } : ship,
              );
            }
          },
        }
      : {}),
    ...(options.listener ? { listener: options.listener } : {}),
    ...(options.onTick ? { onTick: options.onTick } : {}),
    ...(options.onWork ? { onWork: options.onWork } : {}),
  });

  /** Test-only endpoints. Returns false if the request was not one of them. */
  const handleDebug = async (
    recorderInUse: Recorder,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    if (request.method === 'GET' && url.pathname === '/debug/truth') {
      const from = Number(url.searchParams.get('from') ?? 0);
      const to = Number(url.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER);
      sendJson(response, 200, recorderInUse.read(room, from, to));
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/debug/place') {
      // Body: { id, ship: { x, y, z, yaw, ... } }. Fields given replace the ship's.
      const body = JSON.parse(await readBody(request)) as { id: number; ship: Partial<ShipState> };
      room.placeShip(body.id, (ship) => ({ ...ship, ...body.ship }));
      sendJson(response, 200, { ok: true, tick: room.tick, ship: room.shipOf(body.id) ?? null });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/debug/sustain') {
      sustain = (JSON.parse(await readBody(request)) as { on: boolean }).on;
      sendJson(response, 200, { ok: true, sustain });
      return true;
    }
    return false;
  };

  const http = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        tickRate: TICK_RATE,
        tick: room.tick,
        players: room.playerCount,
        stats: room.stats,
      });
      return;
    }
    const notFound = (): void => {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    };
    if (!recorder) {
      notFound();
      return;
    }
    handleDebug(recorder, url, request, response)
      .then((handled) => {
        if (!handled) notFound();
      })
      .catch((error: unknown) => {
        sendJson(response, 400, { ok: false, error: String(error) });
      });
  });

  const sockets = new WebSocketServer({
    server: http,
    path: '/ws',
    // Anything larger than a real client message is refused before it is read.
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  sockets.on('connection', (socket) => {
    room.connect(new ServerSocketTransport(socket));
  });

  let timer: NodeJS.Timeout | null = null;
  const loop = (): void => {
    room.advance();
    timer = setTimeout(loop, POLL_MS);
  };

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host ?? '127.0.0.1', () => {
      loop();
      resolve({
        room,
        port: (http.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            if (timer) clearTimeout(timer);
            for (const client of sockets.clients) client.terminate();
            sockets.close(() => {
              http.close(() => {
                done();
              });
            });
          }),
      });
    });
  });
}
