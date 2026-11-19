// The crates pilots have won and not yet carried to SpaceFort. A crate has no
// owner but the pilot key until a claim code moves it: the code is shown to
// the pilot, typed into SpaceFort beside their wallet, and redeemed here by
// SpaceFort's server. Nothing of value is ever tied to the pilot key itself.

import { randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CRATE_SOURCES, CRATE_TIERS, DAILY_CRATE_CAP } from '../shared/drops.ts';
import type { CrateSource, CrateTier } from '../shared/drops.ts';

export interface Crate {
  /** Unique for ever: SpaceFort refuses a crate it has seen. */
  readonly id: string;
  readonly tier: CrateTier;
  readonly source: CrateSource;
  /** The pilot's level when it dropped. */
  readonly level: number;
  readonly at: number;
}

interface Hold {
  crates: Crate[];
  /** The day (UTC, days since 1970) the count below is for. */
  day: number;
  /** Crates from orbs and raiders won that day. */
  capped: number;
}

export interface Redemption {
  readonly code: string;
  readonly crates: readonly Crate[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CODE_LIFE_MS = 10 * 60 * 1000;
/** A redeemed code answers again with the same crates for this long, so a lost reply can be retried. */
const REPLAY_MS = 60 * 60 * 1000;
/** No look-alikes (0 O 1 I): the code is read off one screen and typed into another. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const WRITE_EVERY_MS = 5000;

export class MemoryCrateStore {
  protected readonly holds = new Map<string, Hold>();
  private readonly codes = new Map<string, { key: string; expires: number }>();
  private readonly redeemed = new Map<string, { crates: Crate[]; expires: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  count(key: string): number {
    return this.holds.get(key)?.crates.length ?? 0;
  }

  pending(key: string): readonly Crate[] {
    return this.holds.get(key)?.crates ?? [];
  }

  /** True if this pilot may still win a crate from an orb or a raider today. */
  underCap(key: string): boolean {
    const hold = this.holds.get(key);
    return !hold || hold.day !== this.day() || hold.capped < DAILY_CRATE_CAP;
  }

  /** Puts a new crate in the pilot's hold. The caller has checked the cap for orbs and raiders. */
  add(key: string, tier: CrateTier, source: CrateSource, level: number): Crate {
    const crate: Crate = {
      id: randomBytes(12).toString('hex'),
      tier,
      source,
      level,
      at: this.now(),
    };
    const hold = this.holds.get(key) ?? { crates: [], day: this.day(), capped: 0 };
    if (hold.day !== this.day()) {
      hold.day = this.day();
      hold.capped = 0;
    }
    if (source !== 'boss') hold.capped += 1;
    hold.crates.push(crate);
    this.holds.set(key, hold);
    this.changed();
    return crate;
  }

  /** A code for everything the pilot holds now, or null if they hold nothing. Asking again replaces the last one. */
  issueCode(key: string): { code: string; expires: number; crates: number } | null {
    const crates = this.count(key);
    if (crates === 0) return null;
    for (const [code, entry] of this.codes) {
      if (entry.key === key || entry.expires < this.now()) this.codes.delete(code);
    }
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++)
      code += CODE_LETTERS.charAt(randomInt(CODE_LETTERS.length));
    const expires = this.now() + CODE_LIFE_MS;
    this.codes.set(code, { key, expires });
    return { code, expires, crates };
  }

  /**
   * Hands over the crates behind a code and empties the hold. The same code
   * gives the same crates again for an hour, and nothing after that.
   */
  redeem(code: string): Redemption | null {
    const now = this.now();
    for (const [old, entry] of this.redeemed) if (entry.expires < now) this.redeemed.delete(old);
    const again = this.redeemed.get(code);
    if (again) return { code, crates: again.crates };
    const entry = this.codes.get(code);
    if (!entry || entry.expires < now) return null;
    this.codes.delete(code);
    const hold = this.holds.get(entry.key);
    const crates = hold?.crates ?? [];
    if (hold) hold.crates = [];
    this.redeemed.set(code, { crates, expires: now + REPLAY_MS });
    this.changed();
    return { code, crates };
  }

  protected changed(): void {
    // Memory only.
  }

  private day(): number {
    return Math.floor(this.now() / DAY_MS);
  }
}

function holdFrom(value: unknown): Hold | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.crates) || typeof record.day !== 'number') return null;
  if (typeof record.capped !== 'number') return null;
  const crates: Crate[] = [];
  for (const item of record.crates as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const crate = item as Record<string, unknown>;
    const tier = CRATE_TIERS.find((name) => name === crate.tier);
    const source = CRATE_SOURCES.find((name) => name === crate.source);
    if (!tier || !source || typeof crate.id !== 'string') return null;
    if (typeof crate.level !== 'number' || typeof crate.at !== 'number') return null;
    crates.push({ id: crate.id, tier, source, level: crate.level, at: crate.at });
  }
  return { crates, day: record.day, capped: record.capped };
}

/** The same, written to `crates.json` in a directory at most every few seconds. */
export class FileCrateStore extends MemoryCrateStore {
  private readonly file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(directory: string) {
    super();
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'crates.json');
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    // As with pilots: a file that cannot be read stops the server, because
    // starting empty would overwrite what people have won.
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`${this.file} does not hold crates`);
    }
    for (const [key, value] of Object.entries(parsed)) {
      const hold = holdFrom(value);
      if (!hold) throw new Error(`${this.file} has a record that is not a hold: ${key}`);
      this.holds.set(key, hold);
    }
  }

  protected override changed(): void {
    this.timer ??= setTimeout(() => {
      this.flush();
    }, WRITE_EVERY_MS);
  }

  /** Writes now. The server calls this as it shuts down. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.holds)));
    renameSync(temporary, this.file);
  }
}
