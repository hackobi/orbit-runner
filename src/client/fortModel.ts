// What the fort screen says, worked out from what the game and the fort
// report. No page and no network here, so every line can be tested.

import type { CrewMember, FortUnavailable } from '../shared/fort.ts';

/** mm:ss, or h:mm:ss past an hour. */
export function clockText(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const s = String(whole % 60).padStart(2, '0');
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The fort keeps its own clock. This turns one of its moments into "seconds
 * from now" here, from the fort's time when it was read and how long ago
 * that was on this machine's clock.
 */
export function secondsUntil(
  until: number,
  fortNowMs: number,
  readAtMs: number,
  nowMs: number,
): number {
  return (until - (fortNowMs + (nowMs - readAtMs))) / 1000;
}

export interface CrewLine {
  /** What the unit is doing, in words. */
  readonly text: string;
  /** True when the unit can be given something to do. */
  readonly free: boolean;
  /** True when its time is up and the fort should be read again. */
  readonly due: boolean;
}

const DOING: Record<Exclude<CrewMember['state'], 'ready'>, string> = {
  mission: 'On a mission',
  challenge: 'In a challenge',
  raid: 'On a raid',
  resting: 'Resting',
};

/** One crew member's status line. `secondsLeft` is null when the fort gave no end time. */
export function crewLine(member: CrewMember, secondsLeft: number | null): CrewLine {
  if (member.state === 'ready') return { text: 'Ready', free: true, due: false };
  const what = DOING[member.state];
  if (secondsLeft === null) return { text: what, free: false, due: false };
  if (secondsLeft <= 0) {
    return {
      text: member.state === 'resting' ? 'Ready any moment' : 'Due back',
      free: false,
      due: true,
    };
  }
  const when =
    member.state === 'resting' ? `ready in ${clockText(secondsLeft)}` : clockText(secondsLeft);
  return { text: `${what} · ${when}`, free: false, due: false };
}

/** What one life in the cockpit earned. */
export interface Sortie {
  readonly seconds: number;
  readonly points: number;
  readonly kills: number;
  readonly xp: number;
  readonly crates: number;
}

/** The pilot's running totals, as the game reports them each frame. */
export interface Totals {
  readonly score: number;
  readonly kills: number;
  readonly xp: number;
  /** Crates won, ever, on this connection. */
  readonly crateDrops: number;
}

/**
 * Watches a ship's life and says what it earned when it ends. A sortie runs
 * from the ship appearing to its being lost.
 */
export class SortieTracker {
  /** The sortie that ended last, or null if none has ended since the page opened. */
  last: Sortie | null = null;
  private alive = false;
  private startedAtMs = 0;
  private from: Totals | null = null;

  update(alive: boolean, totals: Totals, nowMs: number): void {
    if (alive && !this.alive) {
      this.startedAtMs = nowMs;
      this.from = totals;
    } else if (!alive && this.alive && this.from) {
      const from = this.from;
      this.last = {
        seconds: (nowMs - this.startedAtMs) / 1000,
        // Totals only go down when a seat is new. A sortie never reports less than nothing.
        points: Math.max(0, totals.score - from.score),
        kills: Math.max(0, totals.kills - from.kills),
        xp: Math.max(0, totals.xp - from.xp),
        crates: Math.max(0, totals.crateDrops - from.crateDrops),
      };
    }
    this.alive = alive;
  }
}

export interface DebriefLine {
  readonly label: string;
  readonly value: string;
  /** True for what the sortie brought in, so it can be picked out. */
  readonly gain: boolean;
}

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`;

/** The debrief card for a sortie: what it earned, line by line. */
export function debriefLines(sortie: Sortie): DebriefLine[] {
  return [
    { label: 'Flown', value: clockText(sortie.seconds), gain: false },
    {
      label: 'Points',
      value: `+${sortie.points.toLocaleString('en-US')}`,
      gain: sortie.points > 0,
    },
    { label: 'Experience', value: `+${sortie.xp.toLocaleString('en-US')}`, gain: sortie.xp > 0 },
    { label: 'Kills', value: String(sortie.kills), gain: sortie.kills > 0 },
    {
      label: 'Salvage',
      value: sortie.crates > 0 ? plural(sortie.crates, 'crate') : 'none',
      gain: sortie.crates > 0,
    },
  ];
}

/** Why the fort's own panels are empty, in words. */
export function unavailableText(reason: FortUnavailable): string {
  switch (reason) {
    case 'off':
      return 'This server has no fort connected. Your sortie report is still yours to read.';
    case 'unreachable':
      return 'The fort is not answering. Trying again.';
    case 'no-pilot':
      return 'This browser keeps no pilot, so there is no fort to open. Allow site storage to have one.';
  }
}

/**
 * Whether the fort screen should be open, from what the player asked for and
 * what the server says. The player's own press shows at once; the server can
 * also put a pilot in the fort (their ship was lost while they were away),
 * and a flying ship always closes it.
 */
export interface FortGate {
  /** The screen is showing. */
  readonly open: boolean;
  /** The player pressed Launch and is waiting for a ship. */
  readonly launching: boolean;
}

export interface FortFacts {
  /** The game is connected and running. */
  readonly playing: boolean;
  readonly shipAlive: boolean;
  /** The server says this pilot is in the fort. */
  readonly held: boolean;
}

/** One frame of the gate. */
export function stepFortGate(gate: FortGate, facts: FortFacts): FortGate {
  // A ship in space: the pilot is flying, whatever was asked.
  if (facts.playing && facts.shipAlive) return { open: false, launching: false };
  if (gate.launching) return gate;
  // Put there by the server, or still there after a reload.
  if (facts.playing && facts.held && !gate.open) return { open: true, launching: false };
  return gate;
}

/** The player asks to go in. Only a pilot without a ship can. */
export function askFort(gate: FortGate, facts: FortFacts): FortGate {
  if (gate.open || !facts.playing || facts.shipAlive) return gate;
  return { open: true, launching: false };
}

/** The player presses Launch. */
export function askLaunch(gate: FortGate): FortGate {
  return gate.open ? { open: false, launching: true } : gate;
}
