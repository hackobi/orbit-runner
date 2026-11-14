// What a client believes about the world's rocks and orbs: what the server
// has announced, and on top of it what the client predicts and has not heard
// back about yet (the rocks its own ship crashed into, the orbs it flew
// through, and whatever its own bullets hit).

import { WorldLedger } from '../shared/sim/world.ts';
import type { World, WorldState } from '../shared/sim/world.ts';

export type WorldThing = 'asteroid' | 'orb';

/** Predictions about one kind of thing. Id → the tick it is predicted to have gone. */
class Predictions {
  /** By the own ship's flight. Rebuilt whenever the prediction is replayed. */
  readonly contacts = new Map<number, number>();
  /** By the own bullets. Each belongs to a bullet, which takes it back if it is discarded. */
  readonly shots = new Map<number, number>();

  gone(id: number, tick: number): boolean {
    const contact = this.contacts.get(id);
    if (contact !== undefined && contact <= tick) return true;
    const shot = this.shots.get(id);
    return shot !== undefined && shot <= tick;
  }

  settle(serverTick: number): void {
    for (const [id, tick] of this.contacts) if (tick <= serverTick) this.contacts.delete(id);
    for (const [id, tick] of this.shots) if (tick <= serverTick) this.shots.delete(id);
  }

  clear(): void {
    this.contacts.clear();
    this.shots.clear();
  }
}

export class PredictedWorld implements WorldState {
  private ledger: WorldLedger;
  private readonly asteroids = new Predictions();
  private readonly orbs = new Predictions();

  constructor(world: World) {
    this.ledger = new WorldLedger(world);
  }

  /** Forget everything. The server tells a client the state of the world after each welcome. */
  reset(world: World): void {
    this.ledger = new WorldLedger(world);
    this.asteroids.clear();
    this.orbs.clear();
  }

  asteroidGone(id: number, tick: number): boolean {
    return this.ledger.asteroidGone(id, tick) || this.asteroids.gone(id, tick);
  }

  orbGone(id: number, tick: number): boolean {
    return this.ledger.orbGone(id, tick) || this.orbs.gone(id, tick);
  }

  private of(thing: WorldThing): Predictions {
    return thing === 'asteroid' ? this.asteroids : this.orbs;
  }

  /** The own ship is predicted to have crashed into a rock or flown through an orb. */
  predictContact(thing: WorldThing, id: number, tick: number): void {
    this.of(thing).contacts.set(id, tick);
  }

  /** One of the own bullets is predicted to have hit a rock or an orb. */
  predictShot(thing: WorldThing, id: number, tick: number): void {
    this.of(thing).shots.set(id, tick);
  }

  forgetShot(thing: WorldThing, id: number): void {
    this.of(thing).shots.delete(id);
  }

  /** The predictions made by flying are about to be made again by a replay. */
  forgetContacts(): void {
    this.asteroids.contacts.clear();
    this.orbs.contacts.clear();
  }

  /** The server has announced that this thing went at this tick. */
  confirm(thing: WorldThing, id: number, tick: number): void {
    if (thing === 'asteroid') this.ledger.asteroids.remove(id, tick);
    else this.ledger.orbs.remove(id, tick);
    const predictions = this.of(thing);
    predictions.contacts.delete(id);
    predictions.shots.delete(id);
  }

  /**
   * The server announces every change to the world before the snapshot of
   * the tick it happened on. A prediction from that tick or earlier that is
   * still waiting was wrong.
   */
  settle(serverTick: number): void {
    this.asteroids.settle(serverTick);
    this.orbs.settle(serverTick);
  }
}
