// The fort screen: what a pilot sees while they have no ship. It is part of
// the game's own page, laid over the game still drawing behind it, so going
// in and coming out is showing and hiding, never loading.
//
// The fort's contents are read from this game's server (/api/fort), which
// reads them from SpaceFort. They are fetched when the game connects and kept,
// so the screen opens with something to show.

import { levelOf, rankOf } from '../shared/progress.ts';
import { parseFortOrderReply, parseFortReply } from '../shared/fort.ts';
import type {
  CrewMember,
  FortOrder,
  FortOrderReply,
  FortReply,
  FortReport,
  FortView,
} from '../shared/fort.ts';
import {
  ReportWatch,
  crewLine,
  debriefLines,
  gearChoices,
  jobChoices,
  plainWords,
  secondsUntil,
  unavailableText,
} from './fortModel.ts';
import type { Sortie } from './fortModel.ts';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} is missing from the page`);
  return found;
}

/** While the screen is open, how often the fort is read again. */
const REFRESH_MS = 10_000;
/** While the pilot flies, how often: enough to hear that a crew member is back. */
const FLIGHT_REFRESH_MS = 30_000;
/** After a unit's time is up, how soon the fort is asked what happened. */
const DUE_REFRESH_MS = 1500;
/** Clocks on the screen tick once a second, not once a frame. */
const REDRAW_MS = 250;
/** The jobs offered to a crew member at once: the shortest ones open to them. */
const JOBS_OFFERED = 3;
/** How long what the fort said about an order stays on the screen. */
const SAID_MS = 6000;

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
  private readonly sendOrder: (
    pilotKey: string,
    order: FortOrder,
  ) => Promise<FortOrderReply | null>;
  private readonly onReport: (report: FortReport) => void;
  private readonly watch = new ReportWatch();
  private fort: FortView | null = null;
  private fortReadAtMs = 0;
  private problem: FortReply | null = null;
  private asking = false;
  private warmed = false;
  private nextReadAtMs = 0;
  private lastDrawMs = -Infinity;
  /** What was last written to the page, so an unchanged frame touches nothing. */
  private drawn = '';
  /** The crew member whose orders are showing: null until one is picked for the pilot, '' for none. */
  private picked: string | null = null;
  /** An order is on its way: no other is taken until it is answered. */
  private ordering = false;
  /** What the fort said about the last order, until it fades. */
  private said: { text: string; ok: boolean; untilMs: number } | null = null;
  /** The item a crate just opened into, picked out in the hold. */
  private fresh: string | null = null;
  /** The status line of each crew member on the page, for its clock to tick in place. */
  private readonly clocks = new Map<string, HTMLElement>();

  constructor(options: {
    /** The pilot's key in hex, or null when this browser keeps none. */
    pilotKey: string | null;
    onLaunch: () => void;
    /** Told of each report that arrives while the screen is closed. */
    onReport?: (report: FortReport) => void;
    /** Replaces the network, for tests of the screen alone. */
    fetchFort?: (pilotKey: string) => Promise<FortReply | null>;
    sendOrder?: (pilotKey: string, order: FortOrder) => Promise<FortOrderReply | null>;
  }) {
    this.pilotKey = options.pilotKey;
    this.fetchFort = options.fetchFort ?? readFortOverHttp;
    this.sendOrder = options.sendOrder ?? orderFortOverHttp;
    this.onReport = options.onReport ?? (() => undefined);
    element('fort-launch', HTMLButtonElement).addEventListener('click', () => {
      options.onLaunch();
    });
    // Every order on the screen is a button that says what it does.
    this.root.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button || !this.root.contains(button)) return;
      if (button.dataset.pick !== undefined) {
        this.picked = this.picked === button.dataset.pick ? '' : button.dataset.pick;
        this.lastDrawMs = -Infinity;
      } else if (button.dataset.order) {
        this.order(JSON.parse(button.dataset.order) as FortOrder);
      }
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
    if (!this.open) {
      // A pilot with a fort hears from it while flying: a crew member back
      // from a job is a banner in the cockpit.
      if (this.fort && nowMs >= this.nextReadAtMs) this.read(nowMs);
      return;
    }
    if (nowMs >= this.nextReadAtMs) this.read(nowMs);
    if (nowMs - this.lastDrawMs >= REDRAW_MS) this.draw(context, nowMs);
  }

  private read(nowMs: number): void {
    this.nextReadAtMs = nowMs + (this.open ? REFRESH_MS : FLIGHT_REFRESH_MS);
    if (this.asking || this.ordering) return;
    if (!this.pilotKey) {
      this.problem = { ok: false, reason: 'no-pilot' };
      return;
    }
    this.asking = true;
    void this.fetchFort(this.pilotKey)
      .then((reply) => {
        // An order sent meanwhile has the newer word on the fort.
        if (this.ordering) return;
        if (reply?.ok) {
          this.take(reply.fort, !this.open);
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

  /** Takes the fort as just read. `tell` says its new reports are news to the pilot. */
  private take(fort: FortView, tell: boolean): void {
    this.fort = fort;
    this.fortReadAtMs = performance.now();
    const fresh = this.watch.take(fort.reports);
    if (tell) for (const report of fresh) this.onReport(report);
  }

  /** Sends one order and shows what the fort said and how the fort stands after it. */
  private order(order: FortOrder): void {
    if (this.ordering || !this.pilotKey) return;
    this.ordering = true;
    this.root.classList.add('ordering');
    const say = (text: string, ok: boolean): void => {
      this.said = { text, ok, untilMs: performance.now() + SAID_MS };
    };
    void this.sendOrder(this.pilotKey, order)
      .then((reply) => {
        if (!reply?.ok) {
          say(unavailableText(reply?.reason ?? 'unreachable'), false);
          return;
        }
        const before = new Set(this.fort?.hold.items.map((item) => item.id));
        this.take(reply.fort, false);
        this.problem = null;
        if (order.kind === 'open' && reply.done.ok) {
          this.fresh = reply.fort.hold.items.find((item) => !before.has(item.id))?.id ?? null;
          say(`The crate held: ${reply.done.message}`, true);
        } else {
          say(reply.done.message, reply.done.ok);
        }
      })
      .finally(() => {
        this.ordering = false;
        this.root.classList.remove('ordering');
        this.lastDrawMs = -Infinity;
      });
  }

  private draw(context: FortContext, nowMs: number): void {
    this.lastDrawMs = nowMs;
    const fort = this.fort;
    const level = context.xp === null ? null : levelOf(context.xp);

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
    // Someone's orders are always showing to begin with: the first who is free.
    if (this.picked === null && crew.length > 0) {
      this.picked = (crew.find(({ line }) => line.free) ?? crew[0])?.member.id ?? null;
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
      waiting > 0 && fort
        ? `Bringing ${waiting} crate${waiting === 1 ? '' : 's'} in from your ship…`
        : waiting > 0
          ? `${waiting} crate${waiting === 1 ? '' : 's'} won in flight ${waiting === 1 ? 'is' : 'are'} aboard your ship, and safe there until the fort answers.`
          : '';
    const status = fort
      ? this.problem && !this.problem.ok && this.problem.reason === 'unreachable'
        ? 'The fort is not answering. Showing what it last said.'
        : ''
      : this.problem && !this.problem.ok
        ? unavailableText(this.problem.reason)
        : 'Opening the fort…';
    if (this.said && performance.now() >= this.said.untilMs) this.said = null;
    const stateText = [this.said?.text ?? status, context.launchNote].filter(Boolean).join(' ');

    // The clocks tick in place, every look, without the lists being rebuilt:
    // a button under a finger must still be there when the finger lifts.
    for (const { member, line } of crew) {
      const clock = this.clocks.get(member.id);
      const text = member.doing && !line.free ? `${line.text} · ${member.doing}` : line.text;
      if (clock && clock.textContent !== text) clock.textContent = text;
    }

    // Everything else the screen says, as text first: if none of it has
    // changed since the last look, the page is left alone.
    const signature = JSON.stringify([
      level,
      fort?.currencies,
      fort?.hold,
      fort?.jobs.map((job) => [job.id, job.open]),
      fort?.reports,
      crew.map(({ member, line }) => [member, line.free]),
      this.picked,
      this.fresh,
      debrief,
      title,
      note,
      holdNote,
      stateText,
      waiting,
    ]);
    if (signature === this.drawn) return;
    this.drawn = signature;
    // Rebuilding the lists must not take the keyboard's place away.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusKey = focused && this.root.contains(focused) ? focused.dataset.key : undefined;

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

    this.clocks.clear();
    this.crew.replaceChildren(
      ...(fort && crew.length > 0
        ? crew.map(({ member, line }) => this.crewRow(fort, member, line.free, line.text))
        : [emptyRow(fort ? 'No crew yet.' : status)]),
    );

    this.holdNote.textContent = holdNote;
    const crates = fort?.hold.crates ?? [];
    const items = fort?.hold.items ?? [];
    const more = (fort?.hold.itemCount ?? 0) - items.length;
    const nameOf = (id: string): string =>
      fort?.crew.find((member) => member.id === id)?.name ?? 'a crew member';
    this.hold.replaceChildren(
      ...(crates.length + items.length > 0
        ? [
            ...crates.map((crate) => {
              const item = row(`${crate.tier} crate`, [
                `Unopened · from ${sourceText(crate.source)}`,
              ]);
              item.dataset.rarity = crate.tier.toLowerCase();
              beside(item, orderButton('Open', { kind: 'open', crateId: crate.id }));
              return item;
            }),
            ...items.map((gear) => {
              const item = row(gear.name, [
                [gear.rarity, gear.slot ? plainWords(gear.slot) : null, `+${gear.bonus}`]
                  .filter(Boolean)
                  .join(' · '),
                gear.wornBy
                  ? `Worn by ${nameOf(gear.wornBy)}`
                  : gear.fits.length === 0
                    ? 'Nobody in your crew can wear this yet'
                    : '',
              ]);
              item.dataset.rarity = gear.rarity.toLowerCase();
              if (gear.id === this.fresh) item.classList.add('fresh');
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
    this.state.classList.toggle('refused', this.said?.ok === false);
    this.state.classList.toggle('done', this.said?.ok === true);

    if (focusKey) {
      const again = [...this.root.querySelectorAll<HTMLElement>('button[data-key]')].find(
        (button) => button.dataset.key === focusKey,
      );
      (again ?? this.root).focus({ preventScroll: true });
    }
  }

  /** One crew member: who they are and what they are doing, and their orders when picked. */
  private crewRow(
    fort: FortView,
    member: CrewMember,
    free: boolean,
    status: string,
  ): HTMLLIElement {
    const item = document.createElement('li');
    item.className = free ? 'free' : 'busy';
    const picked = this.picked === member.id;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'fort-pick';
    head.dataset.pick = member.id;
    head.dataset.key = `pick:${member.id}`;
    head.setAttribute('aria-expanded', String(picked));
    const name = document.createElement('b');
    name.textContent = member.name;
    const what = document.createElement('small');
    what.textContent =
      `${member.className} · level ${member.level}` +
      (member.points > 0 ? ` · ${member.points} skill point${member.points === 1 ? '' : 's'}` : '');
    const clock = document.createElement('small');
    clock.className = 'status';
    clock.textContent = member.doing && !free ? `${status} · ${member.doing}` : status;
    this.clocks.set(member.id, clock);
    head.append(name, what, clock);
    item.append(head);
    if (!picked) return item;

    const orders = document.createElement('div');
    orders.className = 'fort-orders';

    // Jobs first: sending someone out is the order given most.
    orders.append(heading('Jobs'));
    const jobs = jobChoices(fort, member);
    orders.append(
      list(
        !free
          ? [plainRow('Busy until they are back.')]
          : jobs.length === 0
            ? [plainRow('No job is open to them just now. More come up every few minutes.')]
            : jobs.slice(0, JOBS_OFFERED).map(({ job, line, blocked }) => {
                const entry = row(job.title, [line, blocked]);
                entry.dataset.rarity = job.rarity.toLowerCase();
                if (!blocked) {
                  beside(
                    entry,
                    orderButton('Send', { kind: 'send', unitId: member.id, jobId: job.id }),
                  );
                }
                return entry;
              }),
      ),
    );

    orders.append(heading('Gear'));
    orders.append(
      list(
        member.gear.map(({ slot, item: worn }) => {
          if (worn) {
            const entry = row(worn.name, [plainWords(slot)]);
            entry.dataset.rarity = worn.rarity.toLowerCase();
            beside(entry, orderButton('Take off', { kind: 'unequip', unitId: member.id, slot }));
            return entry;
          }
          const choices = gearChoices(fort, member, slot);
          const entry = plainRow(
            choices.length > 0
              ? `${plainWords(slot)}: empty`
              : `${plainWords(slot)}: nothing to wear`,
          );
          for (const choice of choices.slice(0, 3)) {
            entry.append(
              orderButton(`Wear ${choice.name} +${choice.bonus}`, {
                kind: 'equip',
                unitId: member.id,
                itemId: choice.id,
              }),
            );
          }
          return entry;
        }),
      ),
    );

    orders.append(
      heading(
        member.points > 0
          ? `Skills · ${member.points} point${member.points === 1 ? '' : 's'} to spend`
          : 'Skills',
      ),
    );
    orders.append(
      list(
        member.skills.map((skill) => {
          const entry = plainRow(`${plainWords(skill.name)} ${skill.value}`);
          if (member.points > 0 && skill.value < 100) {
            beside(
              entry,
              orderButton('+1', {
                kind: 'train',
                unitId: member.id,
                skill: skill.name,
                points: 1,
              }),
            );
          }
          return entry;
        }),
      ),
    );
    item.append(orders);
    return item;
  }
}

/** A button that gives one order. Its key lets the keyboard keep its place when the list is rebuilt. */
function orderButton(label: string, order: FortOrder): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fort-order';
  button.textContent = label;
  button.dataset.order = JSON.stringify(order);
  button.dataset.key = button.dataset.order;
  return button;
}

/** Puts a row's one order beside its words, not under them. */
function beside(entry: HTMLLIElement, button: HTMLButtonElement): void {
  entry.classList.add('with-order');
  entry.append(button);
}

function heading(text: string): HTMLElement {
  const title = document.createElement('h4');
  title.textContent = text;
  return title;
}

function list(rows: readonly HTMLLIElement[]): HTMLUListElement {
  const all = document.createElement('ul');
  all.append(...rows);
  return all;
}

function plainRow(text: string): HTMLLIElement {
  const item = document.createElement('li');
  const words = document.createElement('span');
  words.textContent = text;
  item.append(words);
  return item;
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

async function orderFortOverHttp(
  pilotKey: string,
  order: FortOrder,
): Promise<FortOrderReply | null> {
  try {
    const response = await fetch('/api/fort/order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pilotKey, order }),
    });
    if (!response.ok) return null;
    return parseFortOrderReply(await response.json());
  } catch {
    return null;
  }
}
