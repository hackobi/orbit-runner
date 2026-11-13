import { describe, expect, it } from 'vitest';
import { SIM } from '../../src/shared/constants.ts';
import { Rng } from '../../src/shared/rng.ts';
import {
  BULLET_HIT_DISTANCE,
  BULLET_STEP,
  bulletExpired,
  bulletHit,
  bulletTravel,
  spawnBullet,
} from '../../src/shared/sim/bullets.ts';
import {
  damageShip,
  destroyShip,
  firedThisTick,
  quantiseControls,
  spawnShip,
  stepShip,
} from '../../src/shared/sim/ship.ts';
import type { ShipState } from '../../src/shared/sim/ship.ts';

const FIRE = quantiseControls({ yaw: 0, pitch: 0, throttle: 0, fire: true });
const HOLD = quantiseControls({ yaw: 0, pitch: 0, throttle: 0, fire: false });

function shipAt(z: number, overrides: Partial<ShipState> = {}): ShipState {
  return { ...spawnShip(new Rng(1), 0), x: 0, y: 0, z, invulnTicks: 0, ...overrides };
}

describe('the gun (v1 main.js:8837-8841, 6014-6050)', () => {
  it('fires every 7 ticks while the button is held', () => {
    let ship = shipAt(4000);
    const fired: number[] = [];
    for (let tick = 1; tick <= 70; tick++) {
      ship = stepShip(ship, FIRE);
      if (firedThisTick(ship)) fired.push(tick);
    }
    expect(fired).toEqual([1, 8, 15, 22, 29, 36, 43, 50, 57, 64]);
  });

  it('does not fire without the button, and a tap fires once', () => {
    let ship = shipAt(4000);
    let shots = 0;
    for (let tick = 1; tick <= 30; tick++) {
      ship = stepShip(ship, tick === 10 ? FIRE : HOLD);
      if (firedThisTick(ship)) shots++;
    }
    expect(shots).toBe(1);
  });

  it('a dead ship cannot fire', () => {
    const dead = destroyShip(shipAt(4000));
    expect(firedThisTick(stepShip(dead, FIRE))).toBe(false);
  });

  it('a bullet starts 1.8 units ahead of the nose and flies 230 u/s along it, ignoring roll', () => {
    const ship = shipAt(4000, { yaw: Math.PI / 2, pitch: 0, roll: 0.6 });
    const bullet = spawnBullet(3, 100, ship);
    expect(bullet.ox).toBeCloseTo(1.8, 9);
    expect(bullet.oz).toBeCloseTo(4000, 9);
    expect(bullet.dx).toBeCloseTo(1, 12);
    expect(bullet.dy).toBeCloseTo(0, 12);
    expect(bullet.dz).toBeCloseTo(0, 12);
    expect(bulletTravel(bullet, 160)).toBeCloseTo(230, 9);
    expect(BULLET_STEP).toBeCloseTo(230 / 60, 12);
  });

  it('a bullet lasts 180 ticks: 690 units of range', () => {
    const bullet = spawnBullet(0, 100, shipAt(4000));
    expect(bulletExpired(bullet, 279)).toBe(false);
    expect(bulletExpired(bullet, 280)).toBe(true);
    expect(SIM.bulletLifeTicks * BULLET_STEP).toBeCloseTo(690, 9);
  });
});

describe('bullet against ship', () => {
  const bullet = spawnBullet(0, 100, shipAt(4000)); // flying +Z from z = 4001.8

  it('hits when a ship is on the path, on the tick the path reaches it', () => {
    // Centre at z = 4050: contact begins 2.25 short of it.
    const hits: number[] = [];
    for (let tick = 100; tick < 130; tick++) {
      if (bulletHit(bullet, tick, 0, 0, 4050) >= 0) hits.push(tick);
    }
    const contactAt = (4050 - BULLET_HIT_DISTANCE - 4001.8) / BULLET_STEP;
    expect(hits[0]).toBe(100 + Math.ceil(contactAt));
  });

  it('reports how far along the tick the contact is', () => {
    const tick = 112;
    const startOfTick = 4001.8 + 11 * BULLET_STEP;
    const centre = startOfTick + BULLET_HIT_DISTANCE + BULLET_STEP / 2;
    expect(bulletHit(bullet, tick, 0, 0, centre)).toBeCloseTo(0.5, 9);
  });

  it('never tunnels: a ship between two tick positions is still hit', () => {
    // Sweep a target along the whole range in small steps; every placement
    // on the path must be hit on some tick.
    for (let z = 4004; z < 4690; z += 0.37) {
      let hit = false;
      for (let tick = 100; tick < 280 && !hit; tick++) hit = bulletHit(bullet, tick, 0, 0, z) >= 0;
      expect(hit, `target at z=${z}`).toBe(true);
    }
  });

  it('a grazing pass just inside 2.25 units hits; just outside misses', () => {
    const anyTick = (offset: number): boolean => {
      for (let tick = 100; tick < 280; tick++) {
        if (bulletHit(bullet, tick, offset, 0, 4300) >= 0) return true;
      }
      return false;
    };
    expect(anyTick(BULLET_HIT_DISTANCE - 0.001)).toBe(true);
    expect(anyTick(BULLET_HIT_DISTANCE + 0.001)).toBe(false);
  });

  it('does not hit what is behind it or beyond its reach this tick', () => {
    expect(bulletHit(bullet, 110, 0, 0, 3990)).toBe(-1);
    expect(bulletHit(bullet, 101, 0, 0, 4300)).toBe(-1);
  });

  it('on the tick it is fired, covers the gap from the ship to the muzzle', () => {
    expect(bulletHit(bullet, 100, 0, 0, 4003)).toBeGreaterThanOrEqual(0);
    expect(bulletHit(bullet, 100, 0, 0, 4010)).toBe(-1);
  });
});

describe('damage (v1 main.js:9872, server:3086-3102)', () => {
  it('takes 15 per bullet and dies on the seventh', () => {
    let ship = shipAt(4000);
    for (let i = 1; i <= 6; i++) {
      ship = damageShip(ship, SIM.bulletDamage);
      expect(ship.hp).toBe(100 - 15 * i);
      expect(ship.alive).toBe(true);
    }
    ship = damageShip(ship, SIM.bulletDamage);
    expect(ship).toMatchObject({ alive: false, hp: 0, respawnTicks: SIM.respawnTicks });
  });

  it('a fresh ship is protected for 78 ticks', () => {
    let ship = spawnShip(new Rng(1), 0);
    expect(ship.invulnTicks).toBe(78);
    expect(damageShip(ship, 50)).toBe(ship);
    for (let i = 0; i < 78; i++) ship = stepShip(ship, HOLD);
    expect(ship.invulnTicks).toBe(0);
    expect(damageShip(ship, 50).hp).toBe(50);
  });

  it('damage to a dead ship does nothing', () => {
    const dead = destroyShip(shipAt(4000));
    expect(damageShip(dead, 15)).toBe(dead);
  });
});
