// Test-only record of what the server really simulated: where every ship was
// on every tick, and every hit and death it decided. The end-to-end tests
// compare what browsers drew against this.

import { maxSpeedOf } from '../shared/sim/ship.ts';
import type { DeathRecord, HitRecord, Room, RoomListener } from './room.ts';

/** One ship on one tick: x, y, z, speed, top speed in its state, alive (1 or 0), spawn number. */
export type TruthRow = [number, number, number, number, number, number, number];

export interface TruthTick {
  tick: number;
  ships: Record<number, TruthRow>;
}

export interface Truth {
  /** The server's tick when this was read. */
  tick: number;
  ticks: TruthTick[];
  hits: HitRecord[];
  deaths: DeathRecord[];
}

/** Ticks kept. Five minutes. */
const KEEP_TICKS = 5 * 60 * 60;

export class Recorder {
  readonly listener: RoomListener = {
    hit: (hit) => this.hits.push(hit),
    playerDied: (death) => this.deaths.push(death),
  };

  private readonly ticks: TruthTick[] = [];
  private readonly hits: HitRecord[] = [];
  private readonly deaths: DeathRecord[] = [];

  readonly onTick = (tick: number, room: Room): void => {
    const ships: Record<number, TruthRow> = {};
    for (const id of room.playerIds()) {
      const ship = room.shipOf(id);
      if (!ship) continue;
      ships[id] = [
        ship.x,
        ship.y,
        ship.z,
        ship.speed,
        maxSpeedOf(ship.boostTicks > 0),
        ship.alive ? 1 : 0,
        ship.spawnSeq,
      ];
    }
    this.ticks.push({ tick, ships });
    if (this.ticks.length > KEEP_TICKS) this.ticks.shift();
  };

  read(room: Room, fromTick: number, toTick: number): Truth {
    return {
      tick: room.tick,
      ticks: this.ticks.filter((entry) => entry.tick >= fromTick && entry.tick <= toTick),
      hits: this.hits.filter((hit) => hit.tick >= fromTick && hit.tick <= toTick),
      deaths: this.deaths.filter((death) => death.tick >= fromTick && death.tick <= toTick),
    };
  }
}
