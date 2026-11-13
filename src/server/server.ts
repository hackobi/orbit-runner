// The game server process: one room, a WebSocket endpoint at /ws, and an
// HTTP health check.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { TICK_RATE } from '../shared/constants.ts';
import { MAX_CLIENT_MESSAGE_BYTES, PROTOCOL_VERSION } from '../shared/protocol.ts';
import { Room } from './room.ts';
import { ServerSocketTransport } from './wsTransport.ts';

export interface ServerOptions {
  /** 0 picks a free port. */
  port: number;
  host?: string;
  seed?: number;
}

export interface RunningServer {
  readonly room: Room;
  readonly port: number;
  close(): Promise<void>;
}

/** How often the loop checks whether a tick is due. The room decides how many run. */
const POLL_MS = 1;

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const room = new Room({
    now: () => performance.now(),
    seed: options.seed ?? (Date.now() ^ (process.pid << 16)) >>> 0,
  });

  const http = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(
        JSON.stringify({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          tickRate: TICK_RATE,
          tick: room.tick,
          players: room.playerCount,
          stats: room.stats,
        }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
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
