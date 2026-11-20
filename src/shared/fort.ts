// The fort as the game shows it: a pilot's crew, hold and currencies, read
// from SpaceFort's server by this game's server and passed to the page.
// Everything that crosses that boundary is checked here, so the page can
// trust what it is given.

export type CrewState = 'ready' | 'mission' | 'challenge' | 'raid' | 'resting';
const CREW_STATES: readonly CrewState[] = ['ready', 'mission', 'challenge', 'raid', 'resting'];

export interface CrewMember {
  readonly id: string;
  readonly name: string;
  readonly className: string;
  readonly level: number;
  readonly state: CrewState;
  /** When what they are doing ends, in the fort's clock (ms). Null when nothing says. */
  readonly until: number | null;
  readonly doing: string | null;
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
  readonly reports: readonly FortReport[];
}

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
  const state = CREW_STATES.find((known) => known === f.state);
  const until = f.until === null ? null : count(f.until);
  const doing = optionalWords(f.doing, 200);
  if (id === null || name === null || className === null || level === null) return null;
  if (!state) return null;
  if (f.until !== null && until === null) return null;
  if (doing === undefined) return null;
  return { id, name, className, level, state, until, doing };
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
  return id !== null && name !== null && rarity !== null && slot !== undefined
    ? { id, name, rarity, slot }
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
  const reports = list(f.reports, 50, report, left);
  if (now === null || credits === null || upgradePoints === null || renown === null) return null;
  if (itemCount === null) return null;
  if (!crew || !crates || !items || !reports) return null;
  if (left.out > 0) onLeftOut?.(left.out);
  return {
    now,
    currencies: { credits, upgradePoints, renown },
    crew,
    hold: { crates, itemCount, items },
    reports,
  };
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
