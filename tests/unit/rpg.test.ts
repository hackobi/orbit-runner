import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SIM, TICK_MS } from '../../src/shared/constants.ts';
import { CAUSE_PLAYER, NO_CRATE } from '../../src/shared/protocol.ts';
import { DAILY_CRATE_CAP } from '../../src/shared/drops.ts';
import {
  FIRST_RAIDER_ID,
  MAX_LEVEL,
  MISSIONS,
  NPC_SCORE,
  RAIDER_COUNT,
  WARLORD_ID,
  XP,
  levelOf,
  levelProgress,
  nextMissionIndex,
  npcKindOf,
  rankOf,
  shipName,
  xpForLevel,
} from '../../src/shared/progress.ts';
import { orbScore } from '../../src/shared/scoring.ts';
import { asteroidPosition } from '../../src/shared/sim/belt.ts';
import type { OrbKind } from '../../src/shared/sim/orbs.ts';
import type { ShipState } from '../../src/shared/sim/ship.ts';
import { hunter, wanderer } from '../../src/net/behaviours.ts';
import type { Behaviour } from '../../src/net/behaviours.ts';
import {
  RAIDER_RESPAWN_TICKS,
  WARLORD_FIRST_TICKS,
  WARLORD_RETURN_TICKS,
} from '../../src/server/npc.ts';
import { MemoryCrateStore } from '../../src/server/crates.ts';
import { FilePilotStore, MemoryPilotStore } from '../../src/server/pilots.ts';
import { TestWorld } from '../support/harness.ts';

const STILL: Partial<ShipState> = {
  y: 0,
  pitch: 0,
  roll: 0,
  speed: 0,
  targetSpeed: 0,
  invulnTicks: 0,
  hp: SIM.maxHp,
};

const KEY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const KEY_HEX = '0102030405060708090a0b0c0d0e0f10';

describe('levels, ranks and the order of missions', () => {
  it('a level costs 100 more than the one before: 100, 400, 900', () => {
    expect([1, 2, 3, 4].map(xpForLevel)).toEqual([0, 100, 400, 900]);
    expect(levelOf(0)).toBe(1);
    expect(levelOf(99)).toBe(1);
    expect(levelOf(100)).toBe(2);
    expect(levelOf(399)).toBe(2);
    expect(levelOf(400)).toBe(3);
    expect(levelProgress(250)).toBeCloseTo(0.5);
  });

  it('levels stop at 50, where the bar is full', () => {
    expect(levelOf(xpForLevel(MAX_LEVEL))).toBe(MAX_LEVEL);
    expect(levelOf(0xffffffff)).toBe(MAX_LEVEL);
    expect(levelProgress(0xffffffff)).toBe(1);
  });

  it('ranks are names for levels', () => {
    expect([1, 2, 3, 6, 10, 15, 20, 30, 40, 50].map(rankOf)).toEqual([
      'Cadet',
      'Cadet',
      'Pilot',
      'Wingman',
      'Ace',
      'Captain',
      'Commander',
      'Admiral',
      'Legend',
      'Legend',
    ]);
  });

  it('missions go round in order, and a room without server ships leaves theirs out', () => {
    expect(nextMissionIndex(0, true)).toBe(1);
    expect(nextMissionIndex(MISSIONS.length - 1, true)).toBe(0);
    expect(MISSIONS[2]?.needsNpcs).toBe(true);
    expect(nextMissionIndex(1, false)).toBe(3);
    expect(nextMissionIndex(6, false)).toBe(0);
  });

  it('ids 200 to 205 are the server ships, and have names', () => {
    expect(npcKindOf(WARLORD_ID)).toBe('warlord');
    expect(npcKindOf(FIRST_RAIDER_ID)).toBe('raider');
    expect(npcKindOf(FIRST_RAIDER_ID + RAIDER_COUNT)).toBeNull();
    expect(npcKindOf(15)).toBeNull();
    expect(shipName(WARLORD_ID, 0)).toBe('The Warlock');
    expect(shipName(FIRST_RAIDER_ID + 1, 0)).toBe('Raider 2');
    expect(shipName(3, 0)).toBe('Player 4');
    expect(shipName(0, 0)).toBe('You');
  });
});

/** An orb of a kind with nothing else near it just now. */
function loneOrb(world: TestWorld, kind: OrbKind): number {
  const orbs = world.room.world.orbs.orbs;
  const rocks = world.room.world.belt.asteroids;
  for (const [id, orb] of orbs.entries()) {
    if (orb.kind !== kind) continue;
    const crowded =
      orbs.some(
        (other, otherId) =>
          otherId !== id && Math.hypot(other.x - orb.x, other.y - orb.y, other.z - orb.z) < 100,
      ) ||
      rocks.some((rock) => {
        const p = asteroidPosition(rock, world.room.tick);
        return Math.hypot(p.x - orb.x, p.z - orb.z) < 300;
      });
    if (!crowded) return id;
  }
  throw new Error(`no lone ${kind} orb`);
}

const OUTSIDE_THE_BELT = { ...STILL, x: 0, y: 400, z: 7000, speed: 5, targetSpeed: 5 };
const OVER_THE_BELT = { ...STILL, x: 0, y: 400, z: 4400, speed: 5, targetSpeed: 5 };

describe('experience and missions on the server', () => {
  it('a new pilot starts at nothing, on the first mission, and is told so', () => {
    const world = new TestWorld(31, 150);
    const pilot = world.addClient({});
    world.run(1500);
    expect(world.room.progressOf(pilot.core.playerId)).toEqual({
      xp: 0,
      missionIndex: 0,
      missionProgress: 0,
      missionsDone: 0,
    });
    expect(pilot.core.progress).toEqual(world.room.progressOf(pilot.core.playerId));
  });

  it('an orb is 15 experience; the fourth finishes the orb mission, which pays and moves on', () => {
    const pilots = new MemoryPilotStore();
    pilots.save(KEY_HEX, { xp: 90, missionIndex: 1, missionProgress: 3, missionsDone: 1 });
    const world = new TestWorld(31, 150, true, { pilots });
    const pilot = world.addClient({ pilotKey: KEY });
    world.run(1500);
    const id = pilot.core.playerId;
    world.place(id, OUTSIDE_THE_BELT);
    world.run(200);
    expect(pilot.core.progress).toMatchObject({ xp: 90, missionIndex: 1, missionProgress: 3 });
    world.room.addScore(id, -world.room.scoreOf(id));

    const orb = world.room.world.orbs.orbs[loneOrb(world, 'shield')];
    if (!orb) throw new Error('no orb');
    world.place(id, { ...STILL, x: orb.x, y: orb.y, z: orb.z - 20, speed: 20, targetSpeed: 20 });
    world.run(1500);
    world.place(id, OUTSIDE_THE_BELT);
    world.run(300);

    const mission = MISSIONS[1];
    if (!mission) throw new Error('no mission');
    // This room has no server ships, so the raider mission that follows is left out.
    expect(world.room.progressOf(id)).toEqual({
      xp: 90 + XP.orb + mission.xp,
      missionIndex: 3,
      missionProgress: 0,
      missionsDone: 2,
    });
    expect(pilot.core.progress).toEqual(world.room.progressOf(id));
    const score = world.room.scoreOf(id);
    const paid = orbScore('shield', false) + mission.points;
    expect(score).toBeGreaterThanOrEqual(paid);
    expect(score).toBeLessThan(paid + 10);
    world.run(1000);
    expect(pilot.core.scoreboard.find((entry) => entry.playerId === id)?.level).toBe(2);
  });

  it('a second alive in the belt counts toward the belt mission', () => {
    const pilots = new MemoryPilotStore();
    pilots.save(KEY_HEX, { xp: 0, missionIndex: 4, missionProgress: 58, missionsDone: 4 });
    const world = new TestWorld(31, 150, false, { pilots });
    const pilot = world.addClient({ pilotKey: KEY });
    world.run(500);
    const id = pilot.core.playerId;
    world.place(id, OUTSIDE_THE_BELT);
    world.run(3000);
    expect(world.room.progressOf(id)?.missionsDone).toBe(4);
    world.place(id, OVER_THE_BELT);
    world.run(2500);
    expect(world.room.progressOf(id)).toMatchObject({ missionsDone: 5, xp: MISSIONS[4]?.xp });
  });

  it('a hit on a player is 20 and a kill 150 more', () => {
    const world = new TestWorld(4, SIM.asteroidCount, false);
    const victim = world.addClient({});
    const shooter = world.addClient({ controls: hunter() });
    world.run(600);
    world.place(shooter.core.playerId, { ...STILL, x: 0, y: 300, z: 4000 });
    world.place(victim.core.playerId, { ...STILL, x: 0, y: 300, z: 4200 });
    world.clock.every(TICK_MS, () => {
      if (world.deaths.length > 0) world.place(shooter.core.playerId, { fireCooldown: 250 });
    });
    world.run(8000);
    expect(world.deaths).toHaveLength(1);
    expect(world.room.progressOf(shooter.core.playerId)?.xp).toBe(7 * XP.playerHit + XP.playerKill);
    expect(world.room.progressOf(victim.core.playerId)?.xp).toBe(0);
    expect(shooter.core.progress?.xp).toBe(7 * XP.playerHit + XP.playerKill);
  });
});

describe('a pilot keeps their progress between visits', () => {
  it('leaving saves it, and the same key in a new seat carries on from it', () => {
    const pilots = new MemoryPilotStore();
    const world = new TestWorld(31, 150, true, { pilots });
    const first = world.addClient({ pilotKey: KEY });
    world.run(1500);
    const id = first.core.playerId;
    const orb = world.room.world.orbs.orbs[loneOrb(world, 'shield')];
    if (!orb) throw new Error('no orb');
    world.place(id, { ...STILL, x: orb.x, y: orb.y, z: orb.z - 20, speed: 20, targetSpeed: 20 });
    world.run(1500);
    expect(pilots.load(KEY_HEX)).toBeUndefined();
    first.transport.close();
    world.run(100);
    expect(pilots.load(KEY_HEX)).toMatchObject({ xp: XP.orb });

    // A new tab has no session token, so it gets a new seat. The key is what it carries.
    const second = world.addClient({ pilotKey: KEY });
    world.run(500);
    expect(second.core.playerId).not.toBe(id);
    expect(second.core.progress).toMatchObject({ xp: XP.orb });
    // A visitor without a key starts from nothing, and nothing is kept for them.
    const visitor = world.addClient({});
    world.run(500);
    expect(visitor.core.progress).toMatchObject({ xp: 0 });
  });

  it('the store keeps the further on of two saves under one key', () => {
    const pilots = new MemoryPilotStore();
    pilots.save(KEY_HEX, { xp: 500, missionIndex: 3, missionProgress: 2, missionsDone: 3 });
    pilots.save(KEY_HEX, { xp: 200, missionIndex: 1, missionProgress: 0, missionsDone: 1 });
    expect(pilots.load(KEY_HEX)).toMatchObject({ xp: 500, missionIndex: 3 });
  });

  it('the file store writes a file a new server reads back, and refuses one it cannot read', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'orbit-pilots-'));
    try {
      const store = new FilePilotStore(directory);
      store.save(KEY_HEX, { xp: 700, missionIndex: 5, missionProgress: 1, missionsDone: 5 });
      store.flush();
      const file = path.join(directory, 'pilots.json');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        [KEY_HEX]: { xp: 700, missionIndex: 5, missionProgress: 1, missionsDone: 5 },
      });
      expect(new FilePilotStore(directory).load(KEY_HEX)).toMatchObject({ xp: 700 });

      writeFileSync(file, JSON.stringify({ [KEY_HEX]: { xp: -1 } }));
      expect(() => new FilePilotStore(directory)).toThrow(/not a pilot/);
      writeFileSync(file, 'not json');
      expect(() => new FilePilotStore(directory)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/** Empty space with the server's ships in it: no rocks to run into, no orbs to take. */
function raidWorld(seed = 9): TestWorld {
  return new TestWorld(seed, 0, false, { npcs: true });
}

/** Keeps a player's ship whole, so a fight lasts as long as the test needs. */
function sustain(world: TestWorld, playerId: number): void {
  world.clock.every(TICK_MS, () => {
    world.room.placeShip(playerId, (ship) =>
      ship.alive ? { ...ship, hp: SIM.maxHp, energy: SIM.maxEnergy } : ship,
    );
  });
}

/** A hunter that sees one ship only. */
function hunterOf(targetId: number): Behaviour {
  const hunt = hunter();
  return (tick, core) =>
    hunt(
      tick,
      new Proxy(core, {
        get: (target, property) =>
          property === 'remoteViews'
            ? () => target.remoteViews().filter((view) => view.id === targetId)
            : (Reflect.get(target, property, target) as unknown),
      }),
    );
}

describe('the ships the server flies', () => {
  it('a player in a room with them is predicted as in any other: no corrections', () => {
    const world = raidWorld();
    const pilot = world.addClient({ controls: wanderer(5, true) });
    world.run(20_000);
    expect(pilot.core.remoteViews().length).toBe(1 + RAIDER_COUNT);
    expect(world.hits).toHaveLength(0);
    expect(pilot.corrections).toHaveLength(0);
  });

  it('five raiders fly from the start and take no seat; the Warlord is not there yet', () => {
    const world = raidWorld();
    world.run(1000);
    expect(world.room.npcIds()).toHaveLength(1 + RAIDER_COUNT);
    expect(world.room.playerCount).toBe(0);
    expect(world.room.playerIds()).toEqual([]);
    expect(world.room.shipOf(WARLORD_ID)?.alive).toBe(false);
    for (let i = 0; i < RAIDER_COUNT; i++) {
      expect(world.room.shipOf(FIRST_RAIDER_ID + i)?.alive).toBe(true);
    }
    const pilot = world.addClient({});
    world.run(500);
    expect(pilot.core.playerId).toBe(0);
    expect(world.room.playerCount).toBe(1);
    // Sixteen people still fit beside them.
    for (let i = 0; i < 15; i++) world.addClient({});
    world.run(500);
    expect(world.room.playerCount).toBe(16);
  });

  it('left alone for two minutes, every raider is still patrolling the belt', () => {
    const world = raidWorld();
    world.run(120_000);
    expect(world.deaths).toHaveLength(0);
    for (let i = 0; i < RAIDER_COUNT; i++) {
      const ship = world.room.shipOf(FIRST_RAIDER_ID + i);
      if (!ship) throw new Error('no raider');
      const radius = Math.hypot(ship.x, ship.z);
      expect(ship.alive).toBe(true);
      expect(radius).toBeGreaterThan(SIM.beltInner - 100);
      expect(radius).toBeLessThan(SIM.beltOuter + 100);
      // Clear of the rocks, which lie within 60 of the plane.
      expect(Math.abs(ship.y)).toBeGreaterThan(60);
      expect(Math.abs(ship.y)).toBeLessThan(200);
    }
  });

  it('a raider attacks a ship that comes close, and the victim is told who shot them down', () => {
    const world = raidWorld();
    const pilot = world.addClient({});
    world.run(1000);
    const raider = world.room.shipOf(FIRST_RAIDER_ID);
    if (!raider) throw new Error('no raider');
    world.place(pilot.core.playerId, { ...STILL, x: raider.x, y: raider.y, z: raider.z + 300 });
    world.run(40_000);
    const hits = world.hits.filter((hit) => hit.targetId === pilot.core.playerId);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => npcKindOf(hit.ownerId) === 'raider')).toBe(true);
    const death = world.deaths.find((d) => d.victimId === pilot.core.playerId);
    expect(death).toMatchObject({ cause: CAUSE_PLAYER });
    expect(npcKindOf(death?.killerId ?? -1)).toBe('raider');
    expect(pilot.events.some((e) => e.kind === 'death' && e.victimId === pilot.core.playerId)).toBe(
      true,
    );
  });

  it('a raider leaves a ship alone that is away', () => {
    const world = raidWorld();
    const pilot = world.addSession({});
    world.run(1000);
    const id = pilot.session.core.playerId;
    const raider = world.room.shipOf(FIRST_RAIDER_ID);
    if (!raider) throw new Error('no raider');
    pilot.session.setHidden(true);
    world.run(200);
    world.place(id, { ...STILL, x: raider.x, y: raider.y, z: raider.z + 300 });
    world.run(8000);
    expect(world.room.isAway(id)).toBe(true);
    expect(world.hits).toHaveLength(0);
  });

  it('destroying a raider pays experience and points but is not a kill; it is back 15 s later', () => {
    const world = raidWorld();
    const pilot = world.addClient({ controls: hunter() });
    world.run(1000);
    const id = pilot.core.playerId;
    sustain(world, id);
    const raider = world.room.shipOf(FIRST_RAIDER_ID);
    if (!raider) throw new Error('no raider');
    world.place(id, { ...STILL, x: raider.x, y: raider.y, z: raider.z - 200 });
    world.room.addScore(id, -world.room.scoreOf(id));
    let downAtTick = -1;
    let backAtTick = -1;
    let hitsOnIt = 0;
    world.clock.every(TICK_MS, () => {
      const down = world.deaths[0]?.victimId;
      if (downAtTick >= 0 && backAtTick < 0 && down !== undefined) {
        if (world.room.shipOf(down)?.alive) backAtTick = world.room.tick;
      }
      if (downAtTick < 0 && world.deaths.length > 0) {
        downAtTick = world.room.tick;
        hitsOnIt = world.hits.filter((hit) => hit.ownerId === id).length;
        // Hold fire from here, so the count stands.
        world.clock.every(TICK_MS, () => {
          world.place(id, { fireCooldown: 250 });
        });
      }
    });
    world.run(60_000);

    const death = world.deaths[0];
    expect(death).toMatchObject({ killerId: id, cause: CAUSE_PLAYER });
    expect(npcKindOf(death?.victimId ?? -1)).toBe('raider');
    expect(hitsOnIt).toBeGreaterThanOrEqual(7);
    expect(world.room.progressOf(id)?.xp).toBe(hitsOnIt * XP.npcHit + XP.raiderKill);
    const score = world.room.scoreOf(id);
    const paid = hitsOnIt * NPC_SCORE.hit + NPC_SCORE.raiderKill;
    expect(score).toBeGreaterThanOrEqual(paid);
    expect(score).toBeLessThan(paid + 150);
    expect(world.room.killsOf(id)).toBe(0);
    // The shooter saw its shots land on its own screen, as on a player.
    expect(pilot.viewHits.length).toBeGreaterThan(0);

    expect(backAtTick - downAtTick).toBeGreaterThanOrEqual(RAIDER_RESPAWN_TICKS);
    expect(backAtTick - downAtTick).toBeLessThan(RAIDER_RESPAWN_TICKS + 3);
  });

  it('the Warlord arrives after 45 s with a full shield, and a shot takes a fifth off it', () => {
    const world = raidWorld();
    const pilot = world.addClient({ controls: hunter() });
    world.run((WARLORD_FIRST_TICKS - 60) * TICK_MS);
    expect(world.room.shipOf(WARLORD_ID)?.alive).toBe(false);
    world.run(120 * TICK_MS);
    const warlord = world.room.shipOf(WARLORD_ID);
    expect(warlord).toMatchObject({ alive: true, hp: SIM.maxHp, shield: SIM.maxShield });
    if (!warlord) throw new Error('no Warlord');

    const id = pilot.core.playerId;
    sustain(world, id);
    world.place(id, { ...STILL, x: warlord.x, y: warlord.y, z: warlord.z - 250 });
    world.run(15_000);
    const first = pilot.events.find((e) => e.kind === 'hit' && e.targetId === WARLORD_ID);
    expect(first).toMatchObject({ hp: SIM.maxHp, shield: SIM.maxShield - 3 });
  });

  it('a raid: everyone who damaged the Warlord is paid when it falls, and it returns 4 minutes on', () => {
    const world = raidWorld();
    const pilots = [
      world.addClient({ controls: hunterOf(WARLORD_ID) }),
      world.addClient({ controls: hunterOf(WARLORD_ID) }),
    ];
    world.run((WARLORD_FIRST_TICKS + 60) * TICK_MS);
    const warlord = world.room.shipOf(WARLORD_ID);
    if (!warlord) throw new Error('no Warlord');
    pilots.forEach((pilot, i) => {
      const id = pilot.core.playerId;
      sustain(world, id);
      world.place(id, {
        ...STILL,
        x: warlord.x + (i === 0 ? -40 : 40),
        y: warlord.y,
        z: warlord.z - 250,
      });
    });
    let downAtTick = -1;
    world.clock.every(TICK_MS, () => {
      if (downAtTick < 0 && world.deaths.some((d) => d.victimId === WARLORD_ID)) {
        downAtTick = world.room.tick;
      }
    });
    world.run(120_000);
    expect(downAtTick).toBeGreaterThan(0);
    for (const pilot of pilots) {
      const id = pilot.core.playerId;
      expect(world.hits.some((hit) => hit.ownerId === id && hit.targetId === WARLORD_ID)).toBe(
        true,
      );
      expect(world.room.progressOf(id)?.xp).toBeGreaterThanOrEqual(XP.warlordKill);
      expect(world.room.scoreOf(id)).toBeGreaterThanOrEqual(NPC_SCORE.warlordKill);
      expect(world.room.killsOf(id)).toBe(0);
    }
    world.run(Math.max(0, downAtTick + WARLORD_RETURN_TICKS - world.room.tick - 30) * TICK_MS);
    expect(world.room.shipOf(WARLORD_ID)?.alive).toBe(false);
    world.run(60 * TICK_MS);
    expect(world.room.shipOf(WARLORD_ID)?.alive).toBe(true);
  });
});

describe('salvage crates', () => {
  /** Flies the pilot through one lone orb and back out. */
  function takeOrb(world: TestWorld, id: number): void {
    const orb = world.room.world.orbs.orbs[loneOrb(world, 'shield')];
    if (!orb) throw new Error('no orb');
    world.place(id, { ...STILL, x: orb.x, y: orb.y, z: orb.z - 20, speed: 20, targetSpeed: 20 });
    world.run(1500);
    world.place(id, OUTSIDE_THE_BELT);
    world.run(300);
  }

  it('an orb that drops one tells the pilot alone, and the hold counts it', () => {
    const crates = new MemoryCrateStore();
    const world = new TestWorld(31, 150, true, { crates, crateOdds: { orb: 1 } });
    const pilot = world.addClient({ pilotKey: KEY });
    const other = world.addClient({});
    world.run(1500);
    const id = pilot.core.playerId;
    world.place(other.core.playerId, OUTSIDE_THE_BELT);
    world.place(id, OUTSIDE_THE_BELT);
    world.run(200);
    expect(pilot.events.filter((e) => e.kind === 'crate')).toEqual([
      { kind: 'crate', tier: NO_CRATE, source: NO_CRATE, held: 0 },
    ]);

    takeOrb(world, id);

    expect(crates.pending(KEY_HEX)).toHaveLength(1);
    expect(crates.pending(KEY_HEX)[0]).toMatchObject({ source: 'orb', level: 1 });
    expect(pilot.core.crates).toBe(1);
    expect(pilot.core.crateDrops).toHaveLength(1);
    expect(pilot.core.crateDrops[0]?.source).toBe(0);
    expect(world.room.cratesOf(id)).toBe(1);
    expect(other.events.some((e) => e.kind === 'crate')).toBe(false);
  });

  it('a pilot still flying sees the count fall when the crates are claimed', () => {
    const crates = new MemoryCrateStore();
    crates.add(KEY_HEX, 'Rare', 'boss', 5);
    crates.add(KEY_HEX, 'Common', 'orb', 5);
    const world = new TestWorld(31, 150, true, { crates });
    const pilot = world.addClient({ pilotKey: KEY });
    world.run(1500);
    expect(pilot.core.crates).toBe(2);
    expect(crates.redeem(crates.issueCode(KEY_HEX)?.code ?? '')?.crates).toHaveLength(2);
    world.room.refreshCrates();
    world.run(500);
    expect(pilot.core.crates).toBe(0);
    expect(pilot.core.crateDrops).toHaveLength(0);
  });

  it('at the real odds an orb almost never drops one, and a pilot without a key never', () => {
    const crates = new MemoryCrateStore();
    const world = new TestWorld(31, 150, true, { crates });
    const pilot = world.addClient({ pilotKey: KEY });
    world.run(1500);
    takeOrb(world, pilot.core.playerId);
    expect(crates.count(KEY_HEX)).toBe(0);

    const sure = new TestWorld(31, 150, true, { crates, crateOdds: { orb: 1 } });
    const visitor = sure.addClient({});
    sure.run(1500);
    takeOrb(sure, visitor.core.playerId);
    expect(visitor.events.some((e) => e.kind === 'crate')).toBe(false);
    expect(visitor.core.crates).toBe(0);
  });

  it('orbs stop paying at the daily cap, and a returning pilot is told what they hold', () => {
    const crates = new MemoryCrateStore();
    for (let i = 0; i < DAILY_CRATE_CAP; i++) crates.add(KEY_HEX, 'Common', 'orb', 1);
    const world = new TestWorld(31, 150, true, { crates, crateOdds: { orb: 1 } });
    const pilot = world.addClient({ pilotKey: KEY });
    world.run(1500);
    expect(pilot.core.crates).toBe(DAILY_CRATE_CAP);
    takeOrb(world, pilot.core.playerId);
    expect(crates.count(KEY_HEX)).toBe(DAILY_CRATE_CAP);
    expect(pilot.core.crateDrops).toHaveLength(0);
  });

  it('the pilot who destroys a raider may win one', () => {
    const crates = new MemoryCrateStore();
    const world = new TestWorld(9, 0, false, { npcs: true, crates, crateOdds: { raider: 1 } });
    const pilot = world.addClient({ controls: hunter(), pilotKey: KEY });
    world.run(1000);
    const id = pilot.core.playerId;
    sustain(world, id);
    const raider = world.room.shipOf(FIRST_RAIDER_ID);
    if (!raider) throw new Error('no raider');
    world.place(id, { ...STILL, x: raider.x, y: raider.y, z: raider.z - 200 });
    world.clock.every(TICK_MS, () => {
      if (world.deaths.length > 0) world.place(id, { fireCooldown: 250 });
    });
    world.run(60_000);
    expect(world.deaths[0]).toMatchObject({ killerId: id });
    expect(crates.pending(KEY_HEX)).toHaveLength(1);
    expect(crates.pending(KEY_HEX)[0]?.source).toBe('raider');
  });

  it('when the boss falls, every pilot who damaged it rolls, each for themselves', () => {
    const crates = new MemoryCrateStore();
    const world = new TestWorld(9, 0, false, { npcs: true, crates, crateOdds: { boss: 1 } });
    const keys = [KEY, Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)];
    const pilots = keys.map((pilotKey) =>
      world.addClient({ controls: hunterOf(WARLORD_ID), pilotKey }),
    );
    const bystander = world.addClient({ pilotKey: Uint8Array.from({ length: 16 }, () => 0x77) });
    world.run((WARLORD_FIRST_TICKS + 60) * TICK_MS);
    const warlord = world.room.shipOf(WARLORD_ID);
    if (!warlord) throw new Error('no boss');
    world.place(bystander.core.playerId, OUTSIDE_THE_BELT);
    pilots.forEach((pilot, i) => {
      sustain(world, pilot.core.playerId);
      world.place(pilot.core.playerId, {
        ...STILL,
        x: warlord.x + (i === 0 ? -40 : 40),
        y: warlord.y,
        z: warlord.z - 250,
      });
    });
    world.clock.every(TICK_MS, () => {
      sustain(world, bystander.core.playerId);
    });
    world.run(120_000);
    expect(world.deaths.some((d) => d.victimId === WARLORD_ID)).toBe(true);
    expect(crates.pending(KEY_HEX).map((c) => c.source)).toEqual(['boss']);
    expect(crates.pending('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf').map((c) => c.source)).toEqual([
      'boss',
    ]);
    expect(crates.count('77'.repeat(16))).toBe(0);
  });

  it('a room with drops flies exactly as one without', () => {
    const fly = (extra: ConstructorParameters<typeof TestWorld>[3]): string => {
      const world = new TestWorld(31, 150, true, extra);
      const pilot = world.addClient({ pilotKey: KEY });
      world.run(1500);
      const id = pilot.core.playerId;
      takeOrb(world, id);
      world.run(5000);
      return JSON.stringify([
        world.room.shipOf(id),
        world.room.scoreOf(id),
        world.room.progressOf(id),
        pilot.core.counters.corrections,
      ]);
    };
    const crates = new MemoryCrateStore();
    expect(fly({ crates, crateOdds: { orb: 1 } })).toBe(fly({}));
    expect(crates.count(KEY_HEX)).toBe(1);
  });
});
