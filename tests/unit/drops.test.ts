import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOSS_CRATE,
  CRATE_CHANCE,
  CRATE_TIERS,
  DAILY_CRATE_CAP,
  bossCrateChance,
  crateTier,
  tierOdds,
} from '../../src/shared/drops.ts';
import { FileCrateStore, MemoryCrateStore } from '../../src/server/crates.ts';
import { startServer } from '../../src/server/server.ts';

const KEY = '0102030405060708090a0b0c0d0e0f10';
const OTHER = 'ffeeddccbbaa99887766554433221100';
const DAY = 24 * 60 * 60 * 1000;

describe('crate odds', () => {
  it('every table adds up to the whole', () => {
    for (const source of ['orb', 'raider', 'boss'] as const) {
      expect(tierOdds(source).reduce((sum, odds) => sum + odds, 0)).toBe(10_000);
    }
  });

  it('a draw across the whole range gives each tier its share, to the ten-thousandth', () => {
    for (const source of ['orb', 'raider', 'boss'] as const) {
      const counts = CRATE_TIERS.map(() => 0);
      for (let i = 0; i < 10_000; i++) {
        const tier = CRATE_TIERS.indexOf(crateTier(source, i / 10_000));
        counts[tier] = (counts[tier] ?? 0) + 1;
      }
      expect(counts).toEqual(tierOdds(source));
    }
  });

  it('a legendary from a raider is about one kill in 300,000, and a raider never drops a mythic', () => {
    const legendary = CRATE_CHANCE.raider * ((tierOdds('raider')[3] ?? 0) / 10_000);
    expect(Math.round(1 / legendary)).toBe(300_000);
    expect(tierOdds('raider')[4]).toBe(0);
    expect(tierOdds('orb')[4]).toBe(0);
  });

  it('the boss pays more to a higher level, up to the cap, and at least half to a small share', () => {
    expect(bossCrateChance(1, 1)).toBeCloseTo(0.155);
    expect(bossCrateChance(20, 1)).toBeCloseTo(0.25);
    expect(bossCrateChance(50, 1)).toBeCloseTo(BOSS_CRATE.cap);
    expect(bossCrateChance(50, 0.05)).toBeCloseTo(BOSS_CRATE.cap / 2);
    expect(bossCrateChance(20, 0.8)).toBeCloseTo(0.2);
  });
});

describe('the crate store', () => {
  it('stops orb and raider crates at the daily cap, never the boss, and starts again the next day', () => {
    let now = 5 * DAY + 1000;
    const store = new MemoryCrateStore(() => now);
    for (let i = 0; i < DAILY_CRATE_CAP; i++) {
      expect(store.underCap(KEY)).toBe(true);
      store.add(KEY, 'Common', i % 2 ? 'orb' : 'raider', 3);
    }
    expect(store.underCap(KEY)).toBe(false);
    store.add(KEY, 'Epic', 'boss', 3);
    expect(store.underCap(KEY)).toBe(false);
    expect(store.underCap(OTHER)).toBe(true);
    expect(store.count(KEY)).toBe(DAILY_CRATE_CAP + 1);

    now += DAY;
    expect(store.underCap(KEY)).toBe(true);
    store.add(KEY, 'Common', 'orb', 3);
    expect(store.count(KEY)).toBe(DAILY_CRATE_CAP + 2);
  });

  it('a code moves everything held, once; the same code answers the same again; a wrong one nothing', () => {
    const now = 5 * DAY;
    const store = new MemoryCrateStore(() => now);
    expect(store.issueCode(KEY)).toBeNull();
    const first = store.add(KEY, 'Rare', 'orb', 7);
    const second = store.add(KEY, 'Legendary', 'boss', 7);
    const issued = store.issueCode(KEY);
    expect(issued).toMatchObject({ crates: 2 });
    expect(issued?.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(first.id).not.toBe(second.id);

    expect(store.redeem('AAAAAAAA')).toBeNull();
    const redeemed = store.redeem(issued?.code ?? '');
    expect(redeemed?.crates).toEqual([first, second]);
    expect(store.count(KEY)).toBe(0);

    // A crate won afterwards is not swept up by a retry of the old code.
    const later = store.add(KEY, 'Common', 'orb', 7);
    expect(store.redeem(issued?.code ?? '')?.crates).toEqual([first, second]);
    expect(store.pending(KEY)).toEqual([later]);
  });

  it('a code dies after ten minutes, and asking again kills the one before', () => {
    let now = 5 * DAY;
    const store = new MemoryCrateStore(() => now);
    store.add(KEY, 'Common', 'orb', 1);
    const old = store.issueCode(KEY);
    const fresh = store.issueCode(KEY);
    expect(store.redeem(old?.code ?? '')).toBeNull();
    now += 10 * 60 * 1000 + 1;
    expect(store.redeem(fresh?.code ?? '')).toBeNull();
    expect(store.count(KEY)).toBe(1);
  });

  it('kept in a file, crates survive a restart, and a file that is not crates stops the server', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'orbit-crates-'));
    try {
      const store = new FileCrateStore(directory);
      const crate = store.add(KEY, 'Epic', 'boss', 12);
      store.flush();
      expect(new FileCrateStore(directory).pending(KEY)).toEqual([crate]);

      writeFileSync(path.join(directory, 'crates.json'), JSON.stringify({ [KEY]: { crates: 3 } }));
      expect(() => new FileCrateStore(directory)).toThrow(/not a hold/);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});

describe('claiming over HTTP', () => {
  const post = (port: number, route: string, body: unknown, secret?: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-bridge-secret': secret } : {}),
      },
      body: JSON.stringify(body),
    });

  it('a pilot gets a code; only the holder of the bridge secret can redeem it', async () => {
    const crates = new MemoryCrateStore();
    const crate = crates.add(KEY, 'Rare', 'raider', 4);
    const server = await startServer({ port: 0, crates, bridgeSecret: 'test-bridge-secret' });
    try {
      expect((await post(server.port, '/api/claim-code', { pilotKey: 'nonsense' })).status).toBe(
        400,
      );
      expect(
        await (await post(server.port, '/api/claim-code', { pilotKey: OTHER })).json(),
      ).toEqual({
        ok: true,
        crates: 0,
      });
      const issued = (await (
        await post(server.port, '/api/claim-code', { pilotKey: KEY })
      ).json()) as {
        code: string;
      };

      expect((await post(server.port, '/api/redeem', { code: issued.code })).status).toBe(403);
      expect(
        (await post(server.port, '/api/redeem', { code: issued.code }, 'wrong-secret-value'))
          .status,
      ).toBe(403);
      expect(crates.count(KEY)).toBe(1);

      // As a player types it: lower case, with the dash.
      const typed = `${issued.code.slice(0, 4)}-${issued.code.slice(4)}`.toLowerCase();
      const redeemed = await post(
        server.port,
        '/api/redeem',
        { code: typed },
        'test-bridge-secret',
      );
      expect(await redeemed.json()).toEqual({ ok: true, code: issued.code, crates: [crate] });
      expect(crates.count(KEY)).toBe(0);
      expect(
        (await post(server.port, '/api/redeem', { code: 'ZZZZZZZZ' }, 'test-bridge-secret')).status,
      ).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('with no bridge secret set, nobody can redeem', async () => {
    const crates = new MemoryCrateStore();
    crates.add(KEY, 'Rare', 'raider', 4);
    const server = await startServer({ port: 0, crates });
    try {
      const code = crates.issueCode(KEY)?.code;
      expect((await post(server.port, '/api/redeem', { code })).status).toBe(403);
      expect((await post(server.port, '/api/redeem', { code }, '')).status).toBe(403);
      expect(crates.count(KEY)).toBe(1);
    } finally {
      await server.close();
    }
  });
});
