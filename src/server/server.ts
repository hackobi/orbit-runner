// The game server process: one room, a WebSocket endpoint at /ws, an HTTP
// health check and, when given a built client, the game's own files.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { SIM, TICK_RATE } from '../shared/constants.ts';
import {
  MAX_CLIENT_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  SESSION_TOKEN_BYTES,
} from '../shared/protocol.ts';
import type { ShipState } from '../shared/sim/ship.ts';
import type { MemoryCrateStore } from './crates.ts';
import type { PilotStore } from './pilots.ts';
import { Recorder } from './recorder.ts';
import { Room } from './room.ts';
import type { RoomListener, RoomOptions } from './room.ts';
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
  /**
   * A built client (`npm run build` makes `dist/`) to serve from this server,
   * so that the page and its game socket share one address. Without it only
   * /health and /ws answer.
   */
  clientDir?: string;
  listener?: RoomListener;
  /** Raiders and the Warlord (RoomOptions.npcs). Off unless asked for. */
  npcs?: boolean;
  /** Where pilots' progress is kept (RoomOptions.pilots). */
  pilots?: PilotStore;
  /** Where salvage crates are held (RoomOptions.crates). Without it nothing drops. */
  crates?: MemoryCrateStore;
  /**
   * What SpaceFort's server must send to redeem a claim code. Without it
   * /api/redeem refuses everyone: crates can be won and shown, not moved.
   */
  bridgeSecret?: string;
  /** Passed to the room (RoomOptions.crateOdds): for trying drops out, never for a public server. */
  crateOdds?: RoomOptions['crateOdds'];
  /** Passed to the room. See RoomOptions. */
  onTick?: (tick: number, room: Room) => void;
  onWork?: (durationMs: number, ticks: number) => void;
}

export interface RunningServer {
  readonly room: Room;
  readonly port: number;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Serves one file of the built client, or returns false if there is none.
 * Files under assets/ carry a hash in their name and never change; anything
 * else (the page, the service worker, the manifest) must be checked on every
 * load, or an update would never reach the player.
 */
async function serveClientFile(
  clientDir: string,
  pathname: string,
  response: ServerResponse,
): Promise<boolean> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return false;
  }
  const file = path.resolve(clientDir, '.' + relative);
  if (!file.startsWith(clientDir + path.sep)) return false;
  const type = CONTENT_TYPES[path.extname(file)];
  if (!type) return false;
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return false;
  }
  response.writeHead(200, {
    'content-type': type,
    'cache-control': relative.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  response.end(body);
  return true;
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
  const clientDir = options.clientDir ? path.resolve(options.clientDir) : null;
  // Test hook: while on, every living ship is topped up each tick, so a
  // measurement can run for as long as it needs without anyone dying.
  let sustain = false;
  const room: Room = new Room({
    now: () => performance.now(),
    seed: options.seed ?? (Date.now() ^ (process.pid << 16)) >>> 0,
    createToken: () => randomBytes(SESSION_TOKEN_BYTES),
    npcs: options.npcs ?? false,
    ...(options.pilots ? { pilots: options.pilots } : {}),
    ...(options.crates ? { crates: options.crates } : {}),
    ...(options.crateOdds ? { crateOdds: options.crateOdds } : {}),
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
    if (request.method === 'POST' && url.pathname === '/debug/score') {
      // Body: { id, points }. Adds to the player's score.
      const body = JSON.parse(await readBody(request)) as { id: number; points: number };
      room.addScore(body.id, body.points);
      sendJson(response, 200, { ok: true, score: room.scoreOf(body.id) });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/debug/release') {
      room.releaseDroppedSeats();
      sendJson(response, 200, { ok: true, players: room.playerCount });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/debug/sustain') {
      sustain = (JSON.parse(await readBody(request)) as { on: boolean }).on;
      sendJson(response, 200, { ok: true, sustain });
      return true;
    }
    return false;
  };

  /** The two halves of a claim: the pilot asks for a code, SpaceFort's server redeems it. */
  const handleCrates = async (
    crates: MemoryCrateStore,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    if (request.method !== 'POST') return false;
    if (url.pathname === '/api/claim-code') {
      const body = JSON.parse(await readBody(request)) as { pilotKey?: unknown };
      if (typeof body.pilotKey !== 'string' || !/^[0-9a-f]{32}$/.test(body.pilotKey)) {
        sendJson(response, 400, { ok: false, error: 'not a pilot key' });
        return true;
      }
      const issued = crates.issueCode(body.pilotKey);
      sendJson(response, 200, issued ? { ok: true, ...issued } : { ok: true, crates: 0 });
      return true;
    }
    if (url.pathname === '/api/redeem') {
      const sent = request.headers['x-bridge-secret'];
      const secret = Buffer.from(options.bridgeSecret ?? '');
      const given = Buffer.from(typeof sent === 'string' ? sent : '');
      if (
        secret.length === 0 ||
        given.length !== secret.length ||
        !timingSafeEqual(given, secret)
      ) {
        sendJson(response, 403, { ok: false, error: 'not allowed' });
        return true;
      }
      const body = JSON.parse(await readBody(request)) as { code?: unknown };
      const code =
        typeof body.code === 'string' ? body.code.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';
      const redemption = crates.redeem(code);
      if (redemption) sendJson(response, 200, { ok: true, ...redemption });
      else sendJson(response, 404, { ok: false, error: 'no such code, or it has expired' });
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
        // Not a secret: every client is sent these in its welcome.
        worldSeed: room.world.seed,
        asteroidCount: room.world.belt.asteroids.length,
        stats: room.stats,
      });
      return;
    }
    const notFound = (): void => {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    };
    const handle = async (): Promise<boolean> => {
      if (options.crates && (await handleCrates(options.crates, url, request, response))) {
        return true;
      }
      if (recorder && (await handleDebug(recorder, url, request, response))) return true;
      if (clientDir && (request.method === 'GET' || request.method === 'HEAD')) {
        return serveClientFile(clientDir, url.pathname, response);
      }
      return false;
    };
    handle()
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
