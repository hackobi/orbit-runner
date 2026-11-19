// The role-playing layer: experience, levels, ranks, missions, and the ships
// the server flies itself. The server keeps all of it; nothing here is
// predicted, and none of it changes what a ship can do. Every player flies the
// same ship whatever their level (the user's direction of 2026-11-16).

/** Experience for each thing a pilot does. */
export const XP = {
  asteroid: 10,
  orb: 15,
  /** A shot landing on another player. */
  playerHit: 20,
  playerKill: 150,
  /** A shot landing on a raider or the Warlord. */
  npcHit: 5,
  raiderKill: 120,
  /** To every pilot who damaged the Warlord before it went down. */
  warlordKill: 600,
} as const;

/** Points for the same, where scoring.ts has no number already. */
export const NPC_SCORE = {
  hit: 50,
  raiderKill: 400,
  /** To every pilot who damaged the Warlord. */
  warlordKill: 3000,
} as const;

export const MAX_LEVEL = 50;

/** Experience needed to reach a level: 0, 100, 400, 900, … */
export function xpForLevel(level: number): number {
  const steps = Math.max(0, Math.min(level, MAX_LEVEL) - 1);
  return steps * steps * 100;
}

export function levelOf(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
  return level;
}

/** How far through the current level, 0 to 1. A pilot at the top level shows a full bar. */
export function levelProgress(xp: number): number {
  const level = levelOf(xp);
  if (level >= MAX_LEVEL) return 1;
  const from = xpForLevel(level);
  return (xp - from) / (xpForLevel(level + 1) - from);
}

const RANKS: readonly (readonly [number, string])[] = [
  [40, 'Legend'],
  [30, 'Admiral'],
  [20, 'Commander'],
  [15, 'Captain'],
  [10, 'Ace'],
  [6, 'Wingman'],
  [3, 'Pilot'],
  [1, 'Cadet'],
];

/** The title a level carries. It is a name only. */
export function rankOf(level: number): string {
  for (const [from, name] of RANKS) if (level >= from) return name;
  return 'Cadet';
}

// --- Missions ---------------------------------------------------------------

export type MissionKind =
  | 'rocks' // rocks shot down
  | 'orbs' // orbs taken, flown through or shot
  | 'hits' // shots landed on any ship
  | 'raiders' // raiders destroyed
  | 'belt' // seconds alive inside the belt
  | 'warlord'; // took part in destroying the Warlord

export interface Mission {
  readonly kind: MissionKind;
  readonly goal: number;
  readonly text: string;
  readonly xp: number;
  readonly points: number;
  /** True if it cannot be done in a room without server-flown ships. */
  readonly needsNpcs: boolean;
}

/** A pilot works through these in order, and then round again. */
export const MISSIONS: readonly Mission[] = [
  {
    kind: 'rocks',
    goal: 6,
    text: 'Shoot down 6 asteroids',
    xp: 120,
    points: 500,
    needsNpcs: false,
  },
  { kind: 'orbs', goal: 4, text: 'Take 4 orbs', xp: 150, points: 500, needsNpcs: false },
  { kind: 'raiders', goal: 1, text: 'Destroy a raider', xp: 250, points: 1000, needsNpcs: true },
  { kind: 'hits', goal: 8, text: 'Land 8 shots on ships', xp: 200, points: 800, needsNpcs: false },
  {
    kind: 'belt',
    goal: 60,
    text: 'Stay alive in the belt for 60 s',
    xp: 150,
    points: 500,
    needsNpcs: false,
  },
  { kind: 'raiders', goal: 3, text: 'Destroy 3 raiders', xp: 500, points: 2000, needsNpcs: true },
  {
    kind: 'rocks',
    goal: 15,
    text: 'Shoot down 15 asteroids',
    xp: 250,
    points: 1000,
    needsNpcs: false,
  },
  {
    kind: 'warlord',
    goal: 1,
    text: 'Help bring down the Warlord',
    xp: 800,
    points: 3000,
    needsNpcs: true,
  },
];

/** The mission after `index`, leaving out those this room cannot offer. */
export function nextMissionIndex(index: number, withNpcs: boolean): number {
  for (let step = 1; step <= MISSIONS.length; step++) {
    const next = (index + step) % MISSIONS.length;
    if (withNpcs || !MISSIONS[next]?.needsNpcs) return next;
  }
  return index;
}

/** What a pilot has earned. This is all that is kept between visits. */
export interface Progress {
  xp: number;
  missionIndex: number;
  missionProgress: number;
  missionsDone: number;
}

export const NEW_PROGRESS: Readonly<Progress> = {
  xp: 0,
  missionIndex: 0,
  missionProgress: 0,
  missionsDone: 0,
};

// --- Ships the server flies ---------------------------------------------------

/** Player ids are 0 to 15. The server's own ships sit well above them, under NO_PLAYER (255). */
export const WARLORD_ID = 200;
export const FIRST_RAIDER_ID = 201;
export const RAIDER_COUNT = 5;

export type NpcKind = 'raider' | 'warlord';

export function npcKindOf(id: number): NpcKind | null {
  if (id === WARLORD_ID) return 'warlord';
  if (id >= FIRST_RAIDER_ID && id < FIRST_RAIDER_ID + RAIDER_COUNT) return 'raider';
  return null;
}

/** The Warlord is a big ship: three times a saucer across, to draw and to hit. */
export const WARLORD_SCALE = 3;
/** Its armour: it loses a fifth of what a shot would take off a saucer. */
export const WARLORD_ARMOUR = 5;

/** How much bigger than a saucer a ship is, for drawing it and for hitting it. */
export function hullScaleOf(id: number): number {
  return id === WARLORD_ID ? WARLORD_SCALE : 1;
}

/** What a ship is called on screen. */
export function shipName(id: number, ownId: number): string {
  if (id === ownId) return 'You';
  const kind = npcKindOf(id);
  if (kind === 'warlord') return 'The Warlord';
  if (kind === 'raider') return `Raider ${id - FIRST_RAIDER_ID + 1}`;
  return `Player ${id + 1}`;
}
