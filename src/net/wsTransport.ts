// The baseline transport: one binary WebSocket. Both channels share it.
//
// It is written against the standard WebSocket API, which browsers and
// Node 22 both provide, so the browser client and the headless bots use the
// same class.

import type { Transport } from '../shared/transport.ts';

/** The part of the standard WebSocket this transport uses. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number }) => void): void;
}

const OPEN = 1;

export class WebSocketTransport implements Transport {
  private readonly socket: WebSocketLike;

  constructor(socket: WebSocketLike) {
    this.socket = socket;
    this.socket.binaryType = 'arraybuffer';
  }

  // Both channels use the one socket, so the channel is not looked at.
  send(data: Uint8Array): void {
    if (this.socket.readyState !== OPEN) return;
    // Copy into a buffer of its own: the caller may reuse or share its bytes.
    this.socket.send(new Uint8Array(data));
  }

  onMessage(cb: (data: Uint8Array) => void): void {
    this.socket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) cb(new Uint8Array(event.data));
    });
  }

  onOpen(cb: () => void): void {
    if (this.socket.readyState === OPEN) cb();
    else this.socket.addEventListener('open', cb);
  }

  onClose(cb: (reason: string) => void): void {
    this.socket.addEventListener('close', (event) => {
      cb(`socket closed (${event.code})`);
    });
  }

  close(): void {
    this.socket.close();
  }
}
