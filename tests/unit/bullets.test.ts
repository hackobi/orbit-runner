import { describe, expect, it } from 'vitest';
import { SIM } from '../../src/shared/constants.ts';
import { Rng } from '../../src/shared/rng.ts';
import {
  BULLET_HIT_DISTANCE,
  BULLET_STEP,
  bulletDamage,
  bulletExpired,
  bulletHit,
  bulletTravel,
  shipHitDistance,
  spawnBullet,
} from '../../src/shared/sim/bullets.ts';
import type { Bullet } from '../../src/shared/sim/bullets.ts';
import {
  damageShip,
  destroyShip,
  shotThisTick,
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

/** The path a bullet covers in a tick against a ship at a point. */
const shipHit = (bullet: Bullet, tick: number, x: number, y: number, z: number): number =>
  bulletHit(bullet, tick, x, y, z, shipHitDistance(bullet));

describe('the gun (v1 main.js:8837-8841, 6014-6050)', () => {
  it('fires every 7 ticks while the button is held', () => {
    let ship = shipAt(4000);
    const fired: number[] = [];
    for (let tick = 1; tick <= 70; tick++) {
      ship = stepShip(ship, FIRE);
      if (shotThisTick(ship) === 'bullet') fired.push(tick);
    }
    expect(fired).toEqual([1, 8, 15, 22, 29, 36, 43, 50, 57, 64]);
  });

  it('does not fire without the button, and a tap fires once', () => {
    let ship = shipAt(4000);
    let shots = 0;
    for (let tick = 1; tick <= 30; tick++) {
      ship = stepShip(ship, tick === 10 ? FIRE : HOLD);
      if (shotThisTick(ship)) shots++;
    }
    expect(shots).toBe(1);
  });

  it('a dead ship cannot fire', () => {
    const dead = destroyShip(shipAt(4000));
    expect(shotThisTick(stepShip(dead, FIRE))).toBeNull();
  });

  it('a bullet starts 1.8 units ahead of the nose and flies 230 u/s along it, ignoring roll', () => {
    const ship = shipAt(4000, { yaw: Math.PI / 2, pitch: 0, roll: 0.6 });
    const bullet = spawnBullet(3, 100, ship, 'bullet');
    expect(bullet.ox).toBeCloseTo(1.8, 9);
    expect(bullet.oz).toBeCloseTo(4000, 9);
    expect(bullet.dx).toBeCloseTo(1, 12);
    expect(bullet.dy).toBeCloseTo(0, 12);
    expect(bullet.dz).toBeCloseTo(0, 12);
    expect(bulletTravel(bullet, 160)).toBeCloseTo(230, 9);
    expect(BULLET_STEP).toBeCloseTo(230 / 60, 12);
  });

  it('a bullet lasts 180 ticks: 690 units of range', () => {
    const bullet = spawnBullet(0, 100, shipAt(4000), 'bullet');
    expect(bulletExpired(bullet, 279)).toBe(false);
    expect(bulletExpired(bullet, 280)).toBe(true);
    expect(SIM.bulletLifeTicks * BULLET_STEP).toBeCloseTo(690, 9);
  });
});

describe('bullet against ship', () => {
  const bullet = spawnBullet(0, 100, shipAt(4000), 'bullet'); // flying +Z from z = 4001.8

  it('hits when a ship is on the path, on the tick the path reaches it', () => {
    // Centre at z = 4050: contact begins 2.25 short of it.
    const hits: number[] = [];
    for (let tick = 100; tick < 130; tick++) {
      if (shipHit(bullet, tick, 0, 0, 4050) >= 0) hits.push(tick);
    }
    const contactAt = (4050 - BULLET_HIT_DISTANCE - 4001.8) / BULLET_STEP;
    expect(hits[0]).toBe(100 + Math.ceil(contactAt));
  });

  it('reports how far along the tick the contact is', () => {
    const tick = 112;
    const startOfTick = 4001.8 + 11 * BULLET_STEP;
    const centre = startOfTick + BULLET_HIT_DISTANCE + BULLET_STEP / 2;
    expect(shipHit(bullet, tick, 0, 0, centre)).toBeCloseTo(0.5, 9);
  });

  it('never tunnels: a ship between two tick positions is still hit', () => {
    // Sweep a target along the whole range in small steps; every placement
    // on the path must be hit on some tick.
    for (let z = 4004; z < 4690; z += 0.37) {
      let hit = false;
      for (let tick = 100; tick < 280 && !hit; tick++) hit = shipHit(bullet, tick, 0, 0, z) >= 0;
      expect(hit, `target at z=${z}`).toBe(true);
    }
  });

  it('a grazing pass just inside 2.25 units hits; just outside misses', () => {
    const anyTick = (offset: number): boolean => {
      for (let tick = 100; tick < 280; tick++) {
        if (shipHit(bullet, tick, offset, 0, 4300) >= 0) return true;
      }
      return false;
    };
    expect(anyTick(BULLET_HIT_DISTANCE - 0.001)).toBe(true);
    expect(anyTick(BULLET_HIT_DISTANCE + 0.001)).toBe(false);
  });

  it('does not hit what is behind it or beyond its reach this tick', () => {
    expect(shipHit(bullet, 110, 0, 0, 3990)).toBe(-1);
    expect(shipHit(bullet, 101, 0, 0, 4300)).toBe(-1);
  });

  it('on the tick it is fired, covers the gap from the ship to the muzzle', () => {
    expect(shipHit(bullet, 100, 0, 0, 4003)).toBeGreaterThanOrEqual(0);
    expect(shipHit(bullet, 100, 0, 0, 4010)).toBe(-1);
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

describe('the heavy shot (decision D22)', () => {
  const HEAVY = quantiseControls({ yaw: 0, pitch: 0, throttle: 0, fire: true, heavy: true });

  it('a ship carries two a life, a second apart, and the gun waits its turn', () => {
    let ship = shipAt(4000);
    const shots: [number, string][] = [];
    for (let tick = 1; tick <= 200; tick++) {
      ship = stepShip(ship, HEAVY);
      const shot = shotThisTick(ship);
      if (shot) shots.push([tick, shot]);
    }
    expect(shots.filter(([, shot]) => shot === 'heavy')).toEqual([
      [1, 'heavy'],
      [61, 'heavy'],
    ]);
    // The gun fires on the tick after the heavy shot, and then every 7 as ever.
    expect(shots.slice(0, 3)).toEqual([
      [1, 'heavy'],
      [2, 'bullet'],
      [9, 'bullet'],
    ]);
    expect(ship.heavyAmmo).toBe(0);
    expect(spawnShip(new Rng(2), 1).heavyAmmo).toBe(2);
  });

  it('a Fenix fires the same heavy shot', () => {
    expect(shotThisTick(stepShip(shipAt(4000, { fenix: true }), HEAVY))).toBe('heavy');
  });

  const heavy = spawnBullet(0, 100, shipAt(4000), 'heavy');

  it('flies 150 u/s for 500 units and does 60 damage', () => {
    expect(bulletTravel(heavy, 160)).toBeCloseTo(150, 9);
    expect(bulletExpired(heavy, 299)).toBe(false);
    expect(bulletExpired(heavy, 300)).toBe(true);
    expect(bulletDamage(heavy)).toBe(60);
  });

  it('is fat: it hits a ship 3.4 units off its line, and misses one 3.6 off', () => {
    const anyTick = (offset: number): boolean => {
      for (let tick = 100; tick < 300; tick++) {
        if (shipHit(heavy, tick, offset, 0, 4300) >= 0) return true;
      }
      return false;
    };
    expect(anyTick(3.4)).toBe(true);
    expect(anyTick(3.6)).toBe(false);
  });
});

describe('the Fenix beam (v1 main.js:353-354, 6023-6039, 9872)', () => {
  const beam = spawnBullet(0, 100, shipAt(4000, { fenix: true }), 'beam'); // flying +Z from z = 4001.8

  it('a Fenix fires beams; any other ship fires bullets', () => {
    expect(shotThisTick(stepShip(shipAt(4000, { fenix: true }), FIRE))).toBe('beam');
    expect(shotThisTick(stepShip(shipAt(4000), FIRE))).toBe('bullet');
  });

  it('flies 300 u/s for 155 ticks and does 30 damage', () => {
    expect(bulletTravel(beam, 160)).toBeCloseTo(300, 9);
    expect(bulletExpired(beam, 254)).toBe(false);
    expect(bulletExpired(beam, 255)).toBe(true);
    expect(bulletDamage(beam)).toBe(30);
    expect(bulletDamage(spawnBullet(0, 100, shipAt(4000), 'bullet'))).toBe(15);
  });

  it('is fatter: it hits a ship 2.45 units off its line, where a bullet needs 2.25', () => {
    const anyTick = (offset: number): boolean => {
      for (let tick = 100; tick < 255; tick++) {
        if (shipHit(beam, tick, offset, 0, 4300) >= 0) return true;
      }
      return false;
    };
    expect(shipHitDistance(beam)).toBeCloseTo(2.45, 12);
    expect(anyTick(2.449)).toBe(true);
    expect(anyTick(2.451)).toBe(false);
  });

  it('never tunnels at its longer step either', () => {
    // Its reach: 1.8 to the muzzle, 154 steps of 5, and 2.45 to a ship's centre.
    for (let z = 4004; z < 4774; z += 0.41) {
      let hit = false;
      for (let tick = 100; tick < 255 && !hit; tick++) hit = shipHit(beam, tick, 0, 0, z) >= 0;
      expect(hit, `target at z=${z}`).toBe(true);
    }
  });
});
