import { ClientCore } from '../net/client.ts';
import { WebSocketTransport } from '../net/wsTransport.ts';
import { REJECT_VERSION } from '../shared/protocol.ts';
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
const speedLine = element('speed', HTMLDivElement);

const scene = new GameScene(canvas);
const devices = new InputDevices(canvas);
const recorder = __ORBIT_TEST_HOOKS__ ? createDebugRecorder() : null;

// The page and the game socket share one origin.
const socketUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const core = new ClientCore({
  transport: new WebSocketTransport(new WebSocket(socketUrl)),
  now: () => performance.now(),
  controls: () => devices.read(),
  ...(recorder ? { onCorrection: recorder.onCorrection, onSnapshot: recorder.onSnapshot } : {}),
});
recorder?.attach(core);
canvas.focus();

function statusText(): string {
  switch (core.status) {
    case 'connecting':
      return 'Connecting…';
    case 'rejected':
      return core.rejectReason === REJECT_VERSION
        ? 'This copy of the game is out of date. Reload to update.'
        : 'The room is full. Try again in a moment.';
    case 'closed':
      return 'Connection lost. Reload to rejoin.';
    case 'playing':
      return core.state?.alive === false ? 'Destroyed. Respawning…' : '';
  }
}

let lastFrameMs = performance.now();
let shownStatus = '';
let shownSpeed = '';

function frame(nowMs: number): void {
  const elapsedMs = nowMs - lastFrameMs;
  lastFrameMs = nowMs;

  core.update();
  const view = core.view();
  if (view) {
    scene.render(view, elapsedMs / 1000);
    recorder?.frame(nowMs, elapsedMs, view);
  }

  // Touch the DOM only when the text changes.
  const status = statusText();
  if (status !== shownStatus) statusLine.textContent = shownStatus = status;
  const speed = view ? `${Math.round(view.speed)} u/s` : '';
  if (speed !== shownSpeed) speedLine.textContent = shownSpeed = speed;

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
