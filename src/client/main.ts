import { Session } from '../net/session.ts';
import { WebSocketTransport } from '../net/wsTransport.ts';
import { REJECT_VERSION } from '../shared/protocol.ts';
import type { GameEvent } from '../shared/protocol.ts';
import { createDebugRecorder } from './debugHook.ts';
import { InputDevices } from './input.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { asteroidPosition, asteroidTouching } from '../shared/sim/belt.ts';
import { Hud } from './hud.ts';
import { QualityController, TIERS } from './quality.ts';
import { GameScene, NEAR_MISS_SPARK } from './scene.ts';

/** Set by the build. True only when VITE_TEST_HOOKS=1. */
declare const __ORBIT_TEST_HOOKS__: boolean;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} is missing from the page`);
  return found;
}

const canvas = element('game', HTMLCanvasElement);

const scene = new GameScene(canvas);
const hud = new Hud((item) => {
  session.core.buy(item);
});
const settings = loadSettings();
const devices = new InputDevices(canvas, settings);
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

/** v1 jolts the camera when things happen to the player's own ship. Amounts are v1's. */
function shakeFor(event: GameEvent): void {
  const me = session.core.playerId;
  switch (event.kind) {
    case 'asteroid':
      // A crash (main.js:8503), or a rock this player shot (main.js:8992).
      if (event.playerId === me) scene.shake(event.byBullet ? 0.25 : 0.4);
      break;
    case 'hit':
      if (event.targetId === me) scene.shake(0.6); // main.js:9829
      break;
    case 'death':
      if (event.victimId === me) scene.shake(0.8); // main.js:8525
      break;
    case 'orb': {
      if (event.playerId !== me) break;
      const kind = session.core.world?.orbs.orbs[event.orbId]?.kind;
      if (kind === 'wormhole')
        scene.shake(1.0); // main.js:9540
      else if (kind === 'boost')
        scene.shake(0.3); // main.js:9336
      else if (kind === 'fenix')
        scene.shake(0.5); // main.js:5105
      else if (kind === 'shield') scene.shake(0.15); // main.js:6011
      break;
    }
    default:
      break;
  }
}

function onGameEvent(event: GameEvent): void {
  recorder?.onGameEvent(event);
  hud.onEvent(event, session.core, performance.now());
  shakeFor(event);
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
recorder?.attach(
  session,
  () => devices.read(),
  () => TIERS[quality.tier]?.name ?? '',
);

// --- Settings panel -----------------------------------------------------------

const settingsButton = element('settings-button', HTMLButtonElement);
const settingsPanel = element('settings', HTMLDivElement);
const invertBox = element('invert-pitch', HTMLInputElement);
const tiltBox = element('tilt', HTMLInputElement);
const tiltRow = element('tilt-row', HTMLLabelElement);

settingsButton.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  settingsButton.setAttribute('aria-expanded', String(!settingsPanel.hidden));
  canvas.focus();
});
invertBox.checked = settings.invertPitch;
invertBox.addEventListener('change', () => {
  settings.invertPitch = invertBox.checked;
  saveSettings(settings);
  canvas.focus();
});
// Tilt needs a phone or tablet, and on iOS the player's say-so, given by this tap.
tiltRow.hidden =
  typeof DeviceOrientationEvent === 'undefined' || !matchMedia('(pointer: coarse)').matches;
const applyTilt = async (wanted: boolean): Promise<void> => {
  const on = await devices.setTilt(wanted);
  tiltBox.checked = on;
  settings.tilt = on;
  saveSettings(settings);
};
tiltBox.addEventListener('change', () => {
  void applyTilt(tiltBox.checked);
});
// A setting kept from last time. Where the browser must ask first, it will
// refuse outside a tap, and the box then shows tilt as off.
if (settings.tilt && !tiltRow.hidden) void applyTilt(true);
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
      return '';
  }
}

// A rock passing within 3.2 units of the hull throws a blue spark, at most
// once every 1.2 s per rock (main.js:8945-8954).
const NEAR_MISS_DISTANCE = 3.2;
const NEAR_MISS_REPEAT_MS = 1200;
const nearMissAtMs = new Map<number, number>();

function nearMiss(nowMs: number, x: number, y: number, z: number): void {
  const core = session.core;
  const world = core.world;
  if (!world) return;
  const tick = Math.floor(core.drawTick);
  const id = asteroidTouching(world.belt, core, tick, x, y, z, NEAR_MISS_DISTANCE);
  const rock = world.belt.asteroids[id];
  if (!rock || nowMs - (nearMissAtMs.get(id) ?? -Infinity) < NEAR_MISS_REPEAT_MS) return;
  nearMissAtMs.set(id, nowMs);
  const at = asteroidPosition(rock, tick);
  scene.spark(at.x, at.y, at.z, NEAR_MISS_SPARK, 0);
  scene.shake(0.25); // main.js:8952
}

// A phone starts on the middle tier; the controller moves it from there.
const quality = new QualityController(matchMedia('(pointer: coarse)').matches ? 1 : 0);
const applyQuality = (): void => {
  const tier = TIERS[quality.tier];
  if (tier) scene.setQuality(tier);
};
applyQuality();

let lastFrameMs = performance.now();
const project = scene.project.bind(scene);

function frame(nowMs: number): void {
  const elapsedMs = nowMs - lastFrameMs;
  lastFrameMs = nowMs;

  if (quality.frame(elapsedMs)) applyQuality();

  session.update();
  const core = session.core;
  const view = core.view();
  const remotes = view ? core.remoteViews() : [];
  if (view) {
    const bullets = core.bulletViews();
    const world = core.world ? { world: core.world, tick: core.drawTick, state: core } : null;
    if (view.alive) nearMiss(nowMs, view.x, view.y, view.z);
    scene.render(view, remotes, bullets, core.playerId, elapsedMs / 1000, world);
    recorder?.frame(nowMs, elapsedMs, core, view, remotes, bullets.length);
  }

  hud.update(core, statusText(), view, remotes, project, nowMs);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
