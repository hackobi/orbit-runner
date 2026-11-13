// A headless player: the same session and client core a browser uses, flown
// by a behaviour instead of a person. Used by the load test and the
// real-socket tests. It runs anywhere the standard WebSocket exists.

import type { GameEvent } from '../shared/protocol.ts';
import type { Behaviour } from './behaviours.ts';
import type { CorrectionEvent, ViewHit } from './client.ts';
import { Session } from './session.ts';
import { WebSocketTransport } from './wsTransport.ts';
import type { WebSocketLike } from './wsTransport.ts';

export interface BotOptions {
  /** Opens a socket to the game server. */
  openSocket: () => WebSocketLike;
  behaviour: Behaviour;
  now: () => number;
}

export interface Bot {
  readonly session: Session;
  readonly corrections: CorrectionEvent[];
  readonly viewHits: ViewHit[];
  readonly events: GameEvent[];
  /** Call about once a frame. */
  update(): void;
  close(): void;
}

export function createBot(options: BotOptions): Bot {
  const corrections: CorrectionEvent[] = [];
  const viewHits: ViewHit[] = [];
  const events: GameEvent[] = [];
  const session: Session = new Session({
    connect: () => new WebSocketTransport(options.openSocket()),
    now: options.now,
    controls: (tick) => options.behaviour(tick, session.core),
    onCorrection: (event) => corrections.push(event),
    onViewHit: (hit) => viewHits.push(hit),
    onGameEvent: (event) => events.push(event),
  });
  return {
    session,
    corrections,
    viewHits,
    events,
    update: () => {
      session.update();
    },
    close: () => {
      session.close();
    },
  };
}
