import { Session } from '../net/session.ts';
import { WebSocketTransport } from '../net/wsTransport.ts';
import { SIM } from '../shared/constants.ts';
import { REJECT_VERSION } from '../shared/protocol.ts';
import type { GameEvent } from '../shared/protocol.ts';
import { createDebugRecorder } from './debugHook.ts';
import { InputDevices } from './input.ts';
import { GameScene } from './scene.ts';

/** Set by the build. True only when VITE_TEST_HOOKS=1. */
declare const __ORBIT_TEST_HOOKS__: boolean;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} is missing from the page`);
  return found;
}

const canvas = element('game', HTMLCanvasElement);
const statusLine = element('status', HTMLDivElement);
const hullLine = element('hull', HTMLDivElement);
const speedLine = element('speed', HTMLDivElement);
const killsLine = element('kills', HTMLDivElement);

const scene = new GameScene(canvas);
const devices = new InputDevices(canvas);
const recorder = __ORBIT_TEST_HOOKS__ ? createDebugRecorder() : null;

// The page and the game socket share one origin. Test builds can point the
// socket at the network-conditions proxy instead.
function socketUrl(): string {
  if (__ORBIT_TEST_HOOKS__) {
    const override = new URLSearchParams(location.search).get('server');
    if (override) return override;
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function onGameEvent(event: GameEvent): void {
  recorder?.onGameEvent(event);
  // Damage shows when the server confirms it. A hit on this player's own
  // ship flashes at the ship; any other flashes at the target as drawn.
  if (event.kind !== 'hit') return;
  const core = session.core;
  if (event.targetId === core.playerId) {
    const view = core.view();
    if (view) scene.spark(view.x, view.y, view.z);
    return;
  }
  const target = core.remoteViews().find((remote) => remote.id === event.targetId);
  if (target && event.ownerId !== core.playerId) scene.spark(target.x, target.y, target.z);
}

const session: Session = new Session({
  connect: () => new WebSocketTransport(new WebSocket(socketUrl())),
  now: () => performance.now(),
  controls: (tick) => recorder?.controls(tick, session.core) ?? devices.read(),
  onGameEvent,
  // This player's own shots flash the moment they meet a ship on this screen.
  onViewHit: (hit) => {
    recorder?.onViewHit(hit);
    const target = session.core.remoteViews().find((remote) => remote.id === hit.targetId);
    if (target) scene.spark(target.x, target.y, target.z);
  },
  ...(recorder ? { onCorrection: recorder.onCorrection, onSnapshot: recorder.onSnapshot } : {}),
});
recorder?.attach(session);
canvas.focus();

// A hidden tab gets no frames, so say so: the server holds the seat, and the
// client starts afresh from the server's state when the tab is shown again.
document.addEventListener('visibilitychange', () => {
  session.setHidden(document.hidden);
});

function statusText(): string {
  const core = session.core;
  switch (core.status) {
    case 'connecting':
      return session.reconnects > 0 ? 'Reconnecting…' : 'Connecting…';
    case 'rejected':
      return core.rejectReason === REJECT_VERSION
        ? 'This copy of the game is out of date. Reload to update.'
        : 'The room is full. Try again in a moment.';
    case 'closed':
      return 'Connection lost. Reconnecting…';
    case 'away':
      return 'Paused.';
    case 'playing':
      return core.state?.alive === false ? 'Destroyed. Respawning…' : '';
  }
}

let lastFrameMs = performance.now();
const shown = new Map<HTMLElement, string>();

/** Touches the DOM only when the text changes. */
function show(line: HTMLElement, text: string): void {
  if (shown.get(line) === text) return;
  shown.set(line, text);
  line.textContent = text;
}

function frame(nowMs: number): void {
  const elapsedMs = nowMs - lastFrameMs;
  lastFrameMs = nowMs;

  session.update();
  const core = session.core;
  const view = core.view();
  if (view) {
    const remotes = core.remoteViews();
    const bullets = core.bulletViews();
    scene.render(view, remotes, bullets, core.playerId, elapsedMs / 1000);
    recorder?.frame(nowMs, elapsedMs, core, view, remotes, bullets.length);
  }

  show(statusLine, statusText());
  show(hullLine, view ? `Hull ${view.hp} / ${SIM.maxHp}` : '');
  show(speedLine, view ? `${Math.round(view.speed)} u/s` : '');
  show(killsLine, view ? `Kills ${core.kills}` : '');

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
