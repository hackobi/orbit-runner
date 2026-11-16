// Everything drawn over the picture: gauges, map, scoreboard, name labels,
// the store, the death screen and the kill feed. It shows what the netcode
// reports and decides nothing; a purchase is a request the server answers.

import type { ClientCore, ShipView } from '../net/client.ts';
import type { RemoteView } from '../net/remotes.ts';
import { SIM } from '../shared/constants.ts';
import {
  CAUSE_ASTEROID,
  CAUSE_DISCONNECT,
  CAUSE_EDGE,
  CAUSE_PLANET,
  CAUSE_PLAYER,
  NO_PLAYER,
} from '../shared/protocol.ts';
import type { DeathEvent, GameEvent } from '../shared/protocol.ts';
import { STORE_ITEMS, STORE_PRICES } from '../shared/scoring.ts';
import type { StoreItem } from '../shared/scoring.ts';
import { grantWouldChange, outsideCombatZone } from '../shared/sim/world.ts';

/** Where a point of the world falls on the screen, in CSS pixels. False if it is not in view. */
export type Project = (x: number, y: number, z: number, out: { x: number; y: number }) => boolean;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`#${id} is missing from the page`);
  return found;
}

const number = (value: number): string => Math.round(value).toLocaleString('en-US');

const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

const nameOf = (playerId: number, ownId: number): string =>
  playerId === ownId ? 'You' : `Player ${playerId + 1}`;

const FEED_SECONDS = 6;
const FEED_LINES = 4;
const MAP_EVERY_MS = 100;
const BEST_KEY = 'orbit-runner.best';

interface Best {
  score: number;
  lifeSeconds: number;
}

function readBest(): Best {
  try {
    const stored = JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') as Partial<Best>;
    return {
      score: typeof stored.score === 'number' ? stored.score : 0,
      lifeSeconds: typeof stored.lifeSeconds === 'number' ? stored.lifeSeconds : 0,
    };
  } catch {
    // Private browsing, or storage switched off: bests last for the visit.
    return { score: 0, lifeSeconds: 0 };
  }
}

function writeBest(best: Best): void {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    // See readBest.
  }
}

/** Sets text or an attribute only when it changes, so the page is not laid out every frame. */
class Shown {
  private readonly values = new Map<string, string>();

  text(node: HTMLElement, value: string): void {
    const key = `t:${node.id}`;
    if (this.values.get(key) === value) return;
    this.values.set(key, value);
    node.textContent = value;
  }

  style(node: HTMLElement, property: string, value: string): void {
    const key = `s:${node.id}:${property}`;
    if (this.values.get(key) === value) return;
    this.values.set(key, value);
    node.style.setProperty(property, value);
  }

  hidden(node: HTMLElement, hidden: boolean): void {
    if (node.hidden !== hidden) node.hidden = hidden;
  }

  className(node: HTMLElement, value: string): void {
    if (node.className !== value) node.className = value;
  }
}

export class Hud {
  private readonly shown = new Shown();
  private readonly statusLine = element('status', HTMLDivElement);
  private readonly warning = element('warning', HTMLDivElement);
  private readonly hullBar = element('hull-bar', HTMLDivElement);
  private readonly hullFill = element('hull-fill', HTMLDivElement);
  private readonly hull = element('hull', HTMLSpanElement);
  private readonly shieldFill = element('shield-fill', HTMLDivElement);
  private readonly shield = element('shield', HTMLSpanElement);
  private readonly energyFill = element('energy-fill', HTMLDivElement);
  private readonly energy = element('energy', HTMLSpanElement);
  private readonly speed = element('speed', HTMLDivElement);
  private readonly points = element('points', HTMLDivElement);
  private readonly kills = element('kills', HTMLDivElement);
  private readonly timers = element('timers', HTMLDivElement);
  private readonly map = element('minimap', HTMLCanvasElement);
  private readonly scoreboard = element('scoreboard', HTMLOListElement);
  private readonly feed = element('feed', HTMLUListElement);
  private readonly labels = element('labels', HTMLDivElement);
  private readonly store = element('store', HTMLDivElement);
  private readonly storeTime = element('store-time', HTMLSpanElement);
  private readonly death = element('death', HTMLDivElement);
  private readonly deathTitle = element('death-title', HTMLHeadingElement);
  private readonly deathDetail = element('death-detail', HTMLParagraphElement);
  private readonly deathBest = element('death-best', HTMLParagraphElement);
  private readonly deathRespawn = element('death-respawn', HTMLParagraphElement);
  private readonly help = element('help', HTMLDivElement);

  private readonly storeButtons = new Map<StoreItem, HTMLButtonElement>();
  private readonly labelNodes = new Map<number, HTMLSpanElement>();
  private readonly feedLines: { node: HTMLLIElement; untilMs: number }[] = [];
  private readonly point = { x: 0, y: 0 };
  private mapDrawnAtMs = -Infinity;
  private scoreboardText = '';
  private scoreboardOn: boolean;

  private best = readBest();
  private ownDeath: DeathEvent | null = null;
  private wasAlive = false;
  private lifeStartedAtMs = 0;
  private lifeSeconds = 0;

  constructor(buy: (item: StoreItem) => void) {
    for (const button of this.store.querySelectorAll('button')) {
      const item = STORE_ITEMS.find((candidate) => candidate === button.dataset.item);
      if (!item) continue;
      this.storeButtons.set(item, button);
      button.addEventListener('click', () => {
        buy(item);
      });
    }
    // A phone has no room for a scoreboard beside the picture, and no keys to explain.
    const touch = matchMedia('(pointer: coarse)').matches;
    this.scoreboardOn = !touch;
    if (!touch) {
      this.help.textContent =
        'A / D turn · I / K pitch · W / S speed · Shift boost · X brake · Space fire · 1 2 3 store · P players';
    }
    window.addEventListener('keydown', (event) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'KeyP') this.scoreboardOn = !this.scoreboardOn;
      const digit = ['Digit1', 'Digit2', 'Digit3'].indexOf(event.code);
      const item = STORE_ITEMS[digit];
      if (item && !this.store.hidden) buy(item);
    });
  }

  /** Something the server announced. The feed shows deaths and departures. */
  onEvent(event: GameEvent, core: ClientCore, nowMs: number): void {
    if (event.kind === 'left') {
      this.say(`${nameOf(event.playerId, core.playerId)} left`, nowMs);
      return;
    }
    if (event.kind !== 'death') return;
    if (event.victimId === core.playerId) this.ownDeath = event;
    const victim = nameOf(event.victimId, core.playerId);
    this.say(
      event.cause === CAUSE_PLAYER && event.killerId !== NO_PLAYER
        ? `${nameOf(event.killerId, core.playerId)} ➤ ${victim}`
        : `${victim} ${this.fate(event.cause, false)}`,
      nowMs,
    );
  }

  /** Call once a frame, after the picture is drawn. */
  update(
    core: ClientCore,
    status: string,
    view: ShipView | null,
    remotes: readonly RemoteView[],
    project: Project,
    nowMs: number,
  ): void {
    const shown = this.shown;
    shown.text(this.statusLine, status);
    this.expireFeed(nowMs);
    if (!view) return;

    // Gauges. v1's hull bar is green above 60, orange above 30, red below (main.js:4440).
    shown.style(this.hullFill, 'width', `${(view.hp / SIM.maxHp) * 100}%`);
    shown.className(this.hullBar, `bar${view.hp > 60 ? '' : view.hp > 30 ? ' mid' : ' low'}`);
    shown.text(this.hull, `Hull ${view.hp}`);
    shown.style(this.shieldFill, 'width', `${(view.shield / SIM.maxShield) * 100}%`);
    shown.text(this.shield, `Shield ${view.shield}`);
    const energy = Math.round((view.energy / SIM.maxEnergy) * 100);
    shown.style(this.energyFill, 'width', `${energy}%`);
    shown.text(this.energy, `Energy ${energy}`);
    shown.text(
      this.speed,
      `${Math.round(view.speed)} u/s${view.boosting ? '  BOOST' : ''}${view.fenix ? '  FENIX' : ''}`,
    );
    shown.text(this.points, `Points ${number(core.score)}`);
    shown.text(this.kills, `Kills ${core.kills}`);
    const timers: string[] = [];
    if (core.asteroidMultTicks > 0) {
      timers.push(`Rocks and orbs ×2  ${Math.ceil(core.asteroidMultTicks / SIM.tickRate)} s`);
    }
    if (core.killMultTicks > 0) {
      timers.push(`Kills ×2  ${Math.ceil(core.killMultTicks / SIM.tickRate)} s`);
    }
    shown.text(this.timers, timers.join(' · '));

    const state = core.state;
    shown.text(
      this.warning,
      view.alive && state && outsideCombatZone(state)
        ? 'Outside the combat zone. The hull is failing: turn back.'
        : '',
    );

    this.updateLife(core, view, nowMs);
    this.updateStore(core, view);
    this.updateLabels(view, remotes, project);
    this.updateScoreboard(core);
    if (nowMs - this.mapDrawnAtMs >= MAP_EVERY_MS) {
      this.mapDrawnAtMs = nowMs;
      this.drawMap(view, remotes);
    }
  }

  private fate(cause: number, own: boolean): string {
    switch (cause) {
      case CAUSE_PLANET:
        return own ? 'You flew into the planet.' : 'flew into the planet';
      case CAUSE_ASTEROID:
        return own ? 'You hit an asteroid.' : 'hit an asteroid';
      case CAUSE_EDGE:
        return own ? 'You left the combat zone.' : 'left the combat zone';
      case CAUSE_DISCONNECT:
        return own
          ? 'You were away too long. Move the controls to fly again.'
          : 'was away too long';
      default:
        return own ? 'You were shot down.' : 'was shot down';
    }
  }

  private say(text: string, nowMs: number): void {
    const node = document.createElement('li');
    node.textContent = text;
    this.feed.append(node);
    this.feedLines.push({ node, untilMs: nowMs + FEED_SECONDS * 1000 });
    while (this.feedLines.length > FEED_LINES) this.feedLines.shift()?.node.remove();
  }

  private expireFeed(nowMs: number): void {
    while (this.feedLines[0] && this.feedLines[0].untilMs <= nowMs) {
      this.feedLines.shift()?.node.remove();
    }
  }

  /** The death screen, and the personal bests it reports. */
  private updateLife(core: ClientCore, view: ShipView, nowMs: number): void {
    const shown = this.shown;
    if (view.alive && !this.wasAlive) {
      this.lifeStartedAtMs = nowMs;
      this.ownDeath = null;
    }
    if (!view.alive && this.wasAlive) {
      this.lifeSeconds = (nowMs - this.lifeStartedAtMs) / 1000;
      this.best = {
        score: Math.max(this.best.score, core.score),
        lifeSeconds: Math.max(this.best.lifeSeconds, this.lifeSeconds),
      };
      writeBest(this.best);
    }
    this.wasAlive = view.alive;

    shown.hidden(this.death, view.alive);
    if (view.alive) return;
    const death = this.ownDeath;
    shown.text(this.deathTitle, 'Destroyed');
    shown.text(
      this.deathDetail,
      death
        ? death.cause === CAUSE_PLAYER && death.killerId !== NO_PLAYER
          ? `Shot down by ${nameOf(death.killerId, core.playerId)}.`
          : this.fate(death.cause, true)
        : '',
    );
    shown.text(
      this.deathBest,
      `${number(core.score)} points · survived ${clock(this.lifeSeconds)} · ` +
        `best ${number(this.best.score)} and ${clock(this.best.lifeSeconds)}`,
    );
    const seconds = Math.ceil((core.state?.respawnTicks ?? 0) / SIM.tickRate);
    shown.text(this.deathRespawn, seconds > 0 ? `Back in ${seconds}` : 'Back any moment');
  }

  /** Open while the server says so. A button is live only if the server would sell. */
  private updateStore(core: ClientCore, view: ShipView): void {
    const open = view.alive && core.storeTicks > 0;
    this.shown.hidden(this.store, !open);
    if (!open) return;
    this.shown.text(this.storeTime, `closes in ${Math.ceil(core.storeTicks / SIM.tickRate)} s`);
    const state = core.state;
    for (const [item, button] of this.storeButtons) {
      const can =
        state !== null && core.score >= STORE_PRICES[item] && grantWouldChange(state, item);
      if (button.disabled === can) button.disabled = !can;
    }
  }

  /** A name over every other ship in view, with how far away it is. */
  private updateLabels(view: ShipView, remotes: readonly RemoteView[], project: Project): void {
    const seen = new Set<number>();
    for (const remote of remotes) {
      if (!remote.alive) continue;
      // Above the hull, which other ships are drawn half as big again.
      if (!project(remote.x, remote.y + 5, remote.z, this.point)) continue;
      seen.add(remote.id);
      let node = this.labelNodes.get(remote.id);
      if (!node) {
        node = document.createElement('span');
        this.labelNodes.set(remote.id, node);
        this.labels.append(node);
      }
      const distance = Math.hypot(remote.x - view.x, remote.y - view.y, remote.z - view.z);
      const text = `Player ${remote.id + 1}  ${number(distance)}`;
      if (node.textContent !== text) node.textContent = text;
      const kind = remote.full ? '' : 'far';
      if (node.className !== kind) node.className = kind;
      node.style.transform = `translate(${this.point.x.toFixed(1)}px, ${this.point.y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    for (const [id, node] of this.labelNodes) {
      if (seen.has(id)) continue;
      node.remove();
      this.labelNodes.delete(id);
    }
  }

  private updateScoreboard(core: ClientCore): void {
    const rows = this.scoreboardOn
      ? [...core.scoreboard].sort((a, b) => b.score - a.score || a.playerId - b.playerId)
      : [];
    const text = rows.map((row) => `${row.playerId}:${row.score}:${row.kills}`).join('|');
    if (text === this.scoreboardText) return;
    this.scoreboardText = text;
    this.scoreboard.replaceChildren(
      ...rows.map((row) => {
        const line = document.createElement('li');
        if (row.playerId === core.playerId) line.className = 'me';
        const name = document.createElement('span');
        name.textContent = nameOf(row.playerId, core.playerId);
        const score = document.createElement('span');
        score.textContent = `${number(row.score)}  ·  ${row.kills}`;
        line.append(name, score);
        return line;
      }),
    );
  }

  /**
   * The whole combat zone from above, north (+Z) up: the planet, the belt,
   * the edge of the zone, the own ship with its heading, and every other
   * ship the server has told this client about.
   */
  private drawMap(view: ShipView, remotes: readonly RemoteView[]): void {
    const context = this.map.getContext('2d');
    if (!context) return;
    const size = this.map.width;
    const half = size / 2;
    const scale = (half - 4) / SIM.combatZoneRadius;
    const px = (x: number): number => half + x * scale;
    const pz = (z: number): number => half - z * scale;
    context.clearRect(0, 0, size, size);

    // The belt, as a band.
    context.strokeStyle = 'rgb(150 170 200 / 28%)';
    context.lineWidth = (SIM.beltOuter - SIM.beltInner) * scale;
    context.beginPath();
    context.arc(half, half, ((SIM.beltInner + SIM.beltOuter) / 2) * scale, 0, Math.PI * 2);
    context.stroke();

    context.fillStyle = '#3355aa';
    context.beginPath();
    context.arc(half, half, SIM.planetRadius * scale, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = 'rgb(255 179 71 / 55%)';
    context.lineWidth = 1;
    context.beginPath();
    context.arc(half, half, SIM.combatZoneRadius * scale, 0, Math.PI * 2);
    context.stroke();

    context.fillStyle = '#ff6a5c';
    for (const remote of remotes) {
      if (!remote.alive) continue;
      context.beginPath();
      context.arc(px(remote.x), pz(remote.z), 2.5, 0, Math.PI * 2);
      context.fill();
    }

    if (!view.alive) return;
    // An arrowhead pointing where the nose points: forward is (sin yaw, cos yaw).
    context.save();
    context.translate(px(view.x), pz(view.z));
    context.rotate(view.yaw);
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.moveTo(0, -6);
    context.lineTo(4, 5);
    context.lineTo(0, 2.5);
    context.lineTo(-4, 5);
    context.closePath();
    context.fill();
    context.restore();
  }
}
