// Keeps a player in the game across lost connections and hidden tabs.
//
// A ClientCore lives for one connection. The session makes a new one when
// the connection is lost, presenting the token from the last welcome so the
// server gives the same seat back if it is still being held.

import type { Transport } from '../shared/transport.ts';
import { ClientCore } from './client.ts';
import type { ClientOptions } from './client.ts';

export interface SessionOptions extends Omit<ClientOptions, 'transport' | 'sessionToken'> {
  /** Opens a new connection to the server. */
  connect: () => Transport;
  /** A token kept from before this session began, such as across a page reload. */
  sessionToken?: Uint8Array | null;
  /** Called with each token the server issues, so that it can be kept. */
  onSessionToken?: (token: Uint8Array) => void;
  /** After coming back, how long to wait for the server's answer before reconnecting. */
  resumeTimeoutMs?: number;
  /** How long to wait for a new connection's welcome before trying again. */
  connectTimeoutMs?: number;
}

/** Waits between reconnection attempts, in milliseconds. The last one repeats. */
const RETRY_DELAYS_MS = [250, 500, 1000, 2000];

export class Session {
  core: ClientCore;
  /** How many times a connection has been replaced. */
  reconnects = 0;

  private readonly options: SessionOptions;
  private readonly now: () => number;
  private readonly resumeTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private token: Uint8Array | null = null;
  private hidden = false;
  private attempt = 0;
  private retryAtMs: number | null = null;
  private connectDeadlineMs: number;
  private resumeDeadlineMs: number | null = null;

  constructor(options: SessionOptions) {
    this.options = options;
    this.now = options.now;
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? 1000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.connectDeadlineMs = this.now() + this.connectTimeoutMs;
    this.token = options.sessionToken ?? null;
    this.core = this.open();
  }

  /** Call once per frame, in place of the core's own update. */
  update(): void {
    const now = this.now();
    this.core.update();
    const issued = this.core.sessionToken;
    if (issued && issued !== this.token) {
      this.token = issued;
      this.options.onSessionToken?.(issued);
    }
    if (this.hidden) return;

    switch (this.core.status) {
      case 'playing':
        this.attempt = 0;
        this.retryAtMs = null;
        this.resumeDeadlineMs = null;
        return;
      case 'rejected':
        // The server said no. Trying again would get the same answer.
        return;
      case 'away':
        // Back from a hidden tab and waiting for the server's welcome. On a
        // phone the old socket is often dead without having said so.
        if (this.resumeDeadlineMs !== null && now >= this.resumeDeadlineMs) this.replace(now);
        return;
      case 'connecting':
        if (now >= this.connectDeadlineMs) this.replace(now);
        return;
      case 'closed':
        if (this.retryAtMs === null) {
          const delay = RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length - 1)] ?? 2000;
          this.retryAtMs = now + delay;
        } else if (now >= this.retryAtMs) {
          this.replace(now);
        }
        return;
    }
  }

  /** Call when the page is hidden or shown again. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.core.setAway(hidden);
    this.resumeDeadlineMs = hidden ? null : this.now() + this.resumeTimeoutMs;
  }

  /**
   * Asks for a seat again after the server gave this one up. Only the fort
   * uses it: its pilot was told why the seat went and chose to launch.
   */
  rejoin(): void {
    if (this.core.status === 'rejected') this.replace(this.now());
  }

  close(): void {
    this.hidden = true;
    this.core.close();
  }

  private replace(now: number): void {
    this.core.close();
    this.attempt += 1;
    this.reconnects += 1;
    this.retryAtMs = null;
    this.resumeDeadlineMs = null;
    this.connectDeadlineMs = now + this.connectTimeoutMs;
    this.core = this.open();
  }

  private open(): ClientCore {
    return new ClientCore({
      ...this.options,
      transport: this.options.connect(),
      sessionToken: this.token,
    });
  }
}
