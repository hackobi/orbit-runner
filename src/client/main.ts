import { Session } from '../net/session.ts';
import { WebSocketTransport } from '../net/wsTransport.ts';
import { SIM } from '../shared/constants.ts';
import { NEUTRAL_CONTROLS } from '../shared/sim/ship.ts';
import { NO_CRATE, REJECT_FORT, REJECT_IDLE, REJECT_VERSION } from '../shared/protocol.ts';
import type { GameEvent } from '../shared/protocol.ts';
import type { BulletView } from '../net/client.ts';
import { createDebugRecorder } from './debugHook.ts';
import { PAD_LAYOUT, activePad, padName, unusablePad } from './gamepad.ts';
import { FortScreen } from './fort.ts';
import { SortieTracker, askFort, askLaunch, stepFortGate } from './fortModel.ts';
import type { FortGate } from './fortModel.ts';
import { InputDevices } from './input.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { watchForUpdates } from './update.ts';
import { shouldApplyUpdate } from './updatePolicy.ts';
import { asteroidPosition, asteroidTouching } from '../shared/sim/belt.ts';
import { Hud } from './hud.ts';
import { QualityController, TIERS } from './quality.ts';
import { DEATH_SPARK, GameScene, NEAR_MISS_SPARK, SHIELD_SPARK } from './scene.ts';

/** Set by the build. True only when VITE_TEST_HOOKS=1. */
declare const __ORBIT_TEST_HOOKS__: boolean;

declare global {
  interface Window {
    /**
     * Present only inside the Mac app (app/preload.cjs). `serverUrl` is the
     * game socket to use when the app shows the copy of the client packed
     * into it, and null when the page came from the game's own server.
     */
    orbitApp?: { serverUrl: string | null };
  }
}

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
// socket at the network-conditions proxy instead, and the Mac app's packed
// copy, which has no server of its own behind it, is told where to go.
function socketUrl(): string {
  const packed = window.orbitApp?.serverUrl;
  if (packed) return packed;
  if (__ORBIT_TEST_HOOKS__) {
    const override = new URLSearchParams(location.search).get('server');
    if (override) return override;
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** v1 jolts the camera when things happen to the player's own ship. Amounts are v1's. */
/** How long a kill is drawn out for. */
const SLOW_MOTION_SECONDS = 0.6;

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
  if (event.kind === 'crate' && event.tier !== NO_CRATE) cratesWon += 1;
  hud.onEvent(event, session.core, performance.now());
  shakeFor(event);
  const core = session.core;
  if (event.kind === 'death') {
    // A ship breaks up in a big flash. A kill this player made or suffered
    // is drawn out for a moment.
    const mine = event.victimId === core.playerId;
    const at = mine
      ? core.view()
      : core.remoteViews().find((remote) => remote.id === event.victimId);
    if (at) scene.spark(at.x, at.y, at.z, DEATH_SPARK, 2);
    if (mine || event.killerId === core.playerId) scene.slowMotion(SLOW_MOTION_SECONDS);
    return;
  }
  // Damage shows when the server confirms it. A hit on this player's own
  // ship flashes at the ship; any other flashes at the target as drawn.
  // While any shield is left the flash is the shield's colour.
  if (event.kind !== 'hit') return;
  const color = event.shield > 0 ? SHIELD_SPARK : undefined;
  if (event.targetId === core.playerId) {
    const view = core.view();
    if (view) scene.spark(view.x, view.y, view.z, color);
    return;
  }
  const target = core.remoteViews().find((remote) => remote.id === event.targetId);
  if (target && event.ownerId !== core.playerId) {
    scene.spark(target.x, target.y, target.z, color);
  }
}

// The server's token for this player's seat is kept for the life of the tab,
// so a reload (an update, or a slip of the finger) comes back to the same
// seat and the same points if it is quick. It is per tab: a second tab is a
// second player.
const TOKEN_KEY = 'orbit-runner.session';
function keptToken(): Uint8Array | null {
  try {
    const hex = sessionStorage.getItem(TOKEN_KEY) ?? '';
    if (!/^([0-9a-f]{2})+$/.test(hex)) return null;
    return Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
  } catch {
    return null;
  }
}
function keepToken(token: Uint8Array): void {
  try {
    const hex = Array.from(token, (byte) => byte.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem(TOKEN_KEY, hex);
  } catch {
    // Storage switched off: a reload starts afresh.
  }
}

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

// The pilot's key: made once and kept in this browser, so experience and
// missions carry over between visits. Whoever holds it is that pilot.
const PILOT_KEY = 'orbit-runner.pilot';
function pilotKey(): Uint8Array | null {
  try {
    const kept = localStorage.getItem(PILOT_KEY) ?? '';
    if (/^[0-9a-f]{32}$/.test(kept)) {
      return Uint8Array.from(kept.match(/../g) ?? [], (byte) => parseInt(byte, 16));
    }
    const key = crypto.getRandomValues(new Uint8Array(16));
    localStorage.setItem(
      PILOT_KEY,
      Array.from(key, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
    return key;
  } catch {
    // Storage switched off: a visitor, whose progress lasts as long as the seat.
    return null;
  }
}

// The Mac app has no service worker. It loads the page from the network (or
// from inside itself) at every start, so it is always the current version,
// and under Electron 45 a start-up with a worker's update waiting never
// finished loading (DECISIONS.md section 9).
const updates = window.orbitApp
  ? { ready: false, apply: (): void => undefined }
  : watchForUpdates();

/** True once the ship's throttle is fully open: from there a held ▲ is the boost. */
function throttleOpen(): boolean {
  const ship = session.core.state;
  return !!ship && ship.targetSpeed >= (ship.fenix ? SIM.fenixMaxSpeed : SIM.maxSpeed);
}

const session: Session = new Session({
  connect: () => new WebSocketTransport(new WebSocket(socketUrl())),
  sessionToken: keptToken(),
  onSessionToken: keepToken,
  pilotKey: pilotKey(),
  now: () => performance.now(),
  // In the fort nothing reaches the ship: keys pressed there are not flying.
  controls: (tick) => {
    const controls = recorder?.controls(tick, session.core) ?? devices.read(throttleOpen());
    return fortGate.open ? NEUTRAL_CONTROLS : controls;
  },
  onGameEvent,
  // This player's own shots flash the moment they meet a ship on this screen.
  onViewHit: (hit) => {
    recorder?.onViewHit(hit);
    const target = session.core.remoteViews().find((remote) => remote.id === hit.targetId);
    if (target) {
      scene.spark(target.x, target.y, target.z, target.shield > 0 ? SHIELD_SPARK : undefined);
    }
  },
  ...(recorder ? { onCorrection: recorder.onCorrection, onSnapshot: recorder.onSnapshot } : {}),
});
recorder?.attach(
  session,
  () => devices.read(),
  () => TIERS[quality.tier]?.name ?? '',
);

// --- The fort -------------------------------------------------------------------
//
// Where the pilot is while they have no ship. One control goes in and comes
// out: Tab, the controller's touchpad or View button, or the button on screen.

let fortGate: FortGate = { open: false, launching: false };
/** The tab has been hidden since the ship last flew. */
let beenAway = false;
/** True when the ship was lost with the pilot away, which the fort says. */
let lostWhileAway = false;
let launchAskedAtMs = -Infinity;
/** Crates won since the page opened, for the sortie report. */
let cratesWon = 0;
const sorties = new SortieTracker();
const ownKey = pilotKey();

function fortFacts(): { playing: boolean; shipAlive: boolean; held: boolean } {
  const core = session.core;
  return {
    playing: core.status === 'playing',
    shipAlive: core.state?.alive ?? false,
    held: core.fort,
  };
}

/** Launch: the server brings the ship back, or seats the pilot again if the seat went. */
function launch(): void {
  fortGate = askLaunch(fortGate);
  launchAskedAtMs = -Infinity;
  canvas.focus();
}

function toggleFort(): void {
  if (fortGate.open) {
    launch();
    return;
  }
  const asked = askFort(fortGate, fortFacts());
  if (asked.open) {
    session.core.setFort(true);
    lostWhileAway = false;
  }
  fortGate = asked;
}

const fort = new FortScreen({
  pilotKey: ownKey ? hexOf(ownKey) : null,
  onLaunch: launch,
  // The copy packed into the Mac app is not served by the game's server, so
  // it has nowhere to ask: its fort screen says no fort is connected.
  ...(window.orbitApp?.serverUrl
    ? { fetchFort: () => Promise.resolve({ ok: false, reason: 'off' } as const) }
    : {}),
});
element('death-fort', HTMLButtonElement).addEventListener('click', toggleFort);
devices.onPadFort = toggleFort;
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return;
  // Tab never moves the focus about a game.
  event.preventDefault();
  if (!event.repeat) toggleFort();
});

/** How often a launch is asked for again while the server has not answered. */
const LAUNCH_RETRY_MS = 500;

/** Keeps the fort screen, the server and the camera in step. Once a frame. */
function updateFort(nowMs: number): void {
  const core = session.core;
  const facts = fortFacts();
  if (core.status === 'away') beenAway = true;
  if (facts.playing && facts.shipAlive) beenAway = false;
  const wasOpen = fortGate.open;
  fortGate = stepFortGate(fortGate, facts);
  // Opened by the server, not by a press: the ship went while the pilot was away.
  if (fortGate.open && !wasOpen) lostWhileAway = beenAway;
  if (fortGate.launching && nowMs - launchAskedAtMs >= LAUNCH_RETRY_MS) {
    launchAskedAtMs = nowMs;
    if (core.status === 'rejected' && core.rejectReason === REJECT_FORT) session.rejoin();
    else if (facts.playing) core.setFort(false);
  }
  if (facts.playing) fort.warm(nowMs);
  const seatGone = core.status === 'rejected' && core.rejectReason === REJECT_FORT;
  const context = {
    xp: core.progress?.xp ?? null,
    cratesInFlight: core.crates,
    sortie: sorties.last,
    lostWhileAway,
    launchNote: seatGone
      ? 'Your seat in the fight was given up while you were here. Launch takes a new one.'
      : facts.playing
        ? ''
        : 'Not connected to the fight. Launch will fly as soon as it is.',
  };
  fort.setOpen(fortGate.open, context, nowMs);
  fort.update(context, nowMs);
  scene.setFort(fortGate.open);
}

// --- Settings panel -----------------------------------------------------------

const settingsButton = element('settings-button', HTMLButtonElement);
const settingsPanel = element('settings', HTMLDivElement);
const invertBox = element('invert-pitch', HTMLInputElement);
const tiltBox = element('tilt', HTMLInputElement);
const tiltRow = element('tilt-row', HTMLLabelElement);

// Crates are claimed in SpaceFort: this asks the server for a one-time code.
const claimButton = element('claim-button', HTMLButtonElement);
const claimText = element('claim-text', HTMLParagraphElement);
claimButton.addEventListener('click', () => {
  const key = ownKey;
  if (!key) {
    claimText.textContent = 'This browser keeps no pilot, so it holds no crates.';
    return;
  }
  // Back to the game at once: a focused button would be pressed again by the
  // fire key, and each press replaces the code just shown.
  canvas.focus();
  claimText.textContent = 'Asking…';
  void fetch('/api/claim-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pilotKey: hexOf(key) }),
  })
    .then((response) => response.json() as Promise<{ code?: string; crates?: number }>)
    .then((reply) => {
      claimText.textContent = reply.code
        ? `Code ${reply.code.slice(0, 4)}-${reply.code.slice(4)} for ${reply.crates} crate${reply.crates === 1 ? '' : 's'}. Enter it in SpaceFort within 10 minutes.`
        : 'No crates to claim yet. Orbs, raiders and the boss can drop them.';
    })
    .catch(() => {
      claimText.textContent = 'Could not reach the server. Try again.';
    });
});

const toggleSettings = (): void => {
  settingsPanel.hidden = !settingsPanel.hidden;
  settingsButton.setAttribute('aria-expanded', String(!settingsPanel.hidden));
  canvas.focus();
};
settingsButton.addEventListener('click', toggleSettings);

// The controller: the browser does the pairing, so this only reports what it
// sees and lists what each control does.
const padStatus = element('pad-status', HTMLParagraphElement);
const padLayout = element('pad-layout', HTMLDListElement);
for (const row of PAD_LAYOUT) {
  const control = document.createElement('dt');
  control.textContent = row.control;
  const action = document.createElement('dd');
  action.textContent = row.action;
  padLayout.append(control, action);
}
let padShown: string | null = null;
const showPad = (): void => {
  const pad = activePad();
  const other = pad ? null : unusablePad();
  padLayout.hidden = !pad;
  padStatus.textContent = pad
    ? `Controller: ${padName(pad)}`
    : other
      ? `${padName(other)} is connected, but this browser does not report its layout, so it cannot be used here.`
      : 'Controller: pair a PS5 or Xbox controller with this device, then press any button on it.';
  const name = pad ? padName(pad) : null;
  if (name && name !== padShown) hud.notice(`${name} connected`, 'Open ⚙ for the controls.');
  if (!name && padShown)
    hud.notice('Controller disconnected', 'Keyboard, mouse and touch still work.');
  padShown = name;
};
window.addEventListener('gamepadconnected', showPad);
window.addEventListener('gamepaddisconnected', showPad);
showPad();
devices.onPadMenu = toggleSettings;

// The cockpit view: L1 / LB on a controller or the C key, in and out.
const cockpitFrame = document.getElementById('cockpit');
const showCockpit = (on: boolean): void => {
  scene.cockpit = on;
  cockpitFrame?.toggleAttribute('hidden', !on);
};
const toggleCockpit = (): void => {
  settings.cockpit = !settings.cockpit;
  saveSettings(settings);
  showCockpit(settings.cockpit);
};
showCockpit(settings.cockpit);
devices.onPadView = toggleCockpit;
window.addEventListener('keydown', (event) => {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.code === 'KeyC') toggleCockpit();
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
      if (core.rejectReason === REJECT_VERSION) {
        // The copy packed into the Mac app cannot be reloaded into a newer one.
        return window.orbitApp?.serverUrl
          ? 'This copy of the game is older than the server. Get the current app.'
          : 'This copy of the game is out of date. Reload to update.';
      }
      // The fort screen says what happened to the seat, and launches again.
      if (core.rejectReason === REJECT_FORT) return '';
      return core.rejectReason === REJECT_IDLE
        ? 'You were away, and your seat was given to someone else. Reload to play again.'
        : 'The room is full. Try again in a moment.';
    case 'closed':
      return 'Connection lost. Reconnecting…';
    case 'away':
      return 'Paused.';
    case 'playing':
      return updates.ready ? 'A new version is ready. It loads after this life.' : '';
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
  devices.pollPad();
  const core = session.core;
  const view = core.view();
  const remotes = view ? core.remoteViews() : [];
  if (view) {
    // Homing shots are drawn with the bullets, as one more kind of shot, and
    // come first: if there are ever too many to draw, they are not the ones left out.
    const bullets: BulletView[] = core
      .seekerViews()
      .map((seeker) => ({ ...seeker, spawnTick: 0, shot: 'seeker' }));
    bullets.push(...core.bulletViews());
    const world = core.world ? { world: core.world, tick: core.drawTick, state: core } : null;
    if (view.alive) nearMiss(nowMs, view.x, view.y, view.z);
    sorties.update(
      view.alive,
      { score: core.score, kills: core.kills, xp: core.progress?.xp ?? 0, crateDrops: cratesWon },
      nowMs,
    );
    scene.render(view, remotes, bullets, core.playerId, elapsedMs / 1000, world);
    recorder?.frame(nowMs, elapsedMs, core, view, remotes, bullets.length);
  }

  hud.update(core, statusText(), view, remotes, project, nowMs);
  updateFort(nowMs);
  if (shouldApplyUpdate(updates.ready, core.status, view?.alive ?? false, fortGate.open)) {
    updates.apply();
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
