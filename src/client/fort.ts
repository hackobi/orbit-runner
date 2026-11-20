// The fort screen: what a pilot sees while they have no ship. It is part of
// the game's own page, laid over the game still drawing behind it, so going
// in and coming out is showing and hiding, never loading.
//
// The fort's contents are read from this game's server (/api/fort), which
// reads them from SpaceFort. They are fetched when the game connects and kept,
// so the screen opens with something to show.

import { levelOf, rankOf } from '../shared/progress.ts';
import { parseFortReply } from '../shared/fort.ts';
import type { FortReply, FortView } from '../shared/fort.ts';
import { crewLine, debriefLines, secondsUntil, unavailableText } from './fortModel.ts';
import type { Sortie } from './fortModel.ts';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} is missing from the page`);
  return found;
}

/** While the screen is open, how often the fort is read again. */
const REFRESH_MS = 10_000;
/** After a unit's time is up, how soon the fort is asked what happened. */
const DUE_REFRESH_MS = 1500;
/** Clocks on the screen tick once a second, not once a frame. */
const REDRAW_MS = 250;

const number = (value: number): string => Math.floor(value).toLocaleString('en-US');

/** What the game knows that the fort screen shows. */
export interface FortContext {
  /** The pilot's experience, or null before the server has said. */
  readonly xp: number | null;
  /** Crates won in flight and not yet brought into the fort. */
  readonly cratesInFlight: number;
  /** The sortie that just ended, or null. */
  readonly sortie: Sortie | null;
  /** True when the ship was lost while the pilot was away. */
  readonly lostWhileAway: boolean;
  /** Why launching will take a moment, or '' when it will not. */
  readonly launchNote: string;
}

export class FortScreen {
  private readonly root = element('fort', HTMLElement);
  private readonly pilot = element('fort-pilot', HTMLElement);
  private readonly upgrade = element('fort-upgrade', HTMLElement);
  private readonly credits = element('fort-credits', HTMLElement);
  private readonly renown = element('fort-renown', HTMLElement);
  private readonly crates = element('fort-crates', HTMLElement);
  private readonly debriefTitle = element('fort-debrief-title', HTMLElement);
  private readonly debriefNote = element('fort-debrief-note', HTMLElement);
  private readonly debriefList = element('fort-debrief-lines', HTMLElement);
  private readonly reports = element('fort-reports', HTMLElement);
  private readonly crew = element('fort-crew', HTMLElement);
  private readonly holdNote = element('fort-hold-note', HTMLElement);
  private readonly hold = element('fort-hold', HTMLElement);
  private readonly state = element('fort-state', HTMLElement);

  private readonly pilotKey: string | null;
  private readonly fetchFort: (pilotKey: string) => Promise<FortReply | null>;
  private fort: FortView | null = null;
  private fortReadAtMs = 0;
  private problem: FortReply | null = null;
  private asking = false;
  private warmed = false;
  private nextReadAtMs = 0;
  private lastDrawMs = -Infinity;
  /** What was last written to the page, so an unchanged frame touches nothing. */
  private drawn = '';

  constructor(options: {
    /** The pilot's key in hex, or null when this browser keeps none. */
    pilotKey: string | null;
    onLaunch: () => void;
    /** Replaces the network, for tests of the screen alone. */
    fetchFort?: (pilotKey: string) => Promise<FortReply | null>;
  }) {
    this.pilotKey = options.pilotKey;
    this.fetchFort = options.fetchFort ?? readFortOverHttp;
    element('fort-launch', HTMLButtonElement).addEventListener('click', () => {
      options.onLaunch();
    });
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  /** Shows or hides the screen. Showing it is immediate: what is known is drawn at once. */
  setOpen(open: boolean, context: FortContext, nowMs: number): void {
    if (open === this.open) return;
    this.root.hidden = !open;
    document.body.classList.toggle('fort-open', open);
    if (!open) return;
    this.lastDrawMs = -Infinity;
    this.draw(context, nowMs);
    // Not the Launch button: a fire key still held from the fight would press it.
    this.root.focus({ preventScroll: true });
    this.nextReadAtMs = nowMs;
  }

  /**
   * Reads the fort once in the background, so that it is there when the
   * screen opens. Safe to call every frame: only the first call asks. If that
   * one fails, the fort is asked again when the screen opens, not before.
   */
  warm(nowMs: number): void {
    if (this.warmed) return;
    this.warmed = true;
    this.read(nowMs);
  }

  /** Once a frame while the game runs. */
  update(context: FortContext, nowMs: number): void {
    if (!this.open) return;
    if (nowMs >= this.nextReadAtMs) this.read(nowMs);
    if (nowMs - this.lastDrawMs >= REDRAW_MS) this.draw(context, nowMs);
  }

  private read(nowMs: number): void {
    this.nextReadAtMs = nowMs + REFRESH_MS;
    if (this.asking) return;
    if (!this.pilotKey) {
      this.problem = { ok: false, reason: 'no-pilot' };
      return;
    }
    this.asking = true;
    void this.fetchFort(this.pilotKey)
      .then((reply) => {
        if (reply?.ok) {
          this.fort = reply.fort;
          this.fortReadAtMs = performance.now();
          this.problem = null;
        } else {
          this.problem = reply ?? { ok: false, reason: 'unreachable' };
        }
      })
      .finally(() => {
        this.asking = false;
        this.lastDrawMs = -Infinity;
      });
  }

  private draw(context: FortContext, nowMs: number): void {
    this.lastDrawMs = nowMs;
    const fort = this.fort;
    const level = context.xp === null ? null : levelOf(context.xp);

    // Everything the screen says, as text first: if none of it has changed
    // since the last look, the page is left alone.
    const crew = (fort?.crew ?? []).map((member) => {
      const left =
        member.until === null
          ? null
          : secondsUntil(member.until, fort?.now ?? 0, this.fortReadAtMs, nowMs);
      return { member, line: crewLine(member, left) };
    });
    if (crew.some(({ line }) => line.due)) {
      this.nextReadAtMs = Math.min(this.nextReadAtMs, nowMs + DUE_REFRESH_MS);
    }
    const sortie = context.sortie;
    const debrief = sortie ? debriefLines(sortie) : [];
    const title = context.lostWhileAway
      ? 'While you were away'
      : sortie
        ? 'Sortie report'
        : 'Welcome back';
    const note = context.lostWhileAway
      ? 'Your ship was lost with nobody at the controls. Launch when you are ready.'
      : sortie
        ? ''
        : 'No sortie flown yet this visit. Launch when you are ready.';
    const waiting = context.cratesInFlight;
    const holdNote =
      waiting > 0
        ? `${waiting} crate${waiting === 1 ? '' : 's'} won in flight ${waiting === 1 ? 'is' : 'are'} still aboard your ship. Bring ${waiting === 1 ? 'it' : 'them'} in with a claim code from ⚙ for now.`
        : '';
    const status = fort
      ? this.problem && !this.problem.ok && this.problem.reason === 'unreachable'
        ? 'The fort is not answering. Showing what it last said.'
        : ''
      : this.problem && !this.problem.ok
        ? unavailableText(this.problem.reason)
        : 'Opening the fort…';
    const stateText = [status, context.launchNote].filter(Boolean).join(' ');

    const signature = JSON.stringify([
      level,
      fort?.currencies,
      fort?.hold,
      fort?.reports,
      crew.map(({ member, line }) => [member.id, member.level, line.text]),
      debrief,
      title,
      note,
      holdNote,
      stateText,
    ]);
    if (signature === this.drawn) return;
    this.drawn = signature;

    this.pilot.textContent = level === null ? '—' : `${rankOf(level)} · ${level}`;
    const dash = (value: number | undefined): string => (value === undefined ? '—' : number(value));
    this.upgrade.textContent = dash(fort?.currencies.upgradePoints);
    this.credits.textContent = dash(fort?.currencies.credits);
    this.renown.textContent = dash(fort?.currencies.renown);
    this.crates.textContent = fort
      ? waiting > 0
        ? `${fort.hold.crates.length} + ${waiting}`
        : String(fort.hold.crates.length)
      : waiting > 0
        ? `+ ${waiting}`
        : '—';

    this.debriefTitle.textContent = title;
    this.debriefNote.textContent = note;
    this.debriefList.replaceChildren(
      ...debrief.flatMap((line) => {
        const label = document.createElement('dt');
        label.textContent = line.label;
        const value = document.createElement('dd');
        value.textContent = line.value;
        if (line.gain) value.className = 'gain';
        return [label, value];
      }),
    );

    const reports = fort?.reports ?? [];
    this.reports.replaceChildren(
      ...(reports.length > 0
        ? reports.map((report) => row(report.title, report.detail ? [report.detail] : []))
        : [emptyRow(fort ? 'Nothing to report yet.' : status)]),
    );

    this.crew.replaceChildren(
      ...(crew.length > 0
        ? crew.map(({ member, line }) => {
            const item = row(member.name, [
              `${member.className} · level ${member.level}`,
              member.doing && !line.free ? `${line.text} · ${member.doing}` : line.text,
            ]);
            item.className = line.free ? 'free' : 'busy';
            return item;
          })
        : [emptyRow(fort ? 'No crew yet.' : status)]),
    );

    this.holdNote.textContent = holdNote;
    const crates = fort?.hold.crates ?? [];
    const items = fort?.hold.items ?? [];
    const more = (fort?.hold.itemCount ?? 0) - items.length;
    this.hold.replaceChildren(
      ...(crates.length + items.length > 0
        ? [
            ...crates.map((crate) => {
              const item = row(`${crate.tier} crate`, [
                `Unopened · from ${sourceText(crate.source)}`,
              ]);
              item.dataset.rarity = crate.tier.toLowerCase();
              return item;
            }),
            ...items.map((gear) => {
              const item = row(gear.name, [
                [gear.rarity, gear.slot ? slotText(gear.slot) : null].filter(Boolean).join(' · '),
              ]);
              item.dataset.rarity = gear.rarity.toLowerCase();
              return item;
            }),
            ...(more > 0 ? [emptyRow(`and ${more} more`)] : []),
          ]
        : [
            emptyRow(
              fort ? 'The hold is empty. Orbs, raiders and the Warlock drop crates.' : status,
            ),
          ]),
    );

    this.state.textContent = stateText;
  }
}

function row(title: string, lines: readonly string[]): HTMLLIElement {
  const item = document.createElement('li');
  const name = document.createElement('b');
  name.textContent = title;
  item.append(name);
  for (const line of lines) {
    if (!line) continue;
    const small = document.createElement('small');
    small.textContent = line;
    item.append(small);
  }
  return item;
}

function emptyRow(text: string): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'empty';
  item.textContent = text;
  return item;
}

const SOURCES: Record<string, string> = {
  orb: 'the belt',
  raider: 'a raider',
  boss: 'the Warlock',
  oracle: 'the Oracle',
};
const sourceText = (source: string): string => SOURCES[source] ?? source;

/** PRIMARY_WEAPON reads as "primary weapon". */
const slotText = (slot: string): string => slot.toLowerCase().replaceAll('_', ' ');

async function readFortOverHttp(pilotKey: string): Promise<FortReply | null> {
  try {
    const response = await fetch('/api/fort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pilotKey }),
    });
    if (!response.ok) return null;
    return parseFortReply(await response.json());
  } catch {
    return null;
  }
}
