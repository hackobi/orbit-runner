// An in-memory link between a client and the room, on the virtual clock.
// Like a WebSocket it delivers in order: a delayed message holds up the ones
// behind it. A shaper decides each message's delay, or drops it.

import type { Channel, Transport } from '../../src/shared/transport.ts';
import type { VirtualClock } from './virtualClock.ts';

/** Returns the delay in milliseconds for one message, or null to lose it. */
export type Shaper = (data: Uint8Array, channel: Channel) => number | null;

export interface LinkOptions {
  /** Client to server. */
  up?: Shaper;
  /** Server to client. */
  down?: Shaper;
}

class Endpoint implements Transport {
  peer: Endpoint | null = null;
  private open = true;
  private lastDeliveryMs = 0;
  private readonly messageHandlers: ((data: Uint8Array) => void)[] = [];
  private readonly closeHandlers: ((reason: string) => void)[] = [];

  private readonly clock: VirtualClock;
  private readonly shaper: Shaper;

  constructor(clock: VirtualClock, shaper: Shaper) {
    this.clock = clock;
    this.shaper = shaper;
  }

  send(data: Uint8Array, channel: Channel): void {
    const peer = this.peer;
    if (!this.open || !peer) return;
    const delay = this.shaper(data, channel);
    if (delay === null) return;
    const copy = data.slice();
    this.lastDeliveryMs = Math.max(this.lastDeliveryMs, this.clock.now() + delay);
    this.clock.at(this.lastDeliveryMs, () => {
      peer.deliver(copy);
    });
  }

  onMessage(cb: (data: Uint8Array) => void): void {
    this.messageHandlers.push(cb);
  }

  onOpen(cb: () => void): void {
    cb();
  }

  onClose(cb: (reason: string) => void): void {
    this.closeHandlers.push(cb);
  }

  close(): void {
    // Like a socket, what was already sent still arrives before the close.
    const peer = this.peer;
    const closesAtMs = Math.max(this.lastDeliveryMs, this.clock.now());
    this.shut('closed locally');
    this.clock.at(closesAtMs, () => peer?.shut('closed by peer'));
  }

  private deliver(data: Uint8Array): void {
    if (!this.open) return;
    for (const handler of this.messageHandlers) handler(data);
  }

  private shut(reason: string): void {
    if (!this.open) return;
    this.open = false;
    for (const handler of this.closeHandlers) handler(reason);
  }
}

export function createLink(
  clock: VirtualClock,
  options: LinkOptions = {},
): { client: Transport; server: Transport } {
  const instant: Shaper = () => 0;
  const client = new Endpoint(clock, options.up ?? instant);
  const server = new Endpoint(clock, options.down ?? instant);
  client.peer = server;
  server.peer = client;
  return { client, server };
}
