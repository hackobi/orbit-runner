// What the fort screen says, worked out from what the game and the fort
// report. No page and no network here, so every line can be tested.

import type {
  CrewMember,
  FortItem,
  FortJob,
  FortReport,
  FortUnavailable,
  FortView,
  GearSlot,
} from '../shared/fort.ts';

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

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`;

/** PRIMARY_WEAPON reads as "primary weapon". */
export const plainWords = (name: string): string => name.toLowerCase().replaceAll('_', ' ');

/**
 * What a crew member could put in a slot: items in the hold made for it, worn
 * by nobody, that this member may wear. The strongest comes first.
 */
export function gearChoices(fort: FortView, member: CrewMember, slot: GearSlot): FortItem[] {
  return fort.hold.items
    .filter((item) => item.slot === slot && item.wornBy === null && item.fits.includes(member.id))
    .sort((one, other) => other.bonus - one.bonus);
}

export interface JobChoice {
  readonly job: FortJob;
  /** What it takes and gives, in words. */
  readonly line: string;
  /** Why this member cannot be sent just now, or '' when they can. */
  readonly blocked: string;
}

/** The jobs a crew member may take, shortest first, each with its terms in words. */
export function jobChoices(fort: FortView, member: CrewMember): JobChoice[] {
  return fort.jobs
    .filter((job) => job.open.includes(member.id))
    .sort((one, other) => one.lasts - other.lasts)
    .map((job) => {
      const pays = [
        job.pays.credits > 0 ? `${job.pays.credits} credits` : '',
        job.pays.upgradePoints > 0 ? plural(job.pays.upgradePoints, 'upgrade point') : '',
        job.pays.experience > 0 ? `${job.pays.experience} experience` : '',
      ].filter(Boolean);
      const terms = [
        `${Math.max(1, Math.round(job.lasts / 60_000))} min`,
        // A job can fail, and one that goes well pays a little under or over this.
        pays.length > 0 ? `about ${pays.join(', ')} if it succeeds` : '',
        job.cost > 0 ? `costs ${job.cost} credits` : '',
      ].filter(Boolean);
      return {
        job,
        line: terms.join(' · '),
        blocked: job.cost > fort.currencies.credits ? 'Not enough credits' : '',
      };
    });
}

/** How far a crew member is into their level, in words and as a part of the whole (0 to 1). */
export function levelLine(member: CrewMember): { readonly text: string; readonly part: number } {
  if (member.nextLevel <= 0) return { text: `level ${member.level}`, part: 1 };
  return {
    text: `level ${member.level} · ${Math.floor(member.experience)} / ${member.nextLevel} to level ${member.level + 1}`,
    part: Math.min(1, member.experience / member.nextLevel),
  };
}

export interface BunkOffer {
  /** What a recruit for the next empty bunk costs, in words. */
  readonly line: string;
  /** Why no recruit can be taken on just now, or '' when one can. */
  readonly blocked: string;
}

/**
 * The next empty bunk: what it costs and what stands in the way. Two things
 * fill a bunk: the pilot's level, earned flying, opens it, and credits, earned
 * by the crew, pay for it. Null when every bunk is taken.
 */
export function bunkOffer(fort: FortView, pilotLevel: number | null): BunkOffer | null {
  const next = fort.bunks[0];
  if (!next) return null;
  const credits = fort.currencies.credits;
  const line = `A recruit costs ${next.price.toLocaleString('en-US')} credits`;
  if (pilotLevel === null || pilotLevel < next.level) {
    return {
      line,
      blocked:
        `Opens at pilot level ${next.level}` +
        (pilotLevel === null ? '' : `: you are level ${pilotLevel}. Fly to raise it.`),
    };
  }
  if (credits < next.price) {
    return {
      line,
      blocked: `${Math.ceil(next.price - credits).toLocaleString('en-US')} credits short. Crew earn them on jobs.`,
    };
  }
  return { line, blocked: '' };
}

/** What is waiting for the pilot in the fort. */
export interface Waiting {
  /** How many things there are to do there. */
  readonly count: number;
  /** The first of them, as the button that goes there says it. 'Fort' when there is nothing. */
  readonly call: string;
}

/**
 * What a pilot would find to do in their fort right now: crates to open
 * (in the hold, or still aboard the ship), crew with skill points to spend,
 * a bunk they can fill, and word from the crew that came while they flew.
 */
export function waitingIn(
  fort: FortView | null,
  cratesAboard: number,
  pilotLevel: number | null,
  news: number,
): Waiting {
  if (!fort) return { count: 0, call: 'Fort' };
  const crates = fort.hold.crates.length + cratesAboard;
  const learners = fort.crew.filter((member) => member.points > 0);
  const bunk = bunkOffer(fort, pilotLevel)?.blocked === '';
  const count = crates + learners.length + (bunk ? 1 : 0) + news;
  const first = learners[0];
  const call =
    crates > 0
      ? crates === 1
        ? 'Open your crate'
        : `Open your ${crates} crates`
      : first
        ? `${first.name} has ${plural(first.points, 'point')} to spend`
        : bunk
          ? 'Take on a recruit'
          : news > 0
            ? 'Hear from your crew'
            : 'Fort';
  return { count, call };
}

/**
 * Remembers which of the fort's reports have been seen, so that one arriving
 * while the pilot is flying can be told once. The reports there at the first
 * look are old news.
 */
export class ReportWatch {
  private seen: Set<string> | null = null;

  /** Takes the fort's reports as they stand and returns the ones not seen before, oldest first. */
  take(reports: readonly FortReport[]): FortReport[] {
    const first = this.seen === null;
    const seen = (this.seen ??= new Set());
    const fresh = reports.filter((report) => !seen.has(report.id));
    for (const report of fresh) seen.add(report.id);
    return first ? [] : fresh.reverse();
  }
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
  /**
   * The ship is held back while the death screen offers the fort or a launch.
   * It happens once, the first time a pilot dies with something waiting.
   */
  readonly choosing: boolean;
}

const FLYING: FortGate = { open: false, launching: false, choosing: false };

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
  if (facts.playing && facts.shipAlive) return FLYING;
  if (gate.launching || gate.choosing) return gate;
  // Put there by the server, or still there after a reload.
  if (facts.playing && facts.held && !gate.open) return { ...FLYING, open: true };
  return gate;
}

/** The player asks to go in. Only a pilot without a ship can. */
export function askFort(gate: FortGate, facts: FortFacts): FortGate {
  if (gate.open || !facts.playing || facts.shipAlive) return gate;
  return { ...FLYING, open: true };
}

/** The player presses Launch. */
export function askLaunch(gate: FortGate): FortGate {
  return gate.open || gate.choosing ? { ...FLYING, launching: true } : gate;
}

/**
 * The ship has just been lost. The first time that happens with something
 * waiting in the fort, the ship is held back and the pilot is asked.
 */
export function askChoice(gate: FortGate, facts: FortFacts): FortGate {
  if (gate.open || gate.launching || !facts.playing || facts.shipAlive) return gate;
  return { ...FLYING, choosing: true };
}
