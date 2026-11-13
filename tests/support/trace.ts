// A fixed, seeded run of the simulation that returns one hash of every state
// it passed through. Node, Chromium and WebKit must all return the same
// number: that is the evidence that prediction can match the server exactly.
//
// The run covers turning, pitching against the clamp, throttle, boost, the Y
// clamp, death on the planet and respawn.

import { encodeShipState } from '../../src/shared/protocol.ts';
import { Rng } from '../../src/shared/rng.ts';
import { quantiseControls, spawnShip, stepShip } from '../../src/shared/sim/ship.ts';
import type { Input, ShipState } from '../../src/shared/sim/ship.ts';

export interface TraceResult {
  hash: number;
  deaths: number;
  boostTicks: number;
  final: ShipState;
}

function mix(hash: number, bytes: Uint8Array): number {
  let h = hash;
  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function runTrace(seed: number, ticks: number): TraceResult {
  const rng = new Rng(seed);
  // Start 400 units above the kill radius, flying at the planet, so the run
  // reaches a death and a respawn early.
  let ship: ShipState = { ...spawnShip(rng, 0), x: 0, y: 0, z: -1620 };
  let input: Input = quantiseControls({ yaw: 0, pitch: 0, throttle: 1 });
  let hash = 0x811c9dc5;
  let deaths = 0;
  let boostTicks = 0;

  for (let tick = 1; tick <= ticks; tick++) {
    // Hold each input for a random 1 to 40 ticks, as a player would.
    if (tick > 600 && rng.next() < 0.05) {
      input = quantiseControls({
        yaw: rng.next() * 2.4 - 1.2,
        pitch: rng.next() * 2.4 - 1.2,
        throttle: Math.floor(rng.next() * 3) - 1,
      });
    }
    if (ship.alive && tick % 1500 === 0) ship = { ...ship, boostTicks: 180 + (tick % 181) };

    const wasAlive = ship.alive;
    ship = stepShip(ship, input);
    if (wasAlive && !ship.alive) deaths++;
    if (ship.boostTicks > 0) boostTicks++;
    if (!ship.alive && ship.respawnTicks === 0) ship = spawnShip(rng, ship.spawnSeq + 1);

    hash = mix(hash, encodeShipState(ship));
  }
  return { hash, deaths, boostTicks, final: ship };
}
