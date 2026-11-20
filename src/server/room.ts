// One authoritative room. It owns the only true copy of every ship and
// bullet, advances them in fixed ticks, decides every hit and death, and
// tells each client what happened.
//
// The room does not touch sockets or the system clock: it is handed
// transports and a time source, so the same class runs behind a WebSocket
// server and inside virtual-time tests.

import { SIM, TICK_MS } from '../shared/constants.ts';
import {
  CAUSE_ASTEROID,
  CAUSE_DISCONNECT,
  CAUSE_EDGE,
  CAUSE_PLANET,
  CAUSE_PLAYER,
  NO_CRATE,
  NO_PLAYER,
  PROTOCOL_VERSION,
  REJECT_FULL,
  REJECT_FORT,
  REJECT_IDLE,
  REJECT_VERSION,
  SESSION_TOKEN_BYTES,
  decodeClientMessage,
  encodeEvents,
  encodeReject,
  encodeScores,
  encodeSnapshot,
  encodeWelcome,
} from '../shared/protocol.ts';
import type {
  BulletEvent,
  DeathCause,
  GameEvent,
  HelloMessage,
  InputMessage,
  RemoteEntry,
  SeekerEntry,
} from '../shared/protocol.ts';
import {
  FIRST_RAIDER_ID,
  MISSIONS,
  NEW_PROGRESS,
  NPC_SCORE,
  RAIDER_COUNT,
  WARLORD_ARMOUR,
  WARLORD_ID,
  XP,
  hullScaleOf,
  levelOf,
  nextMissionIndex,
} from '../shared/progress.ts';
import type { MissionKind, Progress } from '../shared/progress.ts';
import {
  CRATE_CHANCE,
  CRATE_SOURCES,
  CRATE_TIERS,
  bossCrateChance,
  crateTier,
} from '../shared/drops.ts';
import type { CrateSource } from '../shared/drops.ts';
import { distantSampleOf, sampleOf, sampleTrack } from '../shared/remote.ts';
import type { RemoteSample } from '../shared/remote.ts';
import { Rng } from '../shared/rng.ts';
import {
  SCORE,
  STORE_PRICES,
  asteroidScore,
  inBelt,
  killScore,
  orbScore,
} from '../shared/scoring.ts';
import type { StoreItem } from '../shared/scoring.ts';
import { bulletAsteroidHit } from '../shared/sim/belt.ts';
import {
  bulletDamage,
  bulletExpired,
  bulletHit,
  shipHitDistance,
  spawnBullet,
} from '../shared/sim/bullets.ts';
import type { Bullet } from '../shared/sim/bullets.ts';
import { launchSeeker, seekerExpired, seekerPath, stepSeeker } from '../shared/sim/seeker.ts';
import type { Seeker } from '../shared/sim/seeker.ts';
import { SIM_FINGERPRINT } from '../shared/sim/fingerprint.ts';
import {
  NEUTRAL_INPUT,
  VIEW_DELAY_STEPS_PER_TICK,
  damageShip,
  destroyShip,
  quantiseControls,
  shotThisTick,
  spawnShip,
} from '../shared/sim/ship.ts';
import type { Input, ShipState, ShotKind } from '../shared/sim/ship.ts';
import { bulletOrbHit } from '../shared/sim/orbs.ts';
import {
  WorldLedger,
  applyGrant,
  applyOrb,
  createWorld,
  grantWouldChange,
  outsideCombatZone,
  stepPlayer,
} from '../shared/sim/world.ts';
import type { World, WorldEffect } from '../shared/sim/world.ts';
import type { Channel, Transport } from '../shared/transport.ts';
import {
  RAIDER_RESPAWN_TICKS,
  WARLORD_FIRST_TICKS,
  WARLORD_RETURN_TICKS,
  createBrain,
  npcControls,
  provoke,
} from './npc.ts';
import type { NpcBrain, NpcTarget } from './npc.ts';
import type { MemoryCrateStore } from './crates.ts';
import type { PilotStore } from './pilots.ts';

export const MAX_PLAYERS = 16;

/** A snapshot goes out every second tick: 30 a second. */
export const SNAPSHOT_EVERY_TICKS = 2;

/** Ships within this distance are sent in full, 30 times a second. */
export const NEAR_RADIUS = 2000;
/** A near ship stays near until it is this far away, so it does not flicker between tiers. */
export const NEAR_RADIUS_EXIT = 2200;
/** Distant ships are sent as a position on every sixth snapshot: 5 a second. */
export const FAR_EVERY_SNAPSHOTS = 6;

/** The scoreboard goes to everyone once a second. */
export const SCORES_EVERY_TICKS = 60;

/** Bullets and hits are announced to players within this distance. A bullet flies 690 units. */
const EVENT_RADIUS = NEAR_RADIUS + 800;

/**
 * Decision D6: how long the ship of a player who has gone away keeps flying
 * before it is destroyed. The seat and its points are held for SEAT_TICKS.
 */
export const AWAY_GRACE_TICKS = 600;

/**
 * A player whose controls have not changed for two minutes is taken to have
 * walked away: the ship is destroyed and stays out until a control moves. An
 * idle ship would otherwise be a free target, worth 500 points a hit.
 */
export const IDLE_TICKS = 120 * 60;

/** Five minutes away or idle, and the seat goes to someone else. */
export const SEAT_TICKS = 300 * 60;

/** A client is given a fresh welcome at most once a second. */
export const WELCOME_EVERY_TICKS = 60;

/**
 * A token whose connection sent an input this recently may still be in use.
 * A second connection presenting it is either the same player coming back (a
 * reloaded page, whose old socket has not been seen to close yet) or a second
 * player (a duplicated browser tab copies the token). The room waits to see
 * which: if the old connection sends another input, the newcomer gets a seat
 * of its own; if it stays silent for CLAIM_TICKS, or closes, the newcomer
 * takes the seat.
 */
export const TOKEN_IN_USE_TICKS = 60;
export const CLAIM_TICKS = 30;

/** Inputs numbered further ahead than this are refused, which bounds the buffer. */
export const MAX_INPUT_LEAD_TICKS = 120;

/** Snapshot samples kept per ship for rewinding. 64 samples is over two seconds. */
const TRACK_LENGTH = 64;

/** After a stall the room simulates at most this many ticks in one go. */
const MAX_CATCH_UP_TICKS = 120;

/** A connection that has not said hello by now is closed. */
const HELLO_TIMEOUT_MS = 5000;

/** A connection is closed after this many malformed messages. */
const MAX_MALFORMED_MESSAGES = 20;

/** A pilot's progress is written to the store this often while it is changing. */
const SAVE_EVERY_TICKS = 600;

export interface DeathRecord {
  /** Unique for the life of the room, so a payout can never be made twice. */
  deathId: number;
  /** Either may be a ship the server flies (progress.ts, npcKindOf), which nobody pays or is paid for. */
  victimId: number;
  killerId: number | null;
  cause: DeathCause;
  tick: number;
  /** Ticks the victim had been alive in this life. */
  survivalTicks: number;
  /** Kills the victim made in this life. */
  kills: number;
  /** The victim's points at the moment of death. */
  score: number;
}

export interface HitRecord {
  ownerId: number;
  spawnTick: number;
  targetId: number;
  tick: number;
}

/** What the room reports to the outside. Phase 5's economy listens here. */
export interface RoomListener {
  playerJoined?: (playerId: number, tick: number) => void;
  playerLeft?: (playerId: number, tick: number) => void;
  playerDied?: (death: DeathRecord) => void;
  /** A bullet the server decided was a hit. */
  hit?: (hit: HitRecord) => void;
}

export interface RoomOptions {
  now: () => number;
  seed: number;
  /** 16 unguessable bytes for a new player's session. */
  createToken: () => Uint8Array;
  maxPlayers?: number;
  /** Rocks in the belt. The default is the full belt; tests of one mechanism ask for empty space. */
  asteroidCount?: number;
  /** False leaves the orbs out, for tests of one mechanism. */
  orbs?: boolean;
  listener?: RoomListener;
  /** True adds the ships the server flies: raiders, and the Warlord. */
  npcs?: boolean;
  /** Keeps pilots' progress between visits. Without one it lasts as long as the seat. */
  pilots?: PilotStore;
  /** Holds the salvage crates pilots win. Without one nothing drops. */
  crates?: MemoryCrateStore;
  /** The chance of a crate from each source, in place of the real odds. Tests of the mechanism raise them. */
  crateOdds?: Partial<Record<CrateSource, number>>;
  /** Called after every simulated tick. Tests use it to record what really happened. */
  onTick?: (tick: number, room: Room) => void;
  /**
   * Called after each advance that simulated something, with how long the
   * work took (simulation, events and snapshots) and how many ticks it
   * covered. The load test uses it.
   */
  onWork?: (durationMs: number, ticks: number) => void;
}

export interface RoomStats {
  /** Ticks thrown away because the process stalled for longer than the catch-up limit. */
  droppedTicks: number;
  malformedMessages: number;
  /** Inputs that arrived after their tick had been simulated. */
  lateInputs: number;
  /** Player-ticks simulated by reusing the previous input. */
  missedInputs: number;
  bytesSent: number;
  messagesSent: number;
  bulletsFired: number;
  hits: number;
  deaths: number;
  asteroidsShot: number;
  asteroidsCrashed: number;
  orbsTaken: number;
  orbsShot: number;
}

interface Connection {
  readonly transport: Transport;
  readonly openedAtMs: number;
  malformed: number;
  player: Player | null;
  /** It has said hello and is waiting to be seated. A second hello is malformed. */
  claiming: boolean;
  closed: boolean;
}

interface Player {
  readonly id: number;
  readonly token: Uint8Array;
  connection: Connection | null;
  ship: ShipState;
  /** The input applied on the current tick. Its view delay places this player's bullets. */
  input: Input;
  /** Inputs for ticks that have not been simulated yet. */
  readonly pending: Map<number, Input>;
  /** The tick of the first input since the last (re)join. Null until one arrives. */
  firstInputTick: number | null;
  /** Worst input lead since the last snapshot, in ticks. NaN if none arrived. */
  worstLead: number;
  missedSinceSnapshot: number;
  /** Tab hidden or socket gone. The ship flies straight and the seat is held for a while. */
  away: boolean;
  awaySinceTick: number;
  /** Ticks in a row that the controls applied have been the same. */
  unchangedTicks: number;
  /** Held out of the game for not touching the controls. Ends when one moves. */
  idle: boolean;
  idleSinceTick: number;
  /**
   * In the fort: the player chose it over flying again, or their ship was
   * lost while they were away. A ship is not brought back until they launch,
   * and they do not count as idle. The seat is held for SEAT_TICKS.
   */
  inFort: boolean;
  fortSinceTick: number;
  lastWelcomeTick: number;
  /** The tick the newest input message arrived on. */
  lastInputAtTick: number;
  /** A newcomer presenting this player's token, waiting to learn whether the seat is free. */
  claim: { connection: Connection; clientTimeMs: number; atTick: number } | null;
  /** A "back" that arrived too soon after the last welcome, to be answered when a second has passed. */
  backDue: { connection: Connection; clientTimeMs: number } | null;
  kills: number;
  killsThisLife: number;
  spawnedAtTick: number;
  /** Points. Only the server ever changes them. */
  score: number;
  /** Ticks left of doubled asteroid and orb points (miner orb), and of doubled kill points (hunter orb). */
  asteroidMultTicks: number;
  killMultTicks: number;
  /** Ticks the store stays open. A Zaphire orb opens it; a purchase shuts it. */
  storeTicks: number;
  lastFireTick: number;
  /** Sixtieths of a point of belt income not yet paid out. */
  beltIncome: number;
  /** The ships currently sent to this player in full. */
  readonly near: Set<number>;
  /** Send every distant ship in the next snapshot, whatever the schedule says. */
  fullStateDue: boolean;
  /** What snapshots have said about this ship, in tick order. Used to rewind it. */
  readonly track: RemoteSample[];
  readonly outbox: GameEvent[];
  /** Orbs this player shot, whose effect on the ship is due on a coming tick. */
  scheduledOrbs: { applyTick: number; orbId: number; spawnTick: number }[];
  /** Things bought from the store, due on a coming tick in the same way. */
  scheduledGrants: { applyTick: number; item: StoreItem }[];
  /** Experience and the mission in hand. Only the server ever changes them. */
  progress: Progress;
  /** The progress has changed since the player was last told. */
  progressDue: boolean;
  /** The progress has changed since it was last written to the store. */
  saveDue: boolean;
  /** The pilot this progress belongs to, in hex. Null for a visitor. */
  readonly pilotKey: string | null;
  /** Ticks alive in the belt not yet counted as a second. */
  beltTicks: number;
  /** Set for a ship the server flies. It has no connection and is never away. */
  readonly npc: NpcBrain | null;
  /** For a ship the server flies: the tick it comes back on. */
  respawnAtTick: number;
  /** The crate count this player was last sent, or -1 for never. */
  cratesTold: number;
  /** The players who have damaged this ship in this life, and by how much. */
  readonly damagedBy: Map<number, number>;
}

interface LiveBullet {
  readonly bullet: Bullet;
  readonly announcement: BulletEvent;
}

/** The server's own ships have no session. No hello can present this: an all-zero token reads as none. */
const NO_TOKEN = new Uint8Array(SESSION_TOKEN_BYTES);

function sameToken(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < a.byteLength; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

function distanceSq(a: ShipState, x: number, y: number, z: number): number {
  const dx = a.x - x;
  const dy = a.y - y;
  const dz = a.z - z;
  return dx * dx + dy * dy + dz * dz;
}

export class Room {
  tick = 0;
  readonly stats: RoomStats = {
    droppedTicks: 0,
    malformedMessages: 0,
    lateInputs: 0,
    missedInputs: 0,
    bytesSent: 0,
    messagesSent: 0,
    bulletsFired: 0,
    hits: 0,
    deaths: 0,
    asteroidsShot: 0,
    asteroidsCrashed: 0,
    orbsTaken: 0,
    orbsShot: 0,
  };

  /** The belt and orbs this room was built with. Clients build the same from the welcome. */
  readonly world: World;
  /** Which rocks are destroyed and which orbs are taken. The only true copy. */
  readonly ledger: WorldLedger;

  private readonly now: () => number;
  private readonly rng: Rng;
  /** Its own generator, so a room flies and spawns its players the same with or without these ships. */
  private readonly npcRng: Rng;
  private readonly withNpcs: boolean;
  private readonly pilots: PilotStore | undefined;
  private readonly crates: MemoryCrateStore | undefined;
  /** Its own stream, so a room with drops flies exactly as one without. */
  private readonly dropRng: Rng;
  private readonly crateOdds: Partial<Record<CrateSource, number>>;
  private readonly createToken: () => Uint8Array;
  private readonly maxPlayers: number;
  private readonly listener: RoomListener;
  private readonly onTick: ((tick: number, room: Room) => void) | undefined;
  private readonly onWork: ((durationMs: number, ticks: number) => void) | undefined;
  private readonly connections = new Set<Connection>();
  private readonly players = new Map<number, Player>();
  private bullets: LiveBullet[] = [];
  private seekers: Seeker[] = [];
  private nextDeathId = 1;
  private snapshotsSent = 0;
  /** The moment the current tick was due. Null until the first advance. */
  private tickDueAtMs: number | null = null;

  constructor(options: RoomOptions) {
    this.now = options.now;
    this.rng = new Rng(options.seed);
    this.createToken = options.createToken;
    this.maxPlayers = options.maxPlayers ?? MAX_PLAYERS;
    this.listener = options.listener ?? {};
    this.onTick = options.onTick;
    this.onWork = options.onWork;
    const asteroidCount = options.asteroidCount ?? SIM.asteroidCount;
    const worldSeed = options.seed >>> 0;
    this.world = createWorld(worldSeed, asteroidCount, options.orbs ?? true);
    this.ledger = new WorldLedger(this.world);
    this.npcRng = new Rng((options.seed ^ 0x52a1de25) >>> 0);
    this.withNpcs = options.npcs ?? false;
    this.pilots = options.pilots;
    this.crates = options.crates;
    this.crateOdds = options.crateOdds ?? {};
    this.dropRng = new Rng((options.seed ^ 0x0c4a7e5d) >>> 0);
    if (this.withNpcs) {
      const warlord = this.newPlayer(WARLORD_ID, NO_TOKEN, createBrain('warlord', this.npcRng));
      warlord.ship = destroyShip(warlord.ship);
      warlord.respawnAtTick = WARLORD_FIRST_TICKS;
      this.players.set(warlord.id, warlord);
      for (let i = 0; i < RAIDER_COUNT; i++) {
        const raider = this.newPlayer(
          FIRST_RAIDER_ID + i,
          NO_TOKEN,
          createBrain('raider', this.npcRng),
        );
        this.players.set(raider.id, raider);
      }
    }
  }

  /** People in the room. The ships the server flies are not counted. */
  get playerCount(): number {
    let count = 0;
    for (const player of this.players.values()) if (!player.npc) count++;
    return count;
  }

  /** A player's experience and mission. */
  progressOf(playerId: number): Readonly<Progress> | undefined {
    return this.players.get(playerId)?.progress;
  }

  /** Every ship the server flies. */
  npcIds(): number[] {
    return [...this.players.values()].filter((player) => player.npc).map((player) => player.id);
  }

  /** Every homing shot in flight. */
  get seekersInFlight(): readonly Seeker[] {
    return this.seekers;
  }

  get bulletCount(): number {
    return this.bullets.length;
  }

  /** The authoritative ship of a player. */
  shipOf(playerId: number): ShipState | undefined {
    return this.players.get(playerId)?.ship;
  }

  killsOf(playerId: number): number {
    return this.players.get(playerId)?.kills ?? 0;
  }

  scoreOf(playerId: number): number {
    return this.players.get(playerId)?.score ?? 0;
  }

  /** Test and development aid: gives a player points. Never reachable from the network. */
  addScore(playerId: number, points: number): void {
    const player = this.players.get(playerId);
    if (player) player.score = Math.max(0, player.score + points);
  }

  /** Test and development aid: gives a player experience. Never reachable from the network. */
  addXp(playerId: number, amount: number): void {
    const player = this.players.get(playerId);
    if (player) this.gainXp(player, amount);
  }

  isAway(playerId: number): boolean {
    return this.players.get(playerId)?.away ?? false;
  }

  playerIds(): number[] {
    return [...this.players.values()].filter((player) => !player.npc).map((player) => player.id);
  }

  /**
   * Test aid: gives up at once every seat whose connection has closed, instead
   * of holding it for SEAT_TICKS, so a browser test starts in an empty room.
   */
  releaseDroppedSeats(): void {
    for (const player of [...this.players.values()]) {
      if (!player.npc && !player.connection && !player.claim) this.remove(player);
    }
  }

  /**
   * Test and development aid: replaces a player's ship. Never reachable from
   * the network.
   */
  placeShip(playerId: number, change: (ship: ShipState) => ShipState): void {
    const player = this.players.get(playerId);
    if (player) player.ship = change(player.ship);
  }

  /** Takes over a new connection. The first message must be a hello. */
  connect(transport: Transport): void {
    const connection: Connection = {
      transport,
      openedAtMs: this.now(),
      malformed: 0,
      player: null,
      claiming: false,
      closed: false,
    };
    this.connections.add(connection);
    transport.onMessage((data) => {
      this.receive(connection, data);
    });
    transport.onClose(() => {
      this.drop(connection);
    });
  }

  /**
   * Simulates every tick that is due. Call it often; it does nothing until a
   * tick boundary has passed. Real time decides how many ticks run, never the
   * caller's timer.
   */
  advance(): void {
    const now = this.now();
    this.tickDueAtMs ??= now;

    let steps = 0;
    let snapshotDue = false;
    while (now - this.tickDueAtMs >= TICK_MS) {
      if (steps === MAX_CATCH_UP_TICKS) {
        const dropped = Math.floor((now - this.tickDueAtMs) / TICK_MS);
        this.tickDueAtMs += dropped * TICK_MS;
        this.stats.droppedTicks += dropped;
        break;
      }
      this.tickDueAtMs += TICK_MS;
      this.step();
      steps++;
      if (this.tick % SNAPSHOT_EVERY_TICKS === 0) snapshotDue = true;
      if (this.tick % SCORES_EVERY_TICKS === 0) this.sendScores();
    }
    if (snapshotDue) this.sendSnapshots();
    if (steps > 0) this.onWork?.(this.now() - now, steps);

    for (const connection of this.connections) {
      if (!connection.player && now - connection.openedAtMs > HELLO_TIMEOUT_MS) {
        this.close(connection);
      }
    }
  }

  // --- One tick -------------------------------------------------------------

  private step(): void {
    this.tick += 1;
    this.stepShips();
    this.stepBullets();
    this.stepSeekers();
    this.stepAwayAndRespawn();
    this.flushEvents();
    this.onTick?.(this.tick, this);
  }

  private stepShips(): void {
    const effects: WorldEffect[] = [];
    let targets: NpcTarget[] | null = null;
    for (const player of this.players.values()) {
      let input: Input;
      if (player.npc) {
        targets ??= this.npcTargets();
        input = quantiseControls(
          npcControls(player.npc, player.ship, targets, this.tick, this.npcRng),
        );
      } else if (player.away) {
        // Decision D6: an absent player's ship flies straight and can be hit.
        input = NEUTRAL_INPUT;
      } else {
        const arrived = player.pending.get(this.tick);
        if (arrived) {
          player.pending.delete(this.tick);
          input = arrived;
        } else {
          // No input for this tick: carry on with the last one. The ship
          // never freezes for other players, and withholding input gains
          // nothing. Ticks before the player's first input are not misses.
          input = player.input;
          if (player.firstInputTick !== null && this.tick >= player.firstInputTick) {
            player.missedSinceSnapshot += 1;
            this.stats.missedInputs += 1;
          }
        }
      }
      // The view delay drifts by itself; only the controls show a hand on them.
      const last = player.input;
      const unchanged =
        input.yaw === last.yaw &&
        input.pitch === last.pitch &&
        input.throttle === last.throttle &&
        input.fire === last.fire;
      player.unchangedTicks =
        unchanged && !player.npc && !player.inFort ? player.unchangedTicks + 1 : 0;
      if (!unchanged) player.idle = false;
      player.input = input;

      if (player.asteroidMultTicks > 0) player.asteroidMultTicks -= 1;
      if (player.killMultTicks > 0) player.killMultTicks -= 1;
      if (player.storeTicks > 0) player.storeTicks -= 1;

      // What orbs shot earlier and things bought do to the ship today, then the step.
      let before = player.ship;
      if (player.scheduledOrbs.length > 0) {
        for (const scheduled of player.scheduledOrbs) {
          if (scheduled.applyTick === this.tick) {
            before = applyOrb(before, scheduled.orbId, this.tick, this.world);
          }
        }
        player.scheduledOrbs = player.scheduledOrbs.filter((s) => s.applyTick > this.tick);
      }
      if (player.scheduledGrants.length > 0) {
        for (const scheduled of player.scheduledGrants) {
          if (scheduled.applyTick === this.tick) before = applyGrant(before, scheduled.item);
        }
        player.scheduledGrants = player.scheduledGrants.filter((s) => s.applyTick > this.tick);
      }
      effects.length = 0;
      player.ship = stepPlayer(before, input, this.tick, this.world, this.ledger, effects);
      // A rock or orb taken by one ship is gone for the ships stepped after it.
      let crashed = false;
      for (const effect of effects) {
        if (effect.kind === 'asteroid') {
          crashed = true;
          this.ledger.asteroids.remove(effect.id, this.tick);
          this.stats.asteroidsCrashed += 1;
          this.broadcast({
            kind: 'asteroid',
            asteroidId: effect.id,
            tick: this.tick,
            playerId: player.id,
            spawnTick: 0,
            byBullet: false,
          });
        } else {
          this.ledger.orbs.remove(effect.id, this.tick);
          this.stats.orbsTaken += 1;
          this.rewardOrb(player, effect.id);
          this.broadcast({
            kind: 'orb',
            orbId: effect.id,
            tick: this.tick,
            playerId: player.id,
            spawnTick: 0,
            byBullet: false,
          });
        }
      }
      if (before.alive && !player.ship.alive) {
        const cause = crashed
          ? CAUSE_ASTEROID
          : outsideCombatZone(player.ship)
            ? CAUSE_EDGE
            : CAUSE_PLANET;
        this.recordDeath(player, null, cause);
      }

      // A point a second for being in the belt; two soon after firing (main.js:8852-8859).
      if (player.ship.alive && inBelt(player.ship.x, player.ship.z)) {
        const inCombat = this.tick - player.lastFireTick < SCORE.combatTicks;
        player.beltIncome += inCombat ? SCORE.beltIncomeInCombat : SCORE.beltIncome;
        if (player.beltIncome >= SIM.tickRate) {
          player.beltIncome -= SIM.tickRate;
          player.score += 1;
        }
        player.beltTicks += 1;
        if (player.beltTicks >= SIM.tickRate) {
          player.beltTicks = 0;
          this.advanceMission(player, 'belt');
        }
      }
      const shot = shotThisTick(player.ship);
      if (shot) this.fire(player, shot);
    }
  }

  /** What taking an orb is worth, and what it sets going, whether flown through or shot. */
  private rewardOrb(player: Player, orbId: number): void {
    const orb = this.world.orbs.orbs[orbId];
    if (!orb) return;
    player.score += orbScore(orb.kind, player.asteroidMultTicks > 0);
    this.gainXp(player, XP.orb);
    this.advanceMission(player, 'orbs');
    this.rollCrate(player, 'orb', CRATE_CHANCE.orb);
    if (orb.kind === 'miner') player.asteroidMultTicks = SCORE.multiplierTicks;
    if (orb.kind === 'hunter') player.killMultTicks = SCORE.multiplierTicks;
    if (orb.kind === 'zaphire') player.storeTicks = SCORE.storeTicks;
  }

  /**
   * The store. A purchase needs the store to be open, the points, and a
   * ship the item would do something for. It reaches the ship a little
   * later, on a tick the buyer's client is told.
   */
  private buy(player: Player, item: StoreItem): void {
    const price = STORE_PRICES[item];
    if (player.storeTicks === 0 || player.score < price) return;
    if (!grantWouldChange(player.ship, item)) return;
    player.score -= price;
    player.storeTicks = 0;
    const applyTick = this.tick + SIM.shotEffectDelayTicks;
    player.scheduledGrants.push({ applyTick, item });
    player.outbox.push({ kind: 'grant', item, applyTick });
  }

  private fire(player: Player, shot: ShotKind): void {
    player.lastFireTick = this.tick;
    const ship = player.ship;
    if (shot === 'seeker') {
      // The server's ships do not lock on to each other.
      const others = [...this.players.values()].filter((other) => !(player.npc && other.npc));
      this.seekers.push(launchSeeker(player.id, this.tick, ship, others));
      return;
    }
    const live: LiveBullet = {
      bullet: spawnBullet(player.id, this.tick, ship, shot),
      announcement: {
        kind: 'bullet',
        ownerId: player.id,
        spawnTick: this.tick,
        x: ship.x,
        y: ship.y,
        z: ship.z,
        yaw: ship.yaw,
        pitch: ship.pitch,
        shot,
      },
    };
    this.bullets.push(live);
    this.stats.bulletsFired += 1;
    this.announce(live.announcement, ship.x, ship.y, ship.z, player.id, NO_PLAYER);
  }

  /**
   * Moves every bullet one tick and decides hits. A bullet stops at the
   * first thing on its path this tick: ship, rock or orb. On a tie a ship
   * comes before a rock and a rock before an orb.
   *
   * Lag compensation (decision D2): a bullet is tested against each target
   * where its shooter was seeing that target on this tick. The shooter's
   * input says how far behind its view was; the target's position at that
   * moment comes from the snapshots actually sent, through the same
   * interpolation the shooter's client draws with.
   */
  private stepBullets(): void {
    const survivors: LiveBullet[] = [];
    for (const live of this.bullets) {
      const bullet = live.bullet;
      const owner = this.players.get(bullet.ownerId);
      if (!owner || bulletExpired(bullet, this.tick)) continue;

      const viewTick = this.tick - owner.input.viewDelay / VIEW_DELAY_STEPS_PER_TICK;
      const hitDistance = shipHitDistance(bullet);
      let hitTarget: Player | null = null;
      let hitAt = Infinity;
      for (const target of this.players.values()) {
        if (target === owner || !target.ship.alive) continue;
        // The server's ships do not shoot each other.
        if (owner.npc && target.npc) continue;
        const seen = sampleTrack(target.track, viewTick, 0);
        // The shooter must have been looking at this life of the ship, alive
        // and unprotected.
        if (!seen?.alive || seen.invulnerable || seen.spawnSeq !== target.ship.spawnSeq) continue;
        const reach = hitDistance * hullScaleOf(target.id);
        const at = bulletHit(bullet, this.tick, seen.x, seen.y, seen.z, reach);
        if (at >= 0 && at < hitAt) {
          hitAt = at;
          hitTarget = target;
        }
      }

      // Rocks are tested where they are now: every client computes the same
      // place for them, so there is nothing to rewind.
      // Orbs do not move at all.
      const rock = bulletAsteroidHit(this.world.belt, this.ledger, bullet, this.tick);
      const orb = bulletOrbHit(this.world.orbs, this.ledger, bullet, this.tick);
      const rockAt = rock ? rock.at : Infinity;
      if (orb && orb.at < hitAt && orb.at < rockAt) {
        // The orb is gone now. What it does to the shooter happens a little
        // later, on a tick the announcement lets the shooter's client know.
        this.ledger.orbs.remove(orb.id, this.tick);
        this.stats.orbsShot += 1;
        this.rewardOrb(owner, orb.id);
        owner.scheduledOrbs.push({
          applyTick: this.tick + SIM.shotEffectDelayTicks,
          orbId: orb.id,
          spawnTick: bullet.spawnTick,
        });
        this.broadcast({
          kind: 'orb',
          orbId: orb.id,
          tick: this.tick,
          playerId: owner.id,
          spawnTick: bullet.spawnTick,
          byBullet: true,
        });
        continue;
      }
      if (rock && rock.at < hitAt) {
        this.ledger.asteroids.remove(rock.id, this.tick);
        this.stats.asteroidsShot += 1;
        this.rewardRock(owner);
        this.broadcast({
          kind: 'asteroid',
          asteroidId: rock.id,
          tick: this.tick,
          playerId: owner.id,
          spawnTick: bullet.spawnTick,
          byBullet: true,
        });
        continue;
      }
      if (!hitTarget) {
        survivors.push(live);
        continue;
      }
      this.landHit(owner, hitTarget, bulletDamage(bullet), bullet.spawnTick);
    }
    this.bullets = survivors;
  }

  /** A shot of `owner`'s, fired at `spawnTick`, takes `damage` off `target`. */
  private landHit(owner: Player, target: Player, damage: number, spawnTick: number): void {
    const dealt = target.id === WARLORD_ID ? Math.ceil(damage / WARLORD_ARMOUR) : damage;
    target.ship = damageShip(target.ship, dealt);
    this.stats.hits += 1;
    if (target.npc) {
      owner.score += NPC_SCORE.hit;
      this.gainXp(owner, XP.npcHit);
      provoke(target.npc, owner.id, this.tick);
    } else {
      owner.score += SCORE.pvpHit;
      this.gainXp(owner, XP.playerHit);
    }
    this.advanceMission(owner, 'hits');
    if (!owner.npc) target.damagedBy.set(owner.id, (target.damagedBy.get(owner.id) ?? 0) + dealt);
    this.listener.hit?.({ ownerId: owner.id, spawnTick, targetId: target.id, tick: this.tick });
    this.announce(
      {
        kind: 'hit',
        ownerId: owner.id,
        spawnTick,
        targetId: target.id,
        tick: this.tick,
        hp: target.ship.hp,
        shield: target.ship.shield,
      },
      target.ship.x,
      target.ship.y,
      target.ship.z,
      owner.id,
      target.id,
    );
    if (!target.ship.alive) {
      if (target.id === WARLORD_ID) {
        // A raid: everyone who damaged it shares in it, whoever fired last.
        let total = 0;
        for (const damage of target.damagedBy.values()) total += damage;
        for (const [id, damage] of target.damagedBy) {
          const raider = this.players.get(id);
          if (!raider) continue;
          raider.score += NPC_SCORE.warlordKill;
          this.gainXp(raider, XP.warlordKill);
          this.advanceMission(raider, 'warlord');
          const level = levelOf(raider.progress.xp);
          this.rollCrate(raider, 'boss', bossCrateChance(level, total > 0 ? damage / total : 0));
        }
      } else if (target.npc) {
        owner.score += NPC_SCORE.raiderKill;
        this.gainXp(owner, XP.raiderKill);
        this.advanceMission(owner, 'raiders');
        this.rollCrate(owner, 'raider', CRATE_CHANCE.raider);
      } else {
        // Kills are of players only: a title or a bounty must not be farmed from the server's ships.
        owner.kills += 1;
        owner.killsThisLife += 1;
        owner.score += killScore(target.ship.x, target.ship.z, owner.killMultTicks > 0);
        this.gainXp(owner, XP.playerKill);
      }
      this.recordDeath(target, owner, CAUSE_PLAYER);
    }
  }

  /** What shooting down a rock is worth. */
  private rewardRock(owner: Player): void {
    owner.score += asteroidScore(owner.asteroidMultTicks > 0);
    this.gainXp(owner, XP.asteroid);
    this.advanceMission(owner, 'rocks');
  }

  /**
   * Maybe drops a salvage crate for this pilot. Orbs and raiders stop paying
   * once the pilot has had the day's share; the boss always may.
   */
  private rollCrate(player: Player, source: CrateSource, chance: number): void {
    if (!this.crates || !player.pilotKey || player.npc) return;
    // Both numbers are drawn every time, so one pilot's cap never shifts another's luck.
    const hit = this.dropRng.next() < (this.crateOdds[source] ?? chance);
    const tier = crateTier(source, this.dropRng.next());
    if (!hit) return;
    if (source !== 'boss' && !this.crates.underCap(player.pilotKey)) return;
    this.crates.add(player.pilotKey, tier, source, levelOf(player.progress.xp));
    player.cratesTold = this.crates.count(player.pilotKey);
    player.outbox.push({
      kind: 'crate',
      tier: CRATE_TIERS.indexOf(tier),
      source: CRATE_SOURCES.indexOf(source),
      held: player.cratesTold,
    });
  }

  /** Tells each seated pilot whose hold has changed, by a claim, how many crates they hold now. */
  refreshCrates(): void {
    if (!this.crates) return;
    for (const player of this.players.values()) {
      if (!player.pilotKey || player.cratesTold < 0) continue;
      const held = this.crates.count(player.pilotKey);
      if (held === player.cratesTold) continue;
      player.cratesTold = held;
      player.outbox.push({ kind: 'crate', tier: NO_CRATE, source: NO_CRATE, held });
    }
  }

  /**
   * Whether this pilot key belongs to someone the room has seated, now or
   * (with a store) before. The fort is read only for pilots the game knows,
   * so nobody can make forts by inventing keys.
   */
  /** True while the pilot with this key has a ship in space. */
  flying(key: string): boolean {
    for (const player of this.players.values()) {
      if (player.pilotKey === key && player.ship.alive) return true;
    }
    return false;
  }

  knowsPilot(key: string): boolean {
    for (const player of this.players.values()) if (player.pilotKey === key) return true;
    return this.pilots?.load(key) !== undefined;
  }

  /** Whether a seated player is in the fort. */
  inFort(id: number): boolean {
    return this.players.get(id)?.inFort ?? false;
  }

  /** How many crates a seated player holds (0 without a store or a pilot key). */
  cratesOf(id: number): number {
    const key = this.players.get(id)?.pilotKey;
    return key && this.crates ? this.crates.count(key) : 0;
  }

  private gainXp(player: Player, amount: number): void {
    if (player.npc) return;
    player.progress.xp += amount;
    player.progressDue = true;
    player.saveDue = true;
  }

  /** Counts one toward the player's mission if it is of this kind, and pays it out when done. */
  private advanceMission(player: Player, kind: MissionKind): void {
    if (player.npc) return;
    const progress = player.progress;
    const mission = MISSIONS[progress.missionIndex];
    if (!mission || mission.kind !== kind) return;
    progress.missionProgress += 1;
    player.progressDue = true;
    player.saveDue = true;
    if (progress.missionProgress < mission.goal) return;
    progress.missionsDone += 1;
    progress.missionProgress = 0;
    progress.missionIndex = nextMissionIndex(progress.missionIndex, this.withNpcs);
    player.score += mission.points;
    this.gainXp(player, mission.xp);
  }

  /** The players' ships that the server's ships may attack. */
  private npcTargets(): NpcTarget[] {
    const targets: NpcTarget[] = [];
    for (const player of this.players.values()) {
      if (!player.npc && !player.away && player.ship.alive) targets.push(player);
    }
    return targets;
  }

  private savePilot(player: Player): void {
    if (!player.saveDue || !player.pilotKey || !this.pilots) return;
    player.saveDue = false;
    this.pilots.save(player.pilotKey, player.progress);
  }

  /**
   * Moves every homing shot one tick (decision D23). Each turns toward its
   * target where that ship really is now, not where its owner was seeing it:
   * the shot is the server's from the moment it leaves, and a dodge has to
   * count for the ship that makes it. It ends on the first ship or rock on
   * its path, or when its time is up.
   */
  private stepSeekers(): void {
    const survivors: Seeker[] = [];
    for (const before of this.seekers) {
      const owner = this.players.get(before.ownerId);
      if (!owner || seekerExpired(before, this.tick)) continue;
      const followed = before.targetId === null ? undefined : this.players.get(before.targetId);
      const seeker = stepSeeker(before, followed?.ship ?? null);
      const path = seekerPath(seeker, this.tick);

      const hitDistance = shipHitDistance(path);
      let hitTarget: Player | null = null;
      let hitAt = Infinity;
      for (const target of this.players.values()) {
        if (target === owner || !target.ship.alive || target.ship.invulnTicks > 0) continue;
        if (owner.npc && target.npc) continue;
        const ship = target.ship;
        const reach = hitDistance * hullScaleOf(target.id);
        const at = bulletHit(path, this.tick, ship.x, ship.y, ship.z, reach);
        if (at >= 0 && at < hitAt) {
          hitAt = at;
          hitTarget = target;
        }
      }
      const rock = bulletAsteroidHit(this.world.belt, this.ledger, path, this.tick);
      if (rock && rock.at < hitAt) {
        this.ledger.asteroids.remove(rock.id, this.tick);
        this.stats.asteroidsShot += 1;
        this.rewardRock(owner);
        this.broadcast({
          kind: 'asteroid',
          asteroidId: rock.id,
          tick: this.tick,
          playerId: owner.id,
          spawnTick: seeker.spawnTick,
          byBullet: true,
        });
        continue;
      }
      if (hitTarget) this.landHit(owner, hitTarget, bulletDamage(path), seeker.spawnTick);
      else survivors.push(seeker);
    }
    this.seekers = survivors;
  }

  private stepAwayAndRespawn(): void {
    for (const player of [...this.players.values()]) {
      if (player.npc) {
        this.respawnNpc(player, player.npc);
        continue;
      }
      if (this.tick % SAVE_EVERY_TICKS === 0) this.savePilot(player);
      const graceOver = player.away && this.tick - player.awaySinceTick >= AWAY_GRACE_TICKS;
      if (!player.away && !player.idle && player.unchangedTicks >= IDLE_TICKS) {
        player.idle = true;
        player.idleSinceTick = this.tick;
      }
      if ((graceOver || player.idle) && player.ship.alive) {
        player.ship = destroyShip(player.ship);
        this.recordDeath(player, null, CAUSE_DISCONNECT);
      }
      // Whoever comes back from being away with no ship comes back to the
      // fort, not into space with a ship they were not there to fly. That
      // holds however the ship went: the grace running out, a rock, a shot.
      if (graceOver && !player.ship.alive && !player.inFort) this.setFort(player, true);
      // Nobody keeps one of the sixteen seats for ever without playing.
      const outSince = player.away
        ? player.awaySinceTick
        : player.idle
          ? player.idleSinceTick
          : player.inFort
            ? player.fortSinceTick
            : -1;
      if (outSince >= 0 && this.tick - outSince >= SEAT_TICKS) {
        const connection = player.connection;
        const reason = player.inFort ? REJECT_FORT : REJECT_IDLE;
        this.remove(player);
        if (connection) {
          // Say why, so the client does not simply reconnect and take a seat again.
          this.send(connection, encodeReject(reason), 'reliable');
          connection.player = null;
          this.close(connection);
        }
        continue;
      }
      // A newcomer has waited long enough: the old connection has gone quiet.
      if (player.claim && this.tick - player.claim.atTick >= CLAIM_TICKS) this.takeSeat(player);
      // A "back" that came too soon after the last welcome is answered now.
      const due = player.backDue;
      if (due && this.tick - player.lastWelcomeTick >= WELCOME_EVERY_TICKS) {
        player.backDue = null;
        if (player.connection === due.connection && !due.connection.closed) {
          this.welcomeBack(player, due.connection, due.clientTimeMs);
        }
      }
      // A dead ship comes back after its timer, but not while its player is
      // away, idle or in the fort.
      if (
        !player.ship.alive &&
        player.ship.respawnTicks === 0 &&
        !player.away &&
        !player.idle &&
        !player.inFort
      ) {
        player.ship = spawnShip(this.rng, player.ship.spawnSeq + 1);
        player.killsThisLife = 0;
        player.spawnedAtTick = this.tick;
      }
    }
  }

  /** A ship of the server's that is down comes back when its time is up. */
  private respawnNpc(player: Player, brain: NpcBrain): void {
    if (player.ship.alive) return;
    if (this.tick < player.respawnAtTick) return;
    // At its patrol height, clear of the rocks, which it would otherwise climb through.
    const ship = { ...spawnShip(this.npcRng, player.ship.spawnSeq + 1), y: brain.orbitHeight };
    player.ship = brain.kind === 'warlord' ? { ...ship, shield: SIM.maxShield } : ship;
    player.spawnedAtTick = this.tick;
    player.damagedBy.clear();
    brain.provokedBy = null;
  }

  private recordDeath(victim: Player, killer: Player | null, cause: DeathCause): void {
    if (victim.npc) {
      victim.respawnAtTick =
        this.tick + (victim.npc.kind === 'warlord' ? WARLORD_RETURN_TICKS : RAIDER_RESPAWN_TICKS);
    }
    victim.damagedBy.clear();
    const deathId = this.nextDeathId++;
    this.stats.deaths += 1;
    this.listener.playerDied?.({
      deathId,
      victimId: victim.id,
      killerId: killer ? killer.id : null,
      cause,
      tick: this.tick,
      survivalTicks: this.tick - victim.spawnedAtTick,
      kills: victim.killsThisLife,
      score: victim.score,
    });
    const event: GameEvent = {
      kind: 'death',
      deathId,
      victimId: victim.id,
      killerId: killer ? killer.id : NO_PLAYER,
      cause,
      tick: this.tick,
    };
    this.broadcast(event);
  }

  /** Queues an event for every player. World state goes this way, wherever they are. */
  private broadcast(event: GameEvent): void {
    for (const player of this.players.values()) player.outbox.push(event);
  }

  /** Queues an event for everyone close enough to see it, and for those it concerns. */
  private announce(
    event: GameEvent,
    x: number,
    y: number,
    z: number,
    concernsA: number,
    concernsB: number,
  ): void {
    for (const player of this.players.values()) {
      if (
        player.id === concernsA ||
        player.id === concernsB ||
        distanceSq(player.ship, x, y, z) <= EVENT_RADIUS * EVENT_RADIUS
      ) {
        player.outbox.push(event);
      }
    }
  }

  private flushEvents(): void {
    for (const player of this.players.values()) {
      if (player.progressDue) {
        player.progressDue = false;
        player.outbox.push({ kind: 'progress', ...player.progress });
      }
      if (player.outbox.length === 0) continue;
      if (player.connection) {
        for (let start = 0; start < player.outbox.length; start += 255) {
          this.send(
            player.connection,
            encodeEvents(player.outbox.slice(start, start + 255)),
            'reliable',
          );
        }
      }
      player.outbox.length = 0;
    }
  }

  private sendSnapshots(): void {
    // Record what this snapshot says about every ship. Rewinding uses exactly
    // these samples, at exactly these ticks, because they are what clients drew.
    const samples = new Map<number, RemoteSample>();
    for (const player of this.players.values()) {
      const sample = sampleOf(this.tick, player.ship);
      samples.set(player.id, sample);
      player.track.push(sample);
      if (player.track.length > TRACK_LENGTH) player.track.shift();
    }

    const farDue = this.snapshotsSent % FAR_EVERY_SNAPSHOTS === 0;
    this.snapshotsSent += 1;

    for (const player of this.players.values()) {
      const connection = player.connection;
      if (!connection) continue;

      const remotes: RemoteEntry[] = [];
      for (const other of this.players.values()) {
        if (other === player) continue;
        const sample = samples.get(other.id);
        if (!sample) continue;
        const d2 = distanceSq(player.ship, other.ship.x, other.ship.y, other.ship.z);
        const limit = player.near.has(other.id) ? NEAR_RADIUS_EXIT : NEAR_RADIUS;
        if (d2 <= limit * limit) {
          player.near.add(other.id);
          remotes.push({ id: other.id, sample });
        } else {
          const wasNear = player.near.delete(other.id);
          // A ship that just left the near tier is sent once more at once, so
          // it does not vanish until the next scheduled distant update.
          if (farDue || player.fullStateDue || wasNear) {
            remotes.push({ id: other.id, sample: distantSampleOf(sample) });
          }
        }
      }
      player.fullStateDue = false;

      // Homing shots: its own, any aimed at it, and any near enough to see.
      const seekers: SeekerEntry[] = [];
      for (const seeker of this.seekers) {
        if (seekers.length === 255) break;
        if (
          seeker.ownerId === player.id ||
          seeker.targetId === player.id ||
          distanceSq(player.ship, seeker.x, seeker.y, seeker.z) <= NEAR_RADIUS * NEAR_RADIUS
        ) {
          seekers.push({
            ownerId: seeker.ownerId,
            targetId: seeker.targetId ?? NO_PLAYER,
            x: seeker.x,
            y: seeker.y,
            z: seeker.z,
          });
        }
      }

      this.send(
        connection,
        encodeSnapshot({
          serverTick: this.tick,
          inputLead: player.worstLead,
          missedInputs: player.missedSinceSnapshot,
          ship: player.ship,
          kills: player.kills,
          score: player.score,
          asteroidMultTicks: player.asteroidMultTicks,
          killMultTicks: player.killMultTicks,
          storeTicks: player.storeTicks,
          remotes,
          seekers,
        }),
        'droppable',
      );
      player.worstLead = Number.NaN;
      player.missedSinceSnapshot = 0;
    }
  }

  private sendScores(): void {
    const entries = [...this.players.values()]
      .filter((player) => !player.npc)
      .map((player) => ({
        playerId: player.id,
        score: player.score,
        kills: player.kills,
        level: levelOf(player.progress.xp),
      }));
    const message = encodeScores(entries);
    for (const player of this.players.values()) {
      if (player.connection) this.send(player.connection, message, 'droppable');
    }
  }

  // --- Messages in ----------------------------------------------------------

  private receive(connection: Connection, data: Uint8Array): void {
    if (connection.closed) return;
    const message = decodeClientMessage(data);
    if (!message) {
      this.malformed(connection);
      return;
    }
    if (message.type === 'hello') {
      if (connection.player || connection.claiming) this.malformed(connection);
      else this.join(connection, message);
      return;
    }
    const player = connection.player;
    if (!player) {
      this.malformed(connection);
      return;
    }
    if (message.type === 'input') {
      this.acceptInputs(player, message);
    } else if (message.type === 'buy') {
      if (!player.away) this.buy(player, message.item);
    } else if (message.type === 'fort') {
      // Only a pilot without a ship can go in: the fort is never a way out
      // of a fight. A refusal is said too, so the client's screen follows.
      if (message.held && player.ship.alive) player.outbox.push({ kind: 'fort', held: false });
      else this.setFort(player, message.held);
    } else if (message.away) {
      this.markAway(player);
    } else if (this.tick - player.lastWelcomeTick >= WELCOME_EVERY_TICKS) {
      this.welcomeBack(player, connection, message.clientTimeMs);
    } else {
      // A welcome carries the state of the whole world. One a second is
      // plenty; this one waits its turn.
      player.backDue = { connection, clientTimeMs: message.clientTimeMs };
    }
  }

  private join(connection: Connection, hello: HelloMessage): void {
    if (hello.protocolVersion !== PROTOCOL_VERSION || hello.simFingerprint !== SIM_FINGERPRINT) {
      this.send(connection, encodeReject(REJECT_VERSION), 'reliable');
      this.close(connection);
      return;
    }

    // A known token takes its seat back, whether the old socket has been
    // noticed as dead yet or not, unless someone is still flying with it.
    if (hello.sessionToken) {
      for (const player of this.players.values()) {
        if (player.npc || !sameToken(player.token, hello.sessionToken)) continue;
        const old = player.connection;
        const maybeInUse =
          old !== null &&
          !old.closed &&
          !player.away &&
          this.tick - player.lastInputAtTick < TOKEN_IN_USE_TICKS;
        if (maybeInUse) {
          // A second newcomer while one is already waiting is certainly not the holder.
          if (player.claim) break;
          player.claim = { connection, clientTimeMs: hello.clientTimeMs, atTick: this.tick };
          connection.claiming = true;
          return;
        }
        player.claim = { connection, clientTimeMs: hello.clientTimeMs, atTick: this.tick };
        this.takeSeat(player);
        return;
      }
    }
    this.seatNewPlayer(connection, hello.clientTimeMs, hello.pilotKey ?? null);
  }

  /** The newcomer waiting on this player's token is the player: the seat is theirs. */
  private takeSeat(player: Player): void {
    const claim = player.claim;
    if (!claim) return;
    player.claim = null;
    claim.connection.claiming = false;
    const old = player.connection;
    if (old && old !== claim.connection) {
      old.player = null;
      this.close(old);
    }
    if (!claim.connection.closed) this.welcomeBack(player, claim.connection, claim.clientTimeMs);
  }

  /** The holder of the token is still flying: the newcomer is someone else. */
  private refuseSeat(player: Player): void {
    const claim = player.claim;
    if (!claim) return;
    player.claim = null;
    claim.connection.claiming = false;
    // It holds the seat's token, so it is the same pilot in a second tab: it
    // starts from what that seat has earned, and the store keeps the further on.
    if (!claim.connection.closed) {
      this.savePilot(player);
      this.seatNewPlayer(claim.connection, claim.clientTimeMs, player.pilotKey);
    }
  }

  private seatNewPlayer(
    connection: Connection,
    clientTimeMs: number,
    pilotKey: Uint8Array | string | null,
  ): void {
    const id = this.freeId();
    if (id === null) {
      this.send(connection, encodeReject(REJECT_FULL), 'reliable');
      this.close(connection);
      return;
    }
    const token = this.createToken();
    if (token.byteLength !== SESSION_TOKEN_BYTES) throw new Error('session token must be 16 bytes');
    const key =
      pilotKey instanceof Uint8Array
        ? Array.from(pilotKey, (byte) => byte.toString(16).padStart(2, '0')).join('')
        : pilotKey;
    const player = this.newPlayer(id, token, null, key);
    this.players.set(id, player);
    this.listener.playerJoined?.(id, this.tick);
    this.welcomeBack(player, connection, clientTimeMs);
  }

  /** A seat with nothing done in it yet: a new player's, or one of the server's own ships'. */
  private newPlayer(
    id: number,
    token: Uint8Array,
    npc: NpcBrain | null,
    pilotKey: string | null = null,
  ): Player {
    const progress = { ...((pilotKey && this.pilots?.load(pilotKey)) || NEW_PROGRESS) };
    // A mission kept from a room that had the server's ships cannot be done in one without.
    if (!this.withNpcs && MISSIONS[progress.missionIndex]?.needsNpcs) {
      progress.missionIndex = nextMissionIndex(progress.missionIndex, false);
      progress.missionProgress = 0;
    }
    return {
      id,
      token,
      connection: null,
      ship: npc ? { ...spawnShip(this.npcRng, 0), y: npc.orbitHeight } : spawnShip(this.rng, 0),
      input: NEUTRAL_INPUT,
      pending: new Map(),
      firstInputTick: null,
      worstLead: Number.NaN,
      missedSinceSnapshot: 0,
      away: false,
      awaySinceTick: 0,
      unchangedTicks: 0,
      idle: false,
      idleSinceTick: 0,
      inFort: false,
      fortSinceTick: 0,
      lastWelcomeTick: 0,
      lastInputAtTick: -TOKEN_IN_USE_TICKS,
      claim: null,
      backDue: null,
      kills: 0,
      killsThisLife: 0,
      spawnedAtTick: this.tick,
      score: 0,
      asteroidMultTicks: 0,
      killMultTicks: 0,
      storeTicks: 0,
      lastFireTick: -SCORE.combatTicks,
      beltIncome: 0,
      near: new Set(),
      fullStateDue: true,
      track: [],
      outbox: [],
      scheduledOrbs: [],
      scheduledGrants: [],
      progress,
      progressDue: false,
      saveDue: false,
      pilotKey,
      beltTicks: 0,
      npc,
      respawnAtTick: 0,
      cratesTold: -1,
      damagedBy: new Map(),
    };
  }

  /**
   * Attaches a connection to a player and tells the client everything it
   * needs to start from scratch: the tick, its ship, the belt and which of
   * its rocks are gone, and every bullet in flight. Used for a first join, a
   * reconnect, and a tab coming back.
   */
  private welcomeBack(player: Player, connection: Connection, clientTimeMs: number): void {
    player.connection = connection;
    connection.player = player;
    player.away = false;
    player.idle = false;
    player.unchangedTicks = 0;
    player.lastWelcomeTick = this.tick;
    player.backDue = null;
    player.pending.clear();
    player.input = NEUTRAL_INPUT;
    player.firstInputTick = null;
    player.worstLead = Number.NaN;
    player.missedSinceSnapshot = 0;
    player.near.clear();
    player.fullStateDue = true;
    player.outbox.length = 0;

    this.send(
      connection,
      encodeWelcome({
        playerId: player.id,
        serverTick: this.tick,
        clientTimeMs,
        sessionToken: player.token,
        ship: player.ship,
        worldSeed: this.world.seed,
        asteroidCount: this.world.belt.asteroids.length,
        withOrbs: this.world.orbs.orbs.length > 0,
      }),
      'reliable',
    );
    for (const gone of this.ledger.orbs.goneAt(this.tick)) {
      // An orb this player shot, whose effect is still to come, is told in
      // full, so the client schedules it again.
      const own = player.scheduledOrbs.find((s) => s.orbId === gone.id);
      player.outbox.push({
        kind: 'orb',
        orbId: gone.id,
        tick: gone.tick,
        playerId: own ? player.id : NO_PLAYER,
        spawnTick: own ? own.spawnTick : 0,
        byBullet: own !== undefined,
      });
    }
    for (const grant of player.scheduledGrants) {
      player.outbox.push({ kind: 'grant', item: grant.item, applyTick: grant.applyTick });
    }
    player.progressDue = true;
    player.outbox.push({ kind: 'fort', held: player.inFort });
    if (this.crates && player.pilotKey) {
      player.cratesTold = this.crates.count(player.pilotKey);
      player.outbox.push({
        kind: 'crate',
        tier: NO_CRATE,
        source: NO_CRATE,
        held: player.cratesTold,
      });
    }
    for (const gone of this.ledger.asteroids.goneAt(this.tick)) {
      player.outbox.push({
        kind: 'asteroid',
        asteroidId: gone.id,
        tick: gone.tick,
        playerId: NO_PLAYER,
        spawnTick: 0,
        byBullet: false,
      });
    }
    for (const live of this.bullets) player.outbox.push(live.announcement);
    this.flushEvents();
  }

  /** Puts a player in the fort or lets them launch, and tells them. */
  private setFort(player: Player, held: boolean): void {
    if (player.inFort !== held) {
      player.inFort = held;
      player.fortSinceTick = this.tick;
      // Launching is a hand on the controls: a pilot taken out for idling
      // who then went through the fort flies again without touching the stick.
      player.unchangedTicks = 0;
      if (!held) player.idle = false;
    }
    player.outbox.push({ kind: 'fort', held });
  }

  private markAway(player: Player): void {
    if (player.away) return;
    player.away = true;
    player.awaySinceTick = this.tick;
    player.pending.clear();
  }

  private acceptInputs(player: Player, message: InputMessage): void {
    if (player.away) return;
    player.lastInputAtTick = this.tick;
    // Whoever holds this seat is still here, so a newcomer with a copy of
    // its token is a different player.
    if (player.claim) this.refuseSeat(player);
    // How long before its tick is due the newest input arrived, in ticks.
    const sinceTickDue = this.tickDueAtMs === null ? 0 : this.now() - this.tickDueAtMs;
    const lead = message.tick - this.tick - sinceTickDue / TICK_MS;
    if (!(player.worstLead <= lead)) player.worstLead = lead;
    if (message.tick <= this.tick) this.stats.lateInputs += 1;
    player.firstInputTick ??= message.tick;

    for (let i = 0; i < message.inputs.length; i++) {
      const tick = message.tick - i;
      const input = message.inputs[i];
      if (!input || tick <= this.tick || tick > this.tick + MAX_INPUT_LEAD_TICKS) continue;
      // One input per tick. The first copy to arrive wins.
      if (!player.pending.has(tick)) player.pending.set(tick, input);
    }
  }

  // --- Connections ----------------------------------------------------------

  private freeId(): number | null {
    // Seats are numbered from 0. The server's own ships have ids far above them.
    for (let id = 0; id < this.maxPlayers; id++) {
      if (!this.players.has(id)) return id;
    }
    return null;
  }

  private malformed(connection: Connection): void {
    connection.malformed += 1;
    this.stats.malformedMessages += 1;
    if (connection.malformed >= MAX_MALFORMED_MESSAGES) this.close(connection);
  }

  private send(connection: Connection, data: Uint8Array, channel: Channel): void {
    if (connection.closed) return;
    this.stats.bytesSent += data.byteLength;
    this.stats.messagesSent += 1;
    connection.transport.send(data, channel);
  }

  private close(connection: Connection): void {
    if (connection.closed) return;
    connection.transport.close();
    this.drop(connection);
  }

  /** The socket is gone. The player, if any, keeps the seat for SEAT_TICKS. */
  private drop(connection: Connection): void {
    connection.closed = true;
    this.connections.delete(connection);
    if (connection.claiming) {
      // A newcomer that left while waiting for a seat.
      for (const waitedOn of this.players.values()) {
        if (waitedOn.claim?.connection === connection) waitedOn.claim = null;
      }
    }
    const player = connection.player;
    if (!player || player.connection !== connection) return;
    player.connection = null;
    // The old page has gone: a newcomer waiting with its token is that player.
    if (player.claim) {
      this.takeSeat(player);
      return;
    }
    this.markAway(player);
    this.savePilot(player);
  }

  private remove(player: Player): void {
    this.savePilot(player);
    this.players.delete(player.id);
    this.bullets = this.bullets.filter((live) => live.bullet.ownerId !== player.id);
    this.seekers = this.seekers.filter((seeker) => seeker.ownerId !== player.id);
    this.listener.playerLeft?.(player.id, this.tick);
    for (const other of this.players.values()) {
      other.near.delete(player.id);
      other.outbox.push({ kind: 'left', playerId: player.id });
    }
  }
}
