// Client netcode core: handshake, tick clock, own-ship prediction and
// reconciliation, other ships, bullets. No DOM and no sockets, so the browser
// client, the headless bots and the virtual-time tests all run this same class.
//
// Tick numbering: state[T] = step(state[T − 1], input[T]). The client runs
// ahead of the server, so that input[T] reaches the server before the server
// simulates tick T.

import { SHIP_LENGTH, SIM, TICK_MS } from '../shared/constants.ts';
import { TWO_PI } from '../shared/math.ts';
import {
  INPUT_REDUNDANCY,
  NO_CRATE,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeBuy,
  encodeFort,
  encodeHello,
  encodeInput,
  encodePresence,
} from '../shared/protocol.ts';
import type {
  GameEvent,
  RejectReason,
  ScoreEntry,
  SnapshotMessage,
  WelcomeMessage,
} from '../shared/protocol.ts';
import type { StoreItem } from '../shared/scoring.ts';
import { bulletAsteroidHit } from '../shared/sim/belt.ts';
import {
  bulletDamage,
  bulletExpired,
  bulletFrom,
  bulletHit,
  bulletLifeTicks,
  bulletStep,
  bulletTravel,
  shipHitDistance,
  spawnBullet,
} from '../shared/sim/bullets.ts';
import type { Bullet } from '../shared/sim/bullets.ts';
import { SeekerTracks } from './seekers.ts';
import type { SeekerView } from './seekers.ts';
import { hullScaleOf } from '../shared/progress.ts';
import type { Progress } from '../shared/progress.ts';
import { SIM_FINGERPRINT } from '../shared/sim/fingerprint.ts';
import {
  NEUTRAL_INPUT,
  VIEW_DELAY_STEPS_PER_TICK,
  shotThisTick,
  isBoosting,
  stuntAngles,
  quantiseControls,
  shipStatesEqual,
} from '../shared/sim/ship.ts';
import type { Controls, Input, ShipState, ShotKind } from '../shared/sim/ship.ts';
import { bulletOrbHit } from '../shared/sim/orbs.ts';
import { applyGrant, applyOrb, createWorld, stepPlayer } from '../shared/sim/world.ts';
import type { World, WorldEffect, WorldState } from '../shared/sim/world.ts';
import { PredictedWorld } from './predictedWorld.ts';
import type { WorldThing } from './predictedWorld.ts';
import type { Transport } from '../shared/transport.ts';
import { RemoteShips } from './remotes.ts';
import type { RemoteTuning, RemoteView } from './remotes.ts';

export interface ClientTuning {
  /**
   * The slack, in ticks, that the worst recent input should still have had
   * when it reached the server. The tick clock is steered to keep it there.
   */
  baseLeadTicks: number;
  /** The worst recent slack may sit this far above the base before the clock slows. */
  leadBandTicks: number;
  /**
   * Typical slack never goes past this, however jittery the link. Beyond it
   * some inputs are allowed to be late, because more slack means more delay.
   */
  maxLeadTicks: number;
  /**
   * Extra slack at the start. The first round-trip figure is a single
   * sample, so begin generously and let the tick clock settle; beginning
   * short would make the first inputs late.
   */
  initialExtraLeadTicks: number;
  /** The tick clock runs at most this fraction fast or slow. */
  maxRateAdjust: number;
  /** Rate change per tick of slack error. */
  rateGain: number;
  /** How many slack reports "recent" covers. 150 is five seconds. */
  leadWindow: number;
  /** After a stall longer than this many ticks the client skips ahead instead of catching up. */
  maxTicksPerUpdate: number;
  /** Half-life of the visual offset left by a correction. */
  offsetHalfLifeMs: number;
  /** Corrections larger than this are shown at once instead of smoothed. */
  snapDistance: number;
}

export const DEFAULT_TUNING: ClientTuning = {
  baseLeadTicks: 2,
  leadBandTicks: 1.25,
  maxLeadTicks: 6,
  initialExtraLeadTicks: 2,
  maxRateAdjust: 0.05,
  rateGain: 1 / 30,
  leadWindow: 150,
  maxTicksPerUpdate: 8,
  offsetHalfLifeMs: 35,
  snapDistance: 5 * SHIP_LENGTH,
};

/** Ticks kept normal at the end of a stall; the ones before them are skipped. */
const TICKS_KEPT_AFTER_STALL = 2;

/** Prediction history, in ticks. About 17 seconds. */
const HISTORY_SIZE = 1024;

/** Marks a history entry whose input was never sent. */
const NOT_SENT = -1;

/**
 * - connecting: waiting for the server's welcome.
 * - playing: predicting and sending inputs.
 * - away: the player's tab is hidden; nothing is simulated or sent.
 * - rejected: the server refused this client (wrong version, or room full).
 * - closed: the connection is gone.
 */
export type ClientStatus = 'connecting' | 'playing' | 'away' | 'rejected' | 'closed';

export interface CorrectionEvent {
  timeMs: number;
  /** The client's tick when the correction was applied. */
  tick: number;
  /** The server tick whose state differed from the prediction. */
  ackTick: number;
  /** How far the predicted present position moved, in world units. */
  distance: number;
  /** True when the ship died or respawned: a jump the server intended. */
  teleport: boolean;
}

export interface SnapshotEvent {
  timeMs: number;
  serverTick: number;
  /** Input slack the server reported, in ticks. NaN when it had no sample. */
  inputLead: number;
  missedInputs: number;
}

/** One of this player's bullets meeting a ship on this player's screen. */
export interface ViewHit {
  timeMs: number;
  /** The bullet: this player's id and the tick it was fired. */
  ownerId: number;
  spawnTick: number;
  targetId: number;
  tick: number;
  /** What the hit takes off the target: 15 for a bullet, 30 for a Fenix beam, 60 for a heavy shot. */
  damage: number;
}

/** What to draw for the own ship right now. */
export interface ShipView {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  /** What a roll or a flip under way adds to the pitch and roll the ship is drawn at. The view ahead does not turn with it. */
  stuntPitch: number;
  stuntRoll: number;
  speed: number;
  hp: number;
  shield: number;
  /** 0 to SIM.maxEnergy. */
  energy: number;
  heavyAmmo: number;
  /** Ticks of rapid fire left. */
  rapidTicks: number;
  /** Ticks the homing shot has charged, and ticks until it can be charged again. */
  charge: number;
  seekerCooldown: number;
  boosting: boolean;
  invulnerable: boolean;
  fenix: boolean;
  alive: boolean;
}

/** A bullet to draw: where its tip is and which way it flies. */
export interface BulletView {
  ownerId: number;
  spawnTick: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  shot: ShotKind;
}

export interface ClientOptions {
  transport: Transport;
  /** Milliseconds from any fixed origin. Must not go backwards. */
  now: () => number;
  /**
   * The controls to apply at the given tick. Called once per tick, just
   * before it is simulated. A player's device returns its current state; a
   * bot or a test returns a script.
   */
  controls: (tick: number) => Controls;
  /** A token from an earlier welcome, to take the same seat back after a reconnect. */
  sessionToken?: Uint8Array | null;
  /** The pilot whose progress to carry on with (protocol.ts, HelloMessage). */
  pilotKey?: Uint8Array | null;
  tuning?: Partial<ClientTuning>;
  remoteTuning?: Partial<RemoteTuning>;
  onCorrection?: (event: CorrectionEvent) => void;
  onSnapshot?: (event: SnapshotEvent) => void;
  /** Called when one of this player's bullets meets a ship on this player's screen. */
  onViewHit?: (hit: ViewHit) => void;
  /** Called for every event the server announces. */
  onGameEvent?: (event: GameEvent) => void;
}

interface Arrival {
  timeMs: number;
  data: Uint8Array;
}

interface OwnBullet {
  readonly bullet: Bullet;
  /** The server has announced this bullet. Until then it is only a prediction. */
  confirmed: boolean;
  /** It has met a ship, on this screen or by the server's word. It is no longer drawn. */
  spent: boolean;
  /**
   * A hit seen on this screen while the bullet was still only a prediction.
   * It is reported when the server confirms the shot, and forgotten if the
   * shot turns out never to have happened.
   */
  pendingHit: ViewHit | null;
  /** The rock or orb this bullet was predicted to hit, until the server confirms it. */
  took: { thing: WorldThing; id: number } | null;
}

/**
 * Something the server has announced will happen to the own ship on a
 * coming tick: the effect of an orb this player shot, or of a purchase.
 */
type Scheduled =
  | { applyTick: number; orbId: number; item?: undefined }
  | { applyTick: number; item: StoreItem; orbId?: undefined };

function sameBullet(a: Bullet, b: Bullet): boolean {
  return (
    a.shot === b.shot &&
    a.ox === b.ox &&
    a.oy === b.oy &&
    a.oz === b.oz &&
    a.dx === b.dx &&
    a.dy === b.dy &&
    a.dz === b.dz
  );
}

/**
 * True if a predicted bullet is the one the server announced. The
 * announcement is rounded to 32-bit floats, so equal means within that
 * rounding and well inside anything that could change a hit.
 */
function matchesAnnouncement(predicted: Bullet, announced: Bullet): boolean {
  const near = (a: number, b: number, limit: number): boolean => a - b < limit && b - a < limit;
  return (
    predicted.shot === announced.shot &&
    near(predicted.ox, announced.ox, 0.01) &&
    near(predicted.oy, announced.oy, 0.01) &&
    near(predicted.oz, announced.oz, 0.01) &&
    near(predicted.dx, announced.dx, 1e-4) &&
    near(predicted.dy, announced.dy, 1e-4) &&
    near(predicted.dz, announced.dz, 1e-4)
  );
}

interface RemoteBullet {
  readonly bullet: Bullet;
  /** The server tick it hit something. Infinity while it is still flying. */
  hitTick: number;
}

function shortestArc(from: number, to: number): number {
  let delta = to - from;
  if (delta > TWO_PI / 2) delta -= TWO_PI;
  else if (delta < -TWO_PI / 2) delta += TWO_PI;
  return delta;
}

export class ClientCore implements WorldState {
  status: ClientStatus = 'connecting';
  rejectReason: RejectReason | null = null;
  closeReason: string | null = null;
  playerId = -1;
  /** Given by the server. Presenting it again takes the same seat back. */
  sessionToken: Uint8Array | null;

  /** The newest predicted tick and the ship's predicted state at it. */
  tick = 0;
  state: ShipState | null = null;

  /** The newest server tick received and the server's state at it. */
  ackTick = -1;
  ackState: ShipState | null = null;
  kills = 0;
  /** Points, the two multiplier timers and the store's timer, as of the newest snapshot. */
  score = 0;
  asteroidMultTicks = 0;
  killMultTicks = 0;
  storeTicks = 0;
  /** Everyone's points, as last sent. */
  scoreboard: readonly ScoreEntry[] = [];
  /** This pilot's experience and mission, as last sent. Null until the server has said. */
  progress: Progress | null = null;
  /** In the fort, as the server last said: no ship comes back until the player launches. */
  fort = false;
  /** Salvage crates held and not yet claimed, as last sent. */
  crates = 0;
  /** Crates won since the display last took them (tier and source index drops.ts). */
  readonly crateDrops: { tier: number; source: number }[] = [];

  /** Smoothed round trip in milliseconds, measured from input acknowledgements. */
  rttMs = 0;
  /** Typical input slack over the recent window, in ticks. */
  leadTicks = 0;
  /** The worst input slack over the recent window, in ticks. This is what is steered. */
  leadLowTicks = 0;
  /** Tick clock rate. 1 is real time. */
  rate = 1;
  /** How far behind the predicted tick the other ships are being drawn, in ticks. */
  viewDelayTicks = 0;

  readonly remotes: RemoteShips;

  /** The belt and the orbs, built from the seed in the welcome. Null until then. */
  world: World | null = null;

  readonly counters = {
    inputsSent: 0,
    snapshots: 0,
    corrections: 0,
    teleports: 0,
    missedInputs: 0,
    skippedTicks: 0,
    resyncs: 0,
    shotsFired: 0,
    ghostBullets: 0,
    viewHits: 0,
    serverHits: 0,
  };

  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly controls: (tick: number) => Controls;
  private readonly tuning: ClientTuning;
  private readonly onCorrection: ((event: CorrectionEvent) => void) | undefined;
  private readonly onSnapshot: ((event: SnapshotEvent) => void) | undefined;
  private readonly onViewHit: ((hit: ViewHit) => void) | undefined;
  private readonly onGameEvent: ((event: GameEvent) => void) | undefined;

  private readonly inbox: Arrival[] = [];

  // Prediction history, indexed by tick modulo HISTORY_SIZE.
  private readonly historyTick = new Int32Array(HISTORY_SIZE).fill(-1);
  private readonly historyInput: Input[] = new Array<Input>(HISTORY_SIZE).fill(NEUTRAL_INPUT);
  private readonly historyState: (ShipState | null)[] = new Array<ShipState | null>(
    HISTORY_SIZE,
  ).fill(null);
  private readonly historySentAtMs = new Float64Array(HISTORY_SIZE);
  private readonly historySlew = new Float64Array(HISTORY_SIZE);

  private previousState: ShipState | null = null;
  private lastSentInput: Input = NEUTRAL_INPUT;
  private accumulatorMs = 0;
  private lastUpdateMs = 0;

  /**
   * How far the tick clock has been moved against real time so far, in
   * ticks. Slack reports are stored with this taken out, so the controller
   * never mistakes its own adjustments for network jitter.
   */
  private slewTicks = 0;
  private readonly leadSamples: number[] = [];
  private haveRtt = false;

  // What is left of past corrections, added to the drawn ship and decayed.
  private offsetX = 0;
  private offsetY = 0;
  private offsetZ = 0;
  private offsetYaw = 0;
  private offsetPitch = 0;
  private offsetRoll = 0;

  /** Which rocks and orbs are gone: what the server has said, plus this client's predictions. */
  private predicted: PredictedWorld | null = null;
  private readonly effects: WorldEffect[] = [];
  /** Effects of orbs this player shot and of purchases, each waiting for its tick. */
  private scheduled: Scheduled[] = [];

  private ownBullets: OwnBullet[] = [];
  private readonly seekers = new SeekerTracks();
  private remoteBullets: RemoteBullet[] = [];
  /**
   * Recent damage to other ships that their drawn samples may not show yet:
   * this player's own hits as seen here, and other players' hits as the
   * server announced them. Target id → hits, in tick order.
   */
  private readonly recentDamage = new Map<number, { tick: number; amount: number }[]>();
  /** The tick each other ship was last reported destroyed. */
  private readonly lastDeathTick = new Map<number, number>();

  constructor(options: ClientOptions) {
    this.transport = options.transport;
    this.now = options.now;
    this.controls = options.controls;
    this.sessionToken = options.sessionToken ?? null;
    this.tuning = { ...DEFAULT_TUNING, ...options.tuning };
    this.remotes = new RemoteShips(options.remoteTuning);
    this.onCorrection = options.onCorrection;
    this.onSnapshot = options.onSnapshot;
    this.onViewHit = options.onViewHit;
    this.onGameEvent = options.onGameEvent;

    this.transport.onMessage((data) => {
      // Stamp arrivals now; they are handled in order on the next update.
      this.inbox.push({ timeMs: this.now(), data });
    });
    this.transport.onClose((reason) => {
      if (this.status !== 'rejected') this.status = 'closed';
      this.closeReason = reason;
    });
    this.transport.onOpen(() => {
      this.transport.send(
        encodeHello({
          protocolVersion: PROTOCOL_VERSION,
          simFingerprint: SIM_FINGERPRINT,
          clientTimeMs: this.now(),
          sessionToken: this.sessionToken,
          pilotKey: options.pilotKey ?? null,
        }),
        'reliable',
      );
    });
  }

  /** Runs every tick that is due and handles arrivals. Call once per frame. */
  update(): void {
    const now = this.now();
    // Ticks first: after a stall the prediction has to cover the gap before
    // the snapshots that arrived during it can be compared with anything.
    if (this.status === 'playing') this.runDueTicks(now);
    const wasPlaying = this.status === 'playing';
    for (const arrival of this.inbox) this.handle(arrival);
    this.inbox.length = 0;
    if (!wasPlaying && this.status === 'playing') this.runDueTicks(now);
  }

  /** Asks the store for something. Whether the player gets it is the server's decision. */
  buy(item: StoreItem): void {
    if (this.status === 'playing') this.transport.send(encodeBuy(item), 'reliable');
  }

  /**
   * Goes into the fort, or launches from it. The answer comes back as `fort`:
   * the server refuses a pilot whose ship is still flying.
   */
  setFort(held: boolean): void {
    if (this.status === 'playing') this.transport.send(encodeFort(held), 'reliable');
  }

  /**
   * Tells the server the player has gone (tab hidden) or come back. While
   * away nothing is simulated or sent. Coming back asks the server for a
   * fresh start: the tick clock and the prediction history are rebuilt from
   * its answer, and the gap is never replayed.
   */
  setAway(away: boolean): void {
    if (away && this.status === 'playing') {
      this.status = 'away';
      this.transport.send(encodePresence(true, this.now()), 'reliable');
    } else if (!away && this.status === 'away') {
      this.transport.send(encodePresence(false, this.now()), 'reliable');
    }
  }

  /**
   * The own ship as it should be drawn now: between the last two predicted
   * ticks, plus whatever is left of earlier corrections.
   */
  view(): ShipView | null {
    const current = this.state;
    if (!current) return null;
    const previous = this.previousState;
    // A respawn is a jump and is drawn as one. Dying is not: the ship flew
    // into the place where it died.
    const from = !previous || previous.spawnSeq !== current.spawnSeq ? current : previous;
    const alpha = this.accumulatorMs / TICK_MS;
    // `current` is one tick on from `from`, so the drawn moment is 1 − alpha before it.
    const stunt = stuntAngles(current, alpha - 1);
    return {
      x: from.x + (current.x - from.x) * alpha + this.offsetX,
      y: from.y + (current.y - from.y) * alpha + this.offsetY,
      z: from.z + (current.z - from.z) * alpha + this.offsetZ,
      yaw: from.yaw + shortestArc(from.yaw, current.yaw) * alpha + this.offsetYaw,
      pitch: from.pitch + (current.pitch - from.pitch) * alpha + this.offsetPitch,
      roll: from.roll + (current.roll - from.roll) * alpha + this.offsetRoll,
      stuntPitch: stunt.pitch,
      stuntRoll: stunt.roll,
      speed: from.speed + (current.speed - from.speed) * alpha,
      hp: current.hp,
      shield: current.shield,
      energy: current.energy,
      heavyAmmo: current.heavyAmmo,
      rapidTicks: current.rapidTicks,
      charge: current.charge,
      seekerCooldown: current.seekerCooldown,
      boosting: isBoosting(current),
      invulnerable: current.invulnTicks > 0,
      fenix: current.fenix,
      alive: current.alive,
    };
  }

  /**
   * The tick the own ship is drawn at, with its fraction. Rocks and this
   * player's bullets are drawn at this moment too, so the ship crashes into
   * rocks where they are seen. Other ships are drawn earlier (see
   * remotes.viewTick) and can appear to pass through a rock.
   */
  get drawTick(): number {
    return this.tick - 1 + this.accumulatorMs / TICK_MS;
  }

  /** True if a rock is destroyed at `tick`, as far as this client knows or predicts. */
  asteroidGone(id: number, tick: number): boolean {
    return this.predicted?.asteroidGone(id, tick) ?? false;
  }

  /** True if an orb is taken at `tick`, as far as this client knows or predicts. */
  orbGone(id: number, tick: number): boolean {
    return this.predicted?.orbGone(id, tick) ?? false;
  }

  /** Every other ship as it should be drawn now. */
  remoteViews(): RemoteView[] {
    return this.remotes.views();
  }

  /**
   * Every bullet to draw now. This player's bullets are placed on its own
   * predicted timeline; everyone else's on the timeline their ships are drawn on.
   */
  bulletViews(): BulletView[] {
    const views: BulletView[] = [];
    const place = (bullet: Bullet, atTick: number): void => {
      const travel = bulletTravel(bullet, atTick);
      if (travel < 0 || travel >= bulletLifeTicks(bullet) * bulletStep(bullet)) return;
      views.push({
        ownerId: bullet.ownerId,
        spawnTick: bullet.spawnTick,
        x: bullet.ox + bullet.dx * travel,
        y: bullet.oy + bullet.dy * travel,
        z: bullet.oz + bullet.dz * travel,
        dx: bullet.dx,
        dy: bullet.dy,
        dz: bullet.dz,
        shot: bullet.shot,
      });
    };
    const ownTick = this.drawTick;
    for (const own of this.ownBullets) if (!own.spent) place(own.bullet, ownTick);
    const remoteTick = this.remotes.viewTick;
    for (const remote of this.remoteBullets) {
      if (remoteTick < remote.hitTick) place(remote.bullet, remoteTick);
    }
    return views;
  }

  /** Every homing shot to draw now, on the timeline other ships are drawn on. */
  seekerViews(): SeekerView[] {
    return this.seekers.views(this.remotes.viewTick);
  }

  /** The predicted state the client holds for a tick, if it still has it. */
  predictedAt(tick: number): ShipState | null {
    const slot = tick & (HISTORY_SIZE - 1);
    return this.historyTick[slot] === tick ? (this.historyState[slot] ?? null) : null;
  }

  close(): void {
    this.transport.close();
  }

  // --- Arrivals ---------------------------------------------------------------

  private handle(arrival: Arrival): void {
    const message = decodeServerMessage(arrival.data);
    if (!message) return;
    switch (message.type) {
      case 'welcome':
        // A first welcome, or the answer to coming back from being away.
        if (this.status !== 'rejected' && this.status !== 'closed') {
          this.start(message, arrival.timeMs);
        }
        break;
      case 'reject':
        this.status = 'rejected';
        this.rejectReason = message.reason;
        break;
      case 'snapshot':
        if (this.status === 'playing') this.reconcile(message, arrival.timeMs);
        break;
      case 'events':
        if (this.status === 'playing') {
          for (const event of message.events) this.applyEvent(event);
        }
        break;
      case 'scores':
        this.scoreboard = message.entries;
        break;
    }
  }

  private start(welcome: WelcomeMessage, arrivedAtMs: number): void {
    this.playerId = welcome.playerId;
    this.sessionToken = welcome.sessionToken;
    this.rttMs = Math.max(0, arrivedAtMs - welcome.clientTimeMs);
    this.haveRtt = false;
    this.status = 'playing';
    this.lastUpdateMs = arrivedAtMs;
    this.accumulatorMs = 0;
    this.ackTick = -1;
    this.ackState = null;
    this.offsetX = this.offsetY = this.offsetZ = 0;
    this.offsetYaw = this.offsetPitch = this.offsetRoll = 0;
    this.ownBullets = [];
    this.remoteBullets = [];
    this.recentDamage.clear();
    this.lastDeathTick.clear();
    this.remotes.clear();
    this.seekers.clear();
    // The world is the same for the life of a room; which rocks and orbs
    // are gone is told again after every welcome.
    if (
      !this.world ||
      this.world.seed !== welcome.worldSeed ||
      this.world.belt.asteroids.length !== welcome.asteroidCount ||
      this.world.orbs.orbs.length > 0 !== welcome.withOrbs
    ) {
      this.world = createWorld(welcome.worldSeed, welcome.asteroidCount, welcome.withOrbs);
    }
    if (this.predicted) this.predicted.reset(this.world);
    else this.predicted = new PredictedWorld(this.world);
    this.scheduled = [];
    this.alignTo(welcome.serverTick, welcome.ship, NEUTRAL_INPUT);
  }

  /**
   * Places the tick clock ahead of the server and predicts up to it. Between
   * the given server tick and our first input the server repeats `assumed`,
   * so the prediction does the same.
   */
  private alignTo(serverTick: number, ship: ShipState, assumed: Input): void {
    const ahead =
      Math.ceil(this.rttMs / TICK_MS) +
      Math.ceil(this.tuning.baseLeadTicks) +
      this.tuning.initialExtraLeadTicks;
    this.historyTick.fill(-1);
    this.tick = serverTick;
    this.state = ship;
    this.previousState = ship;
    this.store(serverTick, assumed, ship, NOT_SENT);
    this.lastSentInput = assumed;
    for (let i = 0; i < ahead; i++) this.advance(assumed, false, 0);
    // Slack reports from before this moment describe the old alignment.
    this.leadSamples.length = 0;
    this.slewTicks = 0;
    this.rate = 1;
  }

  // --- Ticks ------------------------------------------------------------------

  private runDueTicks(now: number): void {
    const elapsed = Math.max(0, now - this.lastUpdateMs);
    this.lastUpdateMs = now;
    this.decayOffsets(elapsed);
    this.remotes.advance(now);

    this.accumulatorMs += elapsed * this.rate;
    this.slewTicks += (elapsed * (this.rate - 1)) / TICK_MS;
    let due = Math.floor(this.accumulatorMs / TICK_MS);
    this.accumulatorMs -= due * TICK_MS;

    if (due > this.tuning.maxTicksPerUpdate) {
      // A stall. The server has already simulated most of these ticks with
      // our last input, so predict the same and do not send them.
      const skipped = due - TICKS_KEPT_AFTER_STALL;
      for (let i = 0; i < skipped; i++) this.advance(this.lastSentInput, false, now);
      this.counters.skippedTicks += skipped;
      due = TICKS_KEPT_AFTER_STALL;
    }
    for (let i = 0; i < due; i++) {
      // Where the other ships were being drawn at this tick's moment. Several
      // ticks in one frame are one tick apart on that timeline too.
      const viewTick = this.remotes.viewTick - (due - 1 - i);
      const viewDelay = Number.isNaN(viewTick) ? 0 : this.tick + 1 - viewTick;
      // Quantise first, then predict from the quantised value that is sent.
      this.advance(quantiseControls(this.controls(this.tick + 1), viewDelay), true, now);
    }
    if (due > 0 && this.state) {
      this.viewDelayTicks = this.lastSentInput.viewDelay / VIEW_DELAY_STEPS_PER_TICK;
    }
  }

  private advance(input: Input, send: boolean, nowMs: number): void {
    const state = this.state;
    const world = this.world;
    if (!state || !world) return;
    this.tick += 1;
    this.previousState = state;
    this.state = this.stepOwnShip(state, input, this.tick, world);
    this.store(this.tick, input, this.state, send ? nowMs : NOT_SENT);
    const shot = shotThisTick(this.state);
    // A homing shot is the server's to fly; it arrives in snapshots.
    if (shot && shot !== 'seeker') {
      this.ownBullets.push({
        bullet: spawnBullet(this.playerId, this.tick, this.state, shot),
        confirmed: false,
        spent: false,
        pendingHit: null,
        took: null,
      });
      this.counters.shotsFired += 1;
    }
    if (!send) return;

    this.testOwnBullets(input, nowMs);

    const inputs: Input[] = [input];
    for (let back = 1; back < INPUT_REDUNDANCY; back++) {
      const slot = (this.tick - back) & (HISTORY_SIZE - 1);
      if (this.historyTick[slot] !== this.tick - back) break;
      inputs.push(this.historyInput[slot] ?? NEUTRAL_INPUT);
    }
    this.transport.send(encodeInput(this.tick, inputs), 'droppable');
    this.lastSentInput = input;
    this.counters.inputsSent += 1;
  }

  /**
   * One tick of the own ship, in the order the server uses: first what orbs
   * shot earlier and things bought do to it on this tick, then the step. The rocks it crashes
   * into and the orbs it flies through are noted as predictions.
   */
  private stepOwnShip(state: ShipState, input: Input, tick: number, world: World): ShipState {
    let ship = state;
    // Orbs first, then purchases, as on the server.
    for (const scheduled of this.scheduled) {
      if (scheduled.applyTick === tick && scheduled.orbId !== undefined) {
        ship = applyOrb(ship, scheduled.orbId, tick, world);
      }
    }
    for (const scheduled of this.scheduled) {
      if (scheduled.applyTick === tick && scheduled.item !== undefined) {
        ship = applyGrant(ship, scheduled.item);
      }
    }
    this.effects.length = 0;
    const next = stepPlayer(ship, input, tick, world, this, this.effects);
    for (const effect of this.effects) this.predicted?.predictContact(effect.kind, effect.id, tick);
    return next;
  }

  /**
   * The shooter's own hit test, run once per tick with exactly the numbers
   * the server will use: this tick, this input's view delay, and the other
   * ships' samples through the shared interpolation.
   */
  private testOwnBullets(input: Input, nowMs: number): void {
    if (this.ownBullets.length === 0) return;
    for (const own of this.ownBullets) this.testBullet(own, this.tick, input.viewDelay, nowMs);
    this.ownBullets = this.ownBullets.filter((own) => !bulletExpired(own.bullet, this.tick));
  }

  /**
   * Tests one bullet over one tick: against the other ships as they were
   * seen on that tick, and against the rocks and orbs where they were. As on
   * the server, the bullet stops at whichever is first on its path; on a tie
   * a ship comes before a rock and a rock before an orb.
   */
  private testBullet(own: OwnBullet, tick: number, viewDelay: number, nowMs: number): void {
    if (own.spent || own.bullet.spawnTick > tick || bulletExpired(own.bullet, tick)) return;
    const viewTick = tick - viewDelay / VIEW_DELAY_STEPS_PER_TICK;
    const hitDistance = shipHitDistance(own.bullet);
    let hitTarget = -1;
    let hitAt = Infinity;
    for (const id of this.remotes.ids()) {
      const seen = this.remotes.poseAt(id, viewTick);
      if (!seen?.alive || seen.invulnerable || !seen.full) continue;
      // The ship is drawn as it was a moment ago. If it is known to have
      // been destroyed since, the server will not count a hit on it.
      if (this.destroyedSince(id, seen.stateTick, seen.hp + seen.shield, tick)) continue;
      const reach = hitDistance * hullScaleOf(id);
      const at = bulletHit(own.bullet, tick, seen.x, seen.y, seen.z, reach);
      if (at >= 0 && at < hitAt) {
        hitAt = at;
        hitTarget = id;
      }
    }
    const world = this.world;
    const rock = world ? bulletAsteroidHit(world.belt, this, own.bullet, tick) : null;
    const orb = world ? bulletOrbHit(world.orbs, this, own.bullet, tick) : null;
    const rockAt = rock ? rock.at : Infinity;
    if (rock && rockAt < hitAt && (!orb || rockAt <= orb.at)) {
      this.predictShot(own, 'asteroid', rock.id, tick);
      return;
    }
    if (orb && orb.at < hitAt) {
      this.predictShot(own, 'orb', orb.id, tick);
      return;
    }
    if (hitTarget < 0) return;
    own.spent = true;
    const damage = bulletDamage(own.bullet);
    this.noteDamage(hitTarget, tick, damage);
    const hit: ViewHit = {
      timeMs: nowMs,
      ownerId: this.playerId,
      spawnTick: own.bullet.spawnTick,
      targetId: hitTarget,
      tick,
      damage,
    };
    // A shot the server has not confirmed yet may never have happened (the
    // ship may have died a moment before). Its hit waits for the confirmation.
    if (own.confirmed) this.reportViewHit(hit);
    else own.pendingHit = hit;
  }

  /** The bullet stops at a rock or an orb, which this client now takes to be gone. */
  private predictShot(own: OwnBullet, thing: WorldThing, id: number, tick: number): void {
    own.spent = true;
    own.took = { thing, id };
    this.predicted?.predictShot(thing, id, tick);
  }

  /**
   * Tests a bullet over the ticks that have already gone by. A bullet that
   * is learned of late, or whose path changed when the own ship was
   * corrected, has missed its tests for those ticks; the server has not.
   * Each tick is tested with the view delay that was sent for it.
   */
  private testPastTicks(own: OwnBullet, nowMs: number): void {
    for (let tick = own.bullet.spawnTick; tick <= this.tick && !own.spent; tick++) {
      const slot = tick & (HISTORY_SIZE - 1);
      if (this.historyTick[slot] !== tick) continue;
      this.testBullet(own, tick, (this.historyInput[slot] ?? NEUTRAL_INPUT).viewDelay, nowMs);
    }
  }

  /**
   * Removes the bullets `keep` rejects. What one of them was predicted to
   * have hit never happened, so it is taken back.
   */
  private dropOwnBullets(keep: (own: OwnBullet) => boolean): number {
    const before = this.ownBullets.length;
    this.ownBullets = this.ownBullets.filter((own) => {
      if (keep(own)) return true;
      this.forgetPrediction(own);
      return false;
    });
    return before - this.ownBullets.length;
  }

  /** Takes back the hit a bullet was holding and the rock or orb it was predicted to hit. */
  private forgetPrediction(own: OwnBullet): void {
    if (own.took) {
      this.predicted?.forgetShot(own.took.thing, own.took.id);
      own.took = null;
    }
    const hit = own.pendingHit;
    if (!hit) return;
    own.pendingHit = null;
    const hits = this.recentDamage.get(hit.targetId);
    const index = hits ? hits.findIndex((h) => h.tick === hit.tick && h.amount === hit.damage) : -1;
    if (hits && index >= 0) hits.splice(index, 1);
  }

  private noteDamage(targetId: number, tick: number, amount: number): void {
    let hits = this.recentDamage.get(targetId);
    if (!hits) {
      hits = [];
      this.recentDamage.set(targetId, hits);
    }
    // Kept in tick order; a hit found for a tick already past goes in its place.
    let at = hits.length;
    while (at > 0 && (hits[at - 1]?.tick ?? 0) > tick) at--;
    hits.splice(at, 0, { tick, amount });
    // Samples are never drawn more than a second or two behind.
    while (hits.length > 0 && (hits[0]?.tick ?? 0) < this.tick - 120) hits.shift();
  }

  /**
   * True if a ship that was alive with `hpSeen` hit points and shield at `seenTick` is
   * known to be dead by `atTick`: the server has said so, or the
   * hits known to have landed since then add up to all it had.
   */
  private destroyedSince(
    targetId: number,
    seenTick: number,
    hpSeen: number,
    atTick: number,
  ): boolean {
    const died = this.lastDeathTick.get(targetId);
    if (died !== undefined && died > seenTick && died <= atTick) return true;
    const hits = this.recentDamage.get(targetId);
    if (!hits) return false;
    let damage = 0;
    for (const hit of hits) {
      if (hit.tick > seenTick && hit.tick <= atTick) damage += hit.amount;
    }
    return damage >= hpSeen;
  }

  private reportViewHit(hit: ViewHit): void {
    this.counters.viewHits += 1;
    this.onViewHit?.(hit);
  }

  private store(tick: number, input: Input, state: ShipState, sentAtMs: number): void {
    const slot = tick & (HISTORY_SIZE - 1);
    this.historyTick[slot] = tick;
    this.historyInput[slot] = input;
    this.historyState[slot] = state;
    this.historySentAtMs[slot] = sentAtMs;
    this.historySlew[slot] = this.slewTicks;
  }

  // --- Snapshots and events -----------------------------------------------------

  private reconcile(snapshot: SnapshotMessage, arrivedAtMs: number): void {
    if (snapshot.serverTick <= this.ackTick) return;
    this.ackTick = snapshot.serverTick;
    this.ackState = snapshot.ship;
    this.kills = snapshot.kills;
    this.score = snapshot.score;
    this.asteroidMultTicks = snapshot.asteroidMultTicks;
    this.killMultTicks = snapshot.killMultTicks;
    this.storeTicks = snapshot.storeTicks;
    this.counters.snapshots += 1;
    this.counters.missedInputs += snapshot.missedInputs;

    this.remotes.arrived(snapshot.serverTick, arrivedAtMs);
    for (const entry of snapshot.remotes) this.remotes.add(entry.id, entry.sample);
    this.remotes.prune(snapshot.serverTick);
    this.seekers.arrived(snapshot.serverTick, snapshot.seekers);
    this.remoteBullets = this.remoteBullets.filter(
      (remote) => !bulletExpired(remote.bullet, snapshot.serverTick - 60),
    );

    const slot = snapshot.serverTick & (HISTORY_SIZE - 1);
    const known = this.historyTick[slot] === snapshot.serverTick;
    this.measure(
      snapshot,
      arrivedAtMs,
      known ? (this.historySentAtMs[slot] ?? NOT_SENT) : NOT_SENT,
      known ? (this.historySlew[slot] ?? this.slewTicks) : this.slewTicks,
    );
    this.onSnapshot?.({
      timeMs: arrivedAtMs,
      serverTick: snapshot.serverTick,
      inputLead: snapshot.inputLead,
      missedInputs: snapshot.missedInputs,
    });

    // The server announces every bullet before the snapshot of the tick it
    // was fired. A predicted bullet from that tick or earlier that was never
    // announced did not happen.
    this.counters.ghostBullets += this.dropOwnBullets(
      (own) => own.confirmed || own.bullet.spawnTick > snapshot.serverTick,
    );
    // The same goes for rocks and orbs.
    this.predicted?.settle(snapshot.serverTick);
    this.scheduled = this.scheduled.filter(
      (scheduled) => scheduled.applyTick > snapshot.serverTick - HISTORY_SIZE,
    );

    const present = this.state;
    const world = this.world;
    if (!present || !world) return;

    if (snapshot.serverTick >= this.tick || !known) {
      // The server has caught up with or passed the prediction, or the tick
      // has left the history. Start again from the server's state.
      this.counters.resyncs += 1;
      this.predicted?.forgetContacts();
      this.dropUnconfirmedBulletsAfter(snapshot.serverTick);
      this.alignTo(snapshot.serverTick, snapshot.ship, this.lastSentInput);
      this.finishCorrection(present, snapshot.serverTick, arrivedAtMs);
      return;
    }

    const predicted = this.historyState[slot];
    if (predicted && shipStatesEqual(predicted, snapshot.ship)) return;

    // Rewind to the server's state and replay every input sent since. Shots
    // predicted in the replayed ticks are predicted again: one that comes out
    // the same keeps what is known about it, one that differs is replaced,
    // and one that no longer happens is dropped. A new or replaced shot is
    // then tested over the ticks it has already flown.
    this.historyState[slot] = snapshot.ship;
    // Crashes and pickups after the server's tick are predicted afresh by the replay.
    this.predicted?.forgetContacts();
    let state = snapshot.ship;
    let previous = snapshot.ship;
    const refired = new Set<number>();
    const changed: OwnBullet[] = [];
    for (let tick = snapshot.serverTick + 1; tick <= this.tick; tick++) {
      const replaySlot = tick & (HISTORY_SIZE - 1);
      previous = state;
      state = this.stepOwnShip(state, this.historyInput[replaySlot] ?? NEUTRAL_INPUT, tick, world);
      this.historyState[replaySlot] = state;
      const shot = shotThisTick(state);
      if (!shot || shot === 'seeker') continue;
      refired.add(tick);
      const bullet = spawnBullet(this.playerId, tick, state, shot);
      const index = this.ownBullets.findIndex((own) => own.bullet.spawnTick === tick);
      const existing = this.ownBullets[index];
      if (existing && (existing.confirmed || sameBullet(existing.bullet, bullet))) continue;
      const fresh: OwnBullet = {
        bullet,
        confirmed: false,
        spent: false,
        pendingHit: null,
        took: null,
      };
      if (existing) {
        this.forgetPrediction(existing);
        this.ownBullets[index] = fresh;
      } else {
        this.ownBullets.push(fresh);
      }
      changed.push(fresh);
    }
    this.dropOwnBullets(
      (own) =>
        own.confirmed ||
        own.bullet.spawnTick <= snapshot.serverTick ||
        refired.has(own.bullet.spawnTick),
    );
    this.previousState = previous;
    this.state = state;
    for (const own of changed) this.testPastTicks(own, arrivedAtMs);
    this.finishCorrection(present, snapshot.serverTick, arrivedAtMs);
  }

  private dropUnconfirmedBulletsAfter(serverTick: number): void {
    this.dropOwnBullets((own) => own.confirmed || own.bullet.spawnTick <= serverTick);
  }

  private applyEvent(event: GameEvent): void {
    switch (event.kind) {
      case 'fort':
        this.fort = event.held;
        break;
      case 'crate':
        this.crates = event.held;
        if (event.tier !== NO_CRATE)
          this.crateDrops.push({ tier: event.tier, source: event.source });
        break;
      case 'progress':
        this.progress = {
          xp: event.xp,
          missionIndex: event.missionIndex,
          missionProgress: event.missionProgress,
          missionsDone: event.missionsDone,
        };
        break;
      case 'bullet': {
        const announced = bulletFrom(
          event.ownerId,
          event.spawnTick,
          event.x,
          event.y,
          event.z,
          event.yaw,
          event.pitch,
          event.shot,
        );
        if (event.ownerId !== this.playerId) {
          this.remoteBullets.push({ bullet: announced, hitTick: Infinity });
          break;
        }
        const index = this.ownBullets.findIndex((own) => own.bullet.spawnTick === event.spawnTick);
        const predicted = this.ownBullets[index];
        if (predicted && matchesAnnouncement(predicted.bullet, announced)) {
          predicted.confirmed = true;
          if (predicted.pendingHit) {
            this.reportViewHit(predicted.pendingHit);
            predicted.pendingHit = null;
          }
          break;
        }
        // The server fired a shot this client did not predict, or fired it
        // from somewhere else. The server's shot is the real one.
        const real: OwnBullet = {
          bullet: announced,
          confirmed: true,
          spent: false,
          pendingHit: null,
          took: null,
        };
        if (predicted) {
          this.forgetPrediction(predicted);
          this.ownBullets[index] = real;
        } else {
          this.ownBullets.push(real);
        }
        this.testPastTicks(real, this.now());
        break;
      }
      case 'hit': {
        if (event.ownerId === this.playerId) {
          this.counters.serverHits += 1;
          const own = this.ownBullets.find((b) => b.bullet.spawnTick === event.spawnTick);
          if (own) own.spent = true;
        } else {
          const remote = this.remoteBullets.find(
            (b) => b.bullet.ownerId === event.ownerId && b.bullet.spawnTick === event.spawnTick,
          );
          if (remote) remote.hitTick = event.tick;
          // Someone else's hit on a ship this player may be shooting at too.
          if (event.targetId !== this.playerId) {
            const amount = remote ? bulletDamage(remote.bullet) : SIM.bulletDamage;
            this.noteDamage(event.targetId, event.tick, amount);
          }
        }
        break;
      }
      case 'left':
        this.remotes.remove(event.playerId);
        this.remoteBullets = this.remoteBullets.filter((b) => b.bullet.ownerId !== event.playerId);
        this.recentDamage.delete(event.playerId);
        this.lastDeathTick.delete(event.playerId);
        break;
      case 'death':
        this.lastDeathTick.set(event.victimId, event.tick);
        break;
      case 'asteroid':
        this.worldEvent('asteroid', event.asteroidId, event);
        break;
      case 'orb':
        this.worldEvent('orb', event.orbId, event);
        // An orb this player shot acts on its ship a little later, on a
        // tick the server and this client both know.
        if (event.byBullet && event.playerId === this.playerId) {
          this.scheduled.push({
            applyTick: event.tick + SIM.shotEffectDelayTicks,
            orbId: event.orbId,
          });
        }
        break;
      case 'grant':
        this.scheduled.push({ applyTick: event.applyTick, item: event.item });
        break;
    }
    this.onGameEvent?.(event);
  }

  /** A rock or an orb has gone, by the server's word. */
  private worldEvent(
    thing: WorldThing,
    id: number,
    event: { tick: number; playerId: number; spawnTick: number; byBullet: boolean },
  ): void {
    this.predicted?.confirm(thing, id, event.tick);
    if (!event.byBullet) return;
    if (event.playerId === this.playerId) {
      const own = this.ownBullets.find((b) => b.bullet.spawnTick === event.spawnTick);
      if (own) {
        own.spent = true;
        own.took = null;
      }
    } else {
      const remote = this.remoteBullets.find(
        (b) => b.bullet.ownerId === event.playerId && b.bullet.spawnTick === event.spawnTick,
      );
      if (remote) remote.hitTick = event.tick;
    }
  }

  private finishCorrection(before: ShipState, ackTick: number, timeMs: number): void {
    const after = this.state;
    if (!after) return;
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    const dz = before.z - after.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const teleport = before.spawnSeq !== after.spawnSeq || before.alive !== after.alive;

    if (teleport || distance > this.tuning.snapDistance) {
      this.offsetX = this.offsetY = this.offsetZ = 0;
      this.offsetYaw = this.offsetPitch = this.offsetRoll = 0;
    } else {
      // Keep drawing the ship where it was, and let the difference fade.
      this.offsetX += dx;
      this.offsetY += dy;
      this.offsetZ += dz;
      this.offsetYaw += shortestArc(after.yaw, before.yaw);
      this.offsetPitch += before.pitch - after.pitch;
      this.offsetRoll += before.roll - after.roll;
    }

    if (teleport) this.counters.teleports += 1;
    else this.counters.corrections += 1;
    this.onCorrection?.({ timeMs, tick: this.tick, ackTick, distance, teleport });
  }

  private decayOffsets(elapsedMs: number): void {
    const keep = Math.pow(0.5, elapsedMs / this.tuning.offsetHalfLifeMs);
    this.offsetX *= keep;
    this.offsetY *= keep;
    this.offsetZ *= keep;
    this.offsetYaw *= keep;
    this.offsetPitch *= keep;
    this.offsetRoll *= keep;
  }

  /** Updates the round-trip estimate and steers the tick clock. */
  private measure(
    snapshot: SnapshotMessage,
    arrivedAtMs: number,
    sentAtMs: number,
    slewAtSend: number,
  ): void {
    const lead = snapshot.inputLead;
    if (Number.isNaN(lead)) return;

    // The input for this tick left at sentAtMs, waited `lead` ticks at the
    // server, and its result has now come back.
    if (sentAtMs !== NOT_SENT) {
      const sample = Math.max(0, arrivedAtMs - sentAtMs - lead * TICK_MS);
      this.rttMs = this.haveRtt ? this.rttMs + 0.1 * (sample - this.rttMs) : sample;
      this.haveRtt = true;
    }

    // Store the report as it would have been had the clock never been
    // adjusted. Adding the current adjustment back gives what that same
    // network delay would produce now.
    const tuning = this.tuning;
    this.leadSamples.push(lead - slewAtSend);
    if (this.leadSamples.length > tuning.leadWindow) this.leadSamples.shift();
    let sum = 0;
    let low = Infinity;
    for (const sample of this.leadSamples) {
      sum += sample;
      if (sample < low) low = sample;
    }
    this.leadTicks = sum / this.leadSamples.length + this.slewTicks;
    this.leadLowTicks = low + this.slewTicks;

    // Keep the worst recent slack inside [base, base + band]. Jitter needs no
    // estimate of its own: a jittery link has a low worst case, which pushes
    // the typical slack up by exactly as much as the jitter requires.
    let error = 0;
    if (this.leadLowTicks < tuning.baseLeadTicks) {
      error = tuning.baseLeadTicks - this.leadLowTicks;
    } else if (this.leadLowTicks > tuning.baseLeadTicks + tuning.leadBandTicks) {
      error = tuning.baseLeadTicks + tuning.leadBandTicks - this.leadLowTicks;
    }
    // But never buy safety with unlimited delay.
    if (this.leadTicks + error > tuning.maxLeadTicks) error = tuning.maxLeadTicks - this.leadTicks;

    const adjust = Math.max(
      -tuning.maxRateAdjust,
      Math.min(tuning.maxRateAdjust, error * tuning.rateGain),
    );
    this.rate = 1 + adjust;
  }
}
