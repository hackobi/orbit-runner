import { describe, expect, it } from 'vitest';
import { shouldApplyUpdate } from '../../src/client/updatePolicy.ts';
import { SIM, TICK_MS } from '../../src/shared/constants.ts';
import { TestWorld } from '../support/harness.ts';

describe('loading a new version', () => {
  it('never happens while the ship is flying', () => {
    expect(shouldApplyUpdate(true, 'playing', true, false)).toBe(false);
  });

  it('happens between lives, and whenever there is no game to interrupt', () => {
    expect(shouldApplyUpdate(true, 'playing', false, false)).toBe(true);
    for (const status of ['connecting', 'away', 'closed', 'rejected'] as const) {
      expect(shouldApplyUpdate(true, status, false, false)).toBe(true);
    }
  });

  it('waits while the fort is open, whatever else is true', () => {
    expect(shouldApplyUpdate(true, 'playing', false, true)).toBe(false);
    for (const status of ['connecting', 'away', 'closed', 'rejected'] as const) {
      expect(shouldApplyUpdate(true, status, false, true)).toBe(false);
    }
  });

  it('does nothing when no new version is waiting', () => {
    expect(shouldApplyUpdate(false, 'playing', false, false)).toBe(false);
    expect(shouldApplyUpdate(false, 'closed', false, false)).toBe(false);
  });
});

describe('a page that reloads (as an update does)', () => {
  it('comes back to the same seat, ship and points if it presents the token it was given', () => {
    const world = new TestWorld(8, 0, false);
    let kept: Uint8Array | null = null;
    const first = world.addSession({
      onSessionToken: (token) => {
        kept = token;
      },
    });
    world.run(1000);
    const id = first.session.core.playerId;
    expect(kept).not.toBeNull();
    world.room.addScore(id, 4321);
    world.place(id, { x: 0, y: 400, z: 7000, hp: 55 });

    // The page goes away, and the new one arrives two seconds later.
    first.session.close();
    world.run(2000);
    const second = world.addSession({ sessionToken: kept });
    world.run(1000);

    expect(second.session.core.status).toBe('playing');
    expect(second.session.core.playerId).toBe(id);
    expect(world.room.playerCount).toBe(1);
    expect(second.session.core.state).toMatchObject({ hp: 55, alive: true });
    expect(second.session.core.score).toBe(4321);
    expect(world.deaths).toHaveLength(0);
  });

  it('after longer than ten seconds the ship was destroyed, but the seat and points are kept', () => {
    const world = new TestWorld(8, 0, false);
    let kept: Uint8Array | null = null;
    const first = world.addSession({
      onSessionToken: (token) => {
        kept = token;
      },
    });
    world.run(1000);
    const id = first.session.core.playerId;
    world.room.addScore(id, 4321);
    first.session.close();
    world.run(12_000 + SIM.respawnTicks * TICK_MS);
    expect(world.deaths).toHaveLength(1);
    const second = world.addSession({ sessionToken: kept });
    world.run(1000);
    expect(second.session.core.status).toBe('playing');
    expect(second.session.core.playerId).toBe(id);
    expect(second.session.core.score).toBeGreaterThanOrEqual(4321);
    // Their ship went while the page was gone: they are in the fort until they launch.
    expect(second.session.core.fort).toBe(true);
    second.session.core.setFort(false);
    world.run(500);
    expect(second.session.core.state?.alive).toBe(true);
  });
});
