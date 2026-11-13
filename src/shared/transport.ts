// The one seam between netcode and the network. The netcode above it does not
// know whether it is talking over a WebSocket, an in-memory test link, or
// (later) datagrams.

/**
 * `droppable` marks messages the protocol can lose without harm (inputs and
 * snapshots). `reliable` marks ones it cannot (handshake, events). A
 * WebSocket delivers both the same way; a datagram transport and the test
 * proxy treat them differently.
 */
export type Channel = 'reliable' | 'droppable';

export interface Transport {
  send(data: Uint8Array, channel: Channel): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  /** Fires once when the link is ready. Fires immediately if it already is. */
  onOpen(cb: () => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}
