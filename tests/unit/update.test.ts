import { describe, expect, it } from 'vitest';
import { shouldApplyUpdate } from '../../src/client/updatePolicy.ts';
import { SIM, TICK_MS } from '../../src/shared/constants.ts';
import { TestWorld } from '../support/harness.ts';

describe('loading a new version', () => {
  it('never happens while the ship is flying', () => {
    expect(shouldApplyUpdate(true, 'playing', true)).toBe(false);
  });

  it('happens between lives, and whenever there is no game to interrupt', () => {
    expect(shouldApplyUpdate(true, 'playing', false)).toBe(true);
    for (const status of ['connecting', 'away', 'closed', 'rejected'] as const) {
      expect(shouldApplyUpdate(true, status, false)).toBe(true);
    }
  });

  it('does nothing when no new version is waiting', () => {
    expect(shouldApplyUpdate(false, 'playing', false)).toBe(false);
    expect(shouldApplyUpdate(false, 'closed', false)).toBe(false);
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

  it('starts afresh if it took longer than the ten seconds a seat is held', () => {
    const world = new TestWorld(8, 0, false);
    let kept: Uint8Array | null = null;
    const first = world.addSession({
      onSessionToken: (token) => {
        kept = token;
      },
    });
    world.run(1000);
    world.room.addScore(first.session.core.playerId, 4321);
    first.session.close();
    world.run(12_000 + SIM.respawnTicks * TICK_MS);
    const second = world.addSession({ sessionToken: kept });
    world.run(1000);
    expect(second.session.core.status).toBe('playing');
    expect(second.session.core.score).toBe(0);
  });
});
