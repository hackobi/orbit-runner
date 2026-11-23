// The fort as the game shows it: a pilot's crew, hold and currencies, read
// from SpaceFort's server by this game's server and passed to the page.
// Everything that crosses that boundary is checked here, so the page can
// trust what it is given.

export type CrewState = 'ready' | 'mission' | 'challenge' | 'raid' | 'resting';
const CREW_STATES: readonly CrewState[] = ['ready', 'mission', 'challenge', 'raid', 'resting'];

export const GEAR_SLOTS = [
  'PRIMARY_WEAPON',
  'SECONDARY_WEAPON',
  'ARMOR_SYSTEM',
  'UTILITY_MODULE',
] as const;
export type GearSlot = (typeof GEAR_SLOTS)[number];

export const SKILLS = [
  'PILOTING',
  'COMBAT',
  'ENGINEERING',
  'NAVIGATION',
  'TACTICAL',
  'MINING',
  'DIPLOMACY',
  'SENSORS',
] as const;
export type Skill = (typeof SKILLS)[number];

export interface CrewMember {
  readonly id: string;
  readonly name: string;
  readonly className: string;
  readonly level: number;
  /** Experience into this level, and what the next level takes. */
  readonly experience: number;
  readonly nextLevel: number;
  readonly state: CrewState;
  /** When what they are doing ends, in the fort's clock (ms). Null when nothing says. */
  readonly until: number | null;
  readonly doing: string | null;
  /** Skill points waiting to be spent. */
  readonly points: number;
  readonly skills: readonly { readonly name: Skill; readonly value: number }[];
  /** Every slot, worn or empty. */
  readonly gear: readonly {
    readonly slot: GearSlot;
    readonly item: { readonly id: string; readonly name: string; readonly rarity: string } | null;
  }[];
}

export interface FortCrate {
  readonly id: string;
  readonly tier: string;
  readonly source: string;
}

export interface FortItem {
  readonly id: string;
  readonly name: string;
  readonly rarity: string;
  readonly slot: string | null;
  /** Its bonuses added up: one number to compare two items by. */
  readonly bonus: number;
  /** The crew member wearing it, or null. */
  readonly wornBy: string | null;
  /** The crew members who may wear it. */
  readonly fits: readonly string[];
}

/** A job a crew member can be sent on. */
export interface FortJob {
  readonly id: string;
  readonly title: string;
  readonly rarity: string;
  /** How long the crew member is away (ms). */
  readonly lasts: number;
  /** Credits it costs to send someone. */
  readonly cost: number;
  readonly pays: {
    readonly credits: number;
    readonly upgradePoints: number;
    readonly experience: number;
  };
  /** The crew members who may take it. */
  readonly open: readonly string[];
}

/** An empty bunk: what a recruit for it costs, and the pilot level that opens it. */
export interface FortBunk {
  readonly price: number;
  readonly level: number;
}

/** How much of a day's limit has been used. */
export interface DayCount {
  readonly today: number;
  readonly cap: number;
}

/** What flying has paid the fort today, and who rides along. */
export interface FortFlight {
  /** The crew member on board the ship, or null. They learn as the pilot flies and take no jobs. */
  readonly aboard: string | null;
  /** Upgrade points flying has paid today. */
  readonly upgradePoints: DayCount;
  /** Experience the crew member on board has learned today. */
  readonly experience: DayCount;
}

/** Something a crew member asks the pilot to do in flight, for credits. */
export interface FortOffer {
  readonly id: string;
  /** The crew member who asks. */
  readonly from: string;
  readonly text: string;
  readonly goal: number;
  readonly credits: number;
}

/** The contract the pilot has taken. */
export interface FortContract extends FortOffer {
  readonly progress: number;
}

/** The once-a-day reward. */
export interface FortDaily {
  /** True when it can be taken now. */
  readonly ready: boolean;
  /** When it can next be taken, in the fort's clock (ms). Null if never taken. */
  readonly nextAt: number | null;
  /** The day of the streak the next reward is for. */
  readonly streak: number;
  readonly credits: number;
  readonly upgradePoints: number;
}

export interface FortReport {
  readonly id: string;
  readonly at: number;
  readonly title: string;
  readonly detail: string | null;
}

export interface FortView {
  /** The fort's clock when this was read (ms). `until` and `at` are on the same clock. */
  readonly now: number;
  readonly currencies: {
    readonly credits: number;
    readonly upgradePoints: number;
    readonly renown: number;
  };
  readonly crew: readonly CrewMember[];
  readonly hold: {
    readonly crates: readonly FortCrate[];
    readonly itemCount: number;
    readonly items: readonly FortItem[];
  };
  /** The bunks still empty, the next to fill first. */
  readonly bunks: readonly FortBunk[];
  readonly flight: FortFlight;
  /** The contract taken, or null. One at a time. */
  readonly contract: FortContract | null;
  /** The contracts the crew ask for today and that are not taken or done. */
  readonly offers: readonly FortOffer[];
  readonly daily: FortDaily;
  readonly jobs: readonly FortJob[];
  readonly reports: readonly FortReport[];
}

/** Something a pilot tells the fort to do. */
export type FortOrder =
  | { readonly kind: 'open'; readonly crateId: string }
  | { readonly kind: 'equip'; readonly unitId: string; readonly itemId: string }
  | { readonly kind: 'unequip'; readonly unitId: string; readonly slot: GearSlot }
  | { readonly kind: 'send'; readonly unitId: string; readonly jobId: string }
  | {
      readonly kind: 'train';
      readonly unitId: string;
      readonly skill: Skill;
      readonly points: number;
    }
  /** Spend all of a crew member's skill points the way the fort thinks best. */
  | { readonly kind: 'trainAll'; readonly unitId: string }
  /** Take on a recruit for the next empty bunk. */
  | { readonly kind: 'recruit' }
  /** Put a crew member on board the ship, or nobody. */
  | { readonly kind: 'board'; readonly unitId: string | null }
  /** Take a contract a crew member asks for. */
  | { readonly kind: 'contract'; readonly offerId: string }
  /** Take the once-a-day reward. */
  | { readonly kind: 'claim' };

/** How an order went: whether it was done, and what the fort said about it. */
export interface FortDone {
  readonly ok: boolean;
  readonly message: string;
}

export type FortOrderReply =
  | { readonly ok: true; readonly fort: FortView; readonly done: FortDone }
  | { readonly ok: false; readonly reason: FortUnavailable };

/** Why there is no fort to show. */
export type FortUnavailable =
  /** This server has no fort behind it. */
  | 'off'
  /** The fort did not answer. */
  | 'unreachable'
  /** This browser keeps no pilot, or the server does not know the pilot. */
  | 'no-pilot';

export type FortReply =
  | { readonly ok: true; readonly fort: FortView }
  | { readonly ok: false; readonly reason: FortUnavailable };

type Fields = Record<string, unknown>;

const fields = (value: unknown): Fields | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
/** Words for a person to read: any length is taken, and cut to fit. */
const words = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
const optionalWords = (value: unknown, max: number): string | null | undefined =>
  value === null || value === undefined || value === '' ? null : (words(value, max) ?? undefined);

/**
 * The entries of a list that `one` can read, or null if it is not a list.
 * An entry that cannot be read is left out and counted, so that one odd
 * report does not cost the pilot the sight of their whole fort.
 */
function list<T>(
  value: unknown,
  max: number,
  one: (entry: unknown) => T | null,
  left: { out: number },
): T[] | null {
  if (!Array.isArray(value)) return null;
  const read: T[] = [];
  for (const entry of value.slice(0, max)) {
    const item = one(entry);
    if (item === null) left.out += 1;
    else read.push(item);
  }
  left.out += Math.max(0, value.length - max);
  return read;
}

function crewMember(value: unknown): CrewMember | null {
  const f = fields(value);
  if (!f) return null;
  const id = text(f.id, 80);
  const name = words(f.name, 120);
  const className = words(f.className, 60);
  const level = count(f.level);
  const experience = count(f.experience);
  const nextLevel = count(f.nextLevel);
  const state = CREW_STATES.find((known) => known === f.state);
  const until = f.until === null ? null : count(f.until);
  const doing = optionalWords(f.doing, 200);
  const points = count(f.points);
  const left = { out: 0 };
  const skills = list(
    f.skills,
    SKILLS.length,
    (entry) => {
      const skill = fields(entry);
      const known = SKILLS.find((one) => one === skill?.name);
      const value = count(skill?.value);
      return known && value !== null ? { name: known, value } : null;
    },
    left,
  );
  const gear = list(
    f.gear,
    GEAR_SLOTS.length,
    (entry) => {
      const place = fields(entry);
      const slot = GEAR_SLOTS.find((one) => one === place?.slot);
      if (!slot) return null;
      if (place?.item === null) return { slot, item: null };
      const worn = fields(place?.item);
      const wornId = text(worn?.id, 80);
      const wornName = words(worn?.name, 120);
      const rarity = text(worn?.rarity, 20);
      return wornId !== null && wornName !== null && rarity !== null
        ? { slot, item: { id: wornId, name: wornName, rarity } }
        : null;
    },
    left,
  );
  if (id === null || name === null || className === null || level === null) return null;
  if (experience === null || nextLevel === null || !state) return null;
  if (f.until !== null && until === null) return null;
  if (doing === undefined) return null;
  // A crew member is shown whole or not at all: half their gear would mislead.
  if (points === null || !skills || !gear || left.out > 0) return null;
  return {
    id,
    name,
    className,
    level,
    experience,
    nextLevel,
    state,
    until,
    doing,
    points,
    skills,
    gear,
  };
}

function crate(value: unknown): FortCrate | null {
  const f = fields(value);
  const id = text(f?.id, 80);
  const tier = text(f?.tier, 20);
  const source = text(f?.source, 20);
  return id !== null && tier !== null && source !== null ? { id, tier, source } : null;
}

function item(value: unknown): FortItem | null {
  const f = fields(value);
  const id = text(f?.id, 80);
  const name = words(f?.name, 120);
  const rarity = text(f?.rarity, 20);
  const slot = optionalWords(f?.slot, 40);
  const bonus = count(f?.bonus);
  const wornBy = f?.wornBy === null ? null : text(f?.wornBy, 80);
  const left = { out: 0 };
  const fits = list(f?.fits, 200, (entry) => text(entry, 80), left);
  if (id === null || name === null || rarity === null || slot === undefined) return null;
  if (bonus === null || (f?.wornBy !== null && wornBy === null)) return null;
  if (!fits || left.out > 0) return null;
  return { id, name, rarity, slot, bonus, wornBy, fits };
}

function job(value: unknown): FortJob | null {
  const f = fields(value);
  const pays = fields(f?.pays);
  const id = text(f?.id, 80);
  const title = words(f?.title, 200);
  const rarity = text(f?.rarity, 20);
  const lasts = count(f?.lasts);
  const cost = count(f?.cost);
  const credits = count(pays?.credits);
  const upgradePoints = count(pays?.upgradePoints);
  const experience = count(pays?.experience);
  const left = { out: 0 };
  const open = list(f?.open, 200, (entry) => text(entry, 80), left);
  if (id === null || title === null || rarity === null) return null;
  if (lasts === null || cost === null) return null;
  if (credits === null || upgradePoints === null || experience === null) return null;
  if (!open || left.out > 0) return null;
  return { id, title, rarity, lasts, cost, pays: { credits, upgradePoints, experience }, open };
}

function bunk(value: unknown): FortBunk | null {
  const f = fields(value);
  const price = count(f?.price);
  const level = count(f?.level);
  return price !== null && level !== null ? { price, level } : null;
}

function dayCount(value: unknown): DayCount | null {
  const f = fields(value);
  const today = count(f?.today);
  const cap = count(f?.cap);
  return today !== null && cap !== null ? { today, cap } : null;
}

function flight(value: unknown): FortFlight | null {
  const f = fields(value);
  const aboard = f?.aboard === null ? null : text(f?.aboard, 80);
  const upgradePoints = dayCount(f?.upgradePoints);
  const experience = dayCount(f?.experience);
  if (!f || (f.aboard !== null && aboard === null)) return null;
  return upgradePoints && experience ? { aboard, upgradePoints, experience } : null;
}

function offer(value: unknown): FortOffer | null {
  const f = fields(value);
  const id = text(f?.id, 120);
  const from = words(f?.from, 120);
  const what = words(f?.text, 200);
  const goal = count(f?.goal);
  const credits = count(f?.credits);
  return id !== null && from !== null && what !== null && goal !== null && credits !== null
    ? { id, from, text: what, goal, credits }
    : null;
}

function contract(value: unknown): FortContract | null {
  const taken = offer(value);
  const progress = count(fields(value)?.progress);
  return taken && progress !== null ? { ...taken, progress } : null;
}

function daily(value: unknown): FortDaily | null {
  const f = fields(value);
  const nextAt = f?.nextAt === null ? null : count(f?.nextAt);
  const streak = count(f?.streak);
  const credits = count(f?.credits);
  const upgradePoints = count(f?.upgradePoints);
  if (!f || typeof f.ready !== 'boolean' || (f.nextAt !== null && nextAt === null)) return null;
  return streak !== null && credits !== null && upgradePoints !== null
    ? { ready: f.ready, nextAt, streak, credits, upgradePoints }
    : null;
}

function report(value: unknown): FortReport | null {
  const f = fields(value);
  const id = text(f?.id, 80);
  const at = count(f?.at);
  const title = words(f?.title, 200);
  const detail = optionalWords(f?.detail, 400);
  return id !== null && at !== null && title !== null && detail !== undefined
    ? { id, at, title, detail }
    : null;
}

/**
 * A fort as SpaceFort's server sends it, checked. Null if it is not a fort at
 * all. Entries of its lists that cannot be read are left out, and `onLeftOut`
 * is told how many, so whoever asked can say so.
 */
export function parseFortView(
  value: unknown,
  onLeftOut?: (entries: number) => void,
): FortView | null {
  const f = fields(value);
  const currencies = fields(f?.currencies);
  const hold = fields(f?.hold);
  if (!f || !currencies || !hold) return null;
  const now = count(f.now);
  const credits = count(currencies.credits);
  const upgradePoints = count(currencies.upgradePoints);
  const renown = count(currencies.renown);
  const left = { out: 0 };
  const crew = list(f.crew, 200, crewMember, left);
  const crates = list(hold.crates, 2000, crate, left);
  const itemCount = count(hold.itemCount);
  const items = list(hold.items, 200, item, left);
  const bunks = list(f.bunks, 20, bunk, left);
  const flying = flight(f.flight);
  const taken = f.contract === null ? null : contract(f.contract);
  const offers = list(f.offers, 20, offer, left);
  const reward = daily(f.daily);
  const jobs = list(f.jobs, 50, job, left);
  const reports = list(f.reports, 50, report, left);
  if (now === null || credits === null || upgradePoints === null || renown === null) return null;
  if (itemCount === null) return null;
  if (!crew || !crates || !items || !bunks || !jobs || !reports) return null;
  if (!flying || !offers || !reward || (f.contract !== null && !taken)) return null;
  if (left.out > 0) onLeftOut?.(left.out);
  return {
    now,
    currencies: { credits, upgradePoints, renown },
    crew,
    hold: { crates, itemCount, items },
    bunks,
    flight: flying,
    contract: taken,
    offers,
    daily: reward,
    jobs,
    reports,
  };
}

/**
 * An order as a page sends it, checked. Null for anything that is not one of
 * the orders there are, so nothing else is ever passed on to the fort.
 */
export function parseFortOrder(value: unknown): FortOrder | null {
  const f = fields(value);
  if (!f) return null;
  const unitId = text(f.unitId, 80);
  switch (f.kind) {
    case 'open': {
      const crateId = text(f.crateId, 80);
      return crateId !== null ? { kind: 'open', crateId } : null;
    }
    case 'equip': {
      const itemId = text(f.itemId, 80);
      return unitId !== null && itemId !== null ? { kind: 'equip', unitId, itemId } : null;
    }
    case 'unequip': {
      const slot = GEAR_SLOTS.find((one) => one === f.slot);
      return unitId !== null && slot ? { kind: 'unequip', unitId, slot } : null;
    }
    case 'send': {
      const jobId = text(f.jobId, 80);
      return unitId !== null && jobId !== null ? { kind: 'send', unitId, jobId } : null;
    }
    case 'train': {
      const skill = SKILLS.find((one) => one === f.skill);
      const points = count(f.points);
      if (unitId === null || !skill || points === null) return null;
      if (!Number.isInteger(points) || points < 1 || points > 100) return null;
      return { kind: 'train', unitId, skill, points };
    }
    case 'trainAll':
      return unitId !== null ? { kind: 'trainAll', unitId } : null;
    case 'recruit':
      // Nothing else is taken from the page: what a recruit costs and whether
      // the pilot may have one are for the two servers to say.
      return { kind: 'recruit' };
    case 'board':
      if (f.unitId === null) return { kind: 'board', unitId: null };
      return unitId !== null ? { kind: 'board', unitId } : null;
    case 'contract': {
      const offerId = text(f.offerId, 120);
      return offerId !== null ? { kind: 'contract', offerId } : null;
    }
    case 'claim':
      return { kind: 'claim' };
    default:
      return null;
  }
}

/** How SpaceFort says an order went, checked. */
export function parseFortDone(value: unknown): FortDone | null {
  const f = fields(value);
  if (!f || typeof f.ok !== 'boolean') return null;
  return { ok: f.ok, message: words(f.message, 300) ?? '' };
}

/** The reply of this game's own /api/fort/order, checked. Null for anything else. */
export function parseFortOrderReply(value: unknown): FortOrderReply | null {
  const f = fields(value);
  if (!f) return null;
  if (f.ok === true) {
    const fort = parseFortView(f.fort);
    const done = parseFortDone(f.done);
    return fort && done ? { ok: true, fort, done } : null;
  }
  if (f.ok !== false) return null;
  const reason = (['off', 'unreachable', 'no-pilot'] as const).find((known) => known === f.reason);
  return reason ? { ok: false, reason } : null;
}

/** The reply of this game's own /api/fort, checked. Null for anything else. */
export function parseFortReply(value: unknown): FortReply | null {
  const f = fields(value);
  if (!f) return null;
  if (f.ok === true) {
    const fort = parseFortView(f.fort);
    return fort ? { ok: true, fort } : null;
  }
  if (f.ok !== false) return null;
  const reason = (['off', 'unreachable', 'no-pilot'] as const).find((known) => known === f.reason);
  return reason ? { ok: false, reason } : null;
}
