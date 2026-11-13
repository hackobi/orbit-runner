// A hand-driven connection, for sending things a real client never would
// and for placing inputs on exact ticks.

import { PROTOCOL_VERSION, decodeServerMessage, encodeHello } from '../../src/shared/protocol.ts';
import type { ServerMessage, WelcomeMessage } from '../../src/shared/protocol.ts';
import { SIM_FINGERPRINT } from '../../src/shared/sim/fingerprint.ts';
import type { Transport } from '../../src/shared/transport.ts';
import type { TestWorld } from './harness.ts';
import { createLink } from './loopback.ts';

export class RawClient {
  readonly received: ServerMessage[] = [];
  closed: string | null = null;
  private readonly transport: Transport;

  constructor(world: TestWorld) {
    const link = createLink(world.clock);
    world.room.connect(link.server);
    this.transport = link.client;
    this.transport.onMessage((data) => {
      const message = decodeServerMessage(data);
      if (message) this.received.push(message);
    });
    this.transport.onClose((reason) => {
      this.closed = reason;
    });
  }

  send(data: Uint8Array): void {
    this.transport.send(data, 'reliable');
  }

  hello(
    version = PROTOCOL_VERSION,
    fingerprint = SIM_FINGERPRINT,
    sessionToken: Uint8Array | null = null,
  ): void {
    this.send(
      encodeHello({
        protocolVersion: version,
        simFingerprint: fingerprint,
        clientTimeMs: 0,
        sessionToken,
      }),
    );
  }

  close(): void {
    this.transport.close();
  }

  get welcome(): WelcomeMessage | undefined {
    return this.received.find((m) => m.type === 'welcome');
  }

  /** The most recent welcome: a reconnect or a return from away sends another. */
  get lastWelcome(): WelcomeMessage | undefined {
    return this.received.filter((m) => m.type === 'welcome').pop();
  }
}

export function joined(
  world: TestWorld,
  sessionToken: Uint8Array | null = null,
): { client: RawClient; welcome: WelcomeMessage } {
  const client = new RawClient(world);
  client.hello(PROTOCOL_VERSION, SIM_FINGERPRINT, sessionToken);
  world.run(5);
  const welcome = client.welcome;
  if (!welcome) throw new Error('no welcome');
  return { client, welcome };
}
