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
  NO_PLAYER,
  PROTOCOL_VERSION,
  REJECT_FULL,
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
} from '../shared/protocol.ts';
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
import { SIM_FINGERPRINT } from '../shared/sim/fingerprint.ts';
import {
  NEUTRAL_INPUT,
  VIEW_DELAY_STEPS_PER_TICK,
  damageShip,
  destroyShip,
  firedThisTick,
  spawnShip,
} from '../shared/sim/ship.ts';
import type { Input, ShipState } from '../shared/sim/ship.ts';
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

/** Decision D6: how long a seat is held for a player who has gone away. */
export const AWAY_GRACE_TICKS = 600;

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

export interface DeathRecord {
  /** Unique for the life of the room, so a payout can never be made twice. */
  deathId: number;
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
}

interface LiveBullet {
  readonly bullet: Bullet;
  readonly announcement: BulletEvent;
}

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
  private readonly createToken: () => Uint8Array;
  private readonly maxPlayers: number;
  private readonly listener: RoomListener;
  private readonly onTick: ((tick: number, room: Room) => void) | undefined;
  private readonly onWork: ((durationMs: number, ticks: number) => void) | undefined;
  private readonly connections = new Set<Connection>();
  private readonly players = new Map<number, Player>();
  private bullets: LiveBullet[] = [];
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
  }

  get playerCount(): number {
    return this.players.size;
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

  isAway(playerId: number): boolean {
    return this.players.get(playerId)?.away ?? false;
  }

  playerIds(): number[] {
    return [...this.players.keys()];
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
    this.stepAwayAndRespawn();
    this.flushEvents();
    this.onTick?.(this.tick, this);
  }

  private stepShips(): void {
    const effects: WorldEffect[] = [];
    for (const player of this.players.values()) {
      let input: Input;
      if (player.away) {
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
      }
      if (firedThisTick(player.ship)) this.fire(player);
    }
  }

  /** What taking an orb is worth, and what it sets going, whether flown through or shot. */
  private rewardOrb(player: Player, orbId: number): void {
    const orb = this.world.orbs.orbs[orbId];
    if (!orb) return;
    player.score += orbScore(orb.kind, player.asteroidMultTicks > 0);
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

  private fire(player: Player): void {
    player.lastFireTick = this.tick;
    const ship = player.ship;
    const live: LiveBullet = {
      bullet: spawnBullet(player.id, this.tick, ship),
      announcement: {
        kind: 'bullet',
        ownerId: player.id,
        spawnTick: this.tick,
        x: ship.x,
        y: ship.y,
        z: ship.z,
        yaw: ship.yaw,
        pitch: ship.pitch,
        beam: ship.fenix,
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
        const seen = sampleTrack(target.track, viewTick, 0);
        // The shooter must have been looking at this life of the ship, alive
        // and unprotected.
        if (!seen?.alive || seen.invulnerable || seen.spawnSeq !== target.ship.spawnSeq) continue;
        const at = bulletHit(bullet, this.tick, seen.x, seen.y, seen.z, hitDistance);
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
        owner.score += asteroidScore(owner.asteroidMultTicks > 0);
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
      hitTarget.ship = damageShip(hitTarget.ship, bulletDamage(bullet));
      this.stats.hits += 1;
      owner.score += SCORE.pvpHit;
      this.listener.hit?.({
        ownerId: owner.id,
        spawnTick: bullet.spawnTick,
        targetId: hitTarget.id,
        tick: this.tick,
      });
      this.announce(
        {
          kind: 'hit',
          ownerId: owner.id,
          spawnTick: bullet.spawnTick,
          targetId: hitTarget.id,
          tick: this.tick,
          hp: hitTarget.ship.hp,
          shield: hitTarget.ship.shield,
        },
        hitTarget.ship.x,
        hitTarget.ship.y,
        hitTarget.ship.z,
        owner.id,
        hitTarget.id,
      );
      if (!hitTarget.ship.alive) {
        owner.kills += 1;
        owner.killsThisLife += 1;
        owner.score += killScore(hitTarget.ship.x, hitTarget.ship.z, owner.killMultTicks > 0);
        this.recordDeath(hitTarget, owner, CAUSE_PLAYER);
      }
    }
    this.bullets = survivors;
  }

  private stepAwayAndRespawn(): void {
    for (const player of [...this.players.values()]) {
      const graceOver = player.away && this.tick - player.awaySinceTick >= AWAY_GRACE_TICKS;
      if (graceOver && player.ship.alive) {
        player.ship = destroyShip(player.ship);
        this.recordDeath(player, null, CAUSE_DISCONNECT);
      }
      if (graceOver && !player.connection) {
        this.remove(player);
        continue;
      }
      // A dead ship comes back after its timer, but not while its player is away.
      if (!player.ship.alive && player.ship.respawnTicks === 0 && !player.away) {
        player.ship = spawnShip(this.rng, player.ship.spawnSeq + 1);
        player.killsThisLife = 0;
        player.spawnedAtTick = this.tick;
      }
    }
  }

  private recordDeath(victim: Player, killer: Player | null, cause: DeathCause): void {
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
        }),
        'droppable',
      );
      player.worstLead = Number.NaN;
      player.missedSinceSnapshot = 0;
    }
  }

  private sendScores(): void {
    const entries = [...this.players.values()].map((player) => ({
      playerId: player.id,
      score: player.score,
      kills: player.kills,
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
      if (connection.player) this.malformed(connection);
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
    } else if (message.away) {
      this.markAway(player);
    } else {
      this.welcomeBack(player, connection, message.clientTimeMs);
    }
  }

  private join(connection: Connection, hello: HelloMessage): void {
    if (hello.protocolVersion !== PROTOCOL_VERSION || hello.simFingerprint !== SIM_FINGERPRINT) {
      this.send(connection, encodeReject(REJECT_VERSION), 'reliable');
      this.close(connection);
      return;
    }

    // A known token takes its seat back, whether the old socket has been
    // noticed as dead yet or not.
    if (hello.sessionToken) {
      for (const player of this.players.values()) {
        if (!sameToken(player.token, hello.sessionToken)) continue;
        const old = player.connection;
        if (old && old !== connection) {
          old.player = null;
          this.close(old);
        }
        this.welcomeBack(player, connection, hello.clientTimeMs);
        return;
      }
    }

    const id = this.freeId();
    if (id === null) {
      this.send(connection, encodeReject(REJECT_FULL), 'reliable');
      this.close(connection);
      return;
    }
    const token = this.createToken();
    if (token.byteLength !== SESSION_TOKEN_BYTES) throw new Error('session token must be 16 bytes');
    const player: Player = {
      id,
      token,
      connection: null,
      ship: spawnShip(this.rng, 0),
      input: NEUTRAL_INPUT,
      pending: new Map(),
      firstInputTick: null,
      worstLead: Number.NaN,
      missedSinceSnapshot: 0,
      away: false,
      awaySinceTick: 0,
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
    };
    this.players.set(id, player);
    this.listener.playerJoined?.(id, this.tick);
    this.welcomeBack(player, connection, hello.clientTimeMs);
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

  private markAway(player: Player): void {
    if (player.away) return;
    player.away = true;
    player.awaySinceTick = this.tick;
    player.pending.clear();
  }

  private acceptInputs(player: Player, message: InputMessage): void {
    if (player.away) return;
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

  /** The socket is gone. The player, if any, stays for the grace period. */
  private drop(connection: Connection): void {
    connection.closed = true;
    this.connections.delete(connection);
    const player = connection.player;
    if (!player || player.connection !== connection) return;
    player.connection = null;
    this.markAway(player);
  }

  private remove(player: Player): void {
    this.players.delete(player.id);
    this.bullets = this.bullets.filter((live) => live.bullet.ownerId !== player.id);
    this.listener.playerLeft?.(player.id, this.tick);
    for (const other of this.players.values()) {
      other.near.delete(player.id);
      other.outbox.push({ kind: 'left', playerId: player.id });
    }
  }
}
