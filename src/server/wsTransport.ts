// Server side of the WebSocket transport, on the `ws` library.

import type { WebSocket } from 'ws';
import type { Channel, Transport } from '../shared/transport.ts';

/**
 * If a client is this far behind on reading, stop queueing snapshots for it.
 * The protocol tolerates missing snapshots; it would not tolerate the server
 * running out of memory for one slow connection.
 */
const MAX_BUFFERED_BYTES = 256 * 1024;

const EMPTY = new Uint8Array(0);

export class ServerSocketTransport implements Transport {
  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
  }

  send(data: Uint8Array, channel: Channel): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    if (channel === 'droppable' && this.socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    this.socket.send(data, { binary: true });
  }

  onMessage(cb: (data: Uint8Array) => void): void {
    this.socket.on('message', (data, isBinary) => {
      // The protocol is binary. A text frame is passed on as an empty message
      // so the room counts it as malformed.
      if (!isBinary) cb(EMPTY);
      else if (Array.isArray(data)) cb(Buffer.concat(data));
      else if (data instanceof ArrayBuffer) cb(new Uint8Array(data));
      else cb(data);
    });
  }

  onOpen(cb: () => void): void {
    cb();
  }

  onClose(cb: (reason: string) => void): void {
    this.socket.on('close', (code) => {
      cb(`socket closed (${code})`);
    });
    this.socket.on('error', () => {
      this.socket.terminate();
    });
  }

  close(): void {
    this.socket.close();
  }
}
