import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseFortReply, parseFortView } from '../../src/shared/fort.ts';
import { fortPlayerId } from '../../src/server/fort.ts';
import { MemoryPilotStore } from '../../src/server/pilots.ts';
import { startServer } from '../../src/server/server.ts';

const KEY = '0102030405060708090a0b0c0d0e0f10';
const STRANGER = 'ffeeddccbbaa99887766554433221100';
const SECRET = 'test-bridge-secret';

/** A fort as SpaceFort's server sends it. */
const FORT = {
  now: 1_800_000_000_000,
  currencies: { credits: 100, upgradePoints: 50, renown: 0 },
  crew: [
    {
      id: 'nft_1_1',
      name: 'Maya "Comet" Ranger',
      className: 'Space Recruit',
      level: 4,
      state: 'mission',
      until: 1_800_000_090_000,
      doing: 'Escort a convoy',
    },
    {
      id: 'nft_2_1',
      name: 'Ivan "Frost" Pilot',
      className: 'Tech Trainee',
      level: 3,
      state: 'ready',
      until: null,
      doing: null,
    },
  ],
  hold: {
    crates: [{ id: 'a'.repeat(24), tier: 'Rare', source: 'boss' }],
    itemCount: 1,
    items: [{ id: 'upg_1', name: 'Plasma Rifle', rarity: 'rare', slot: 'PRIMARY_WEAPON' }],
  },
  reports: [{ id: 'in_1', at: 1_799_999_000_000, title: 'Mission complete', detail: null }],
};

interface FakeFort {
  readonly url: string;
  readonly seen: { path: string; secret: string | undefined }[];
  close(): Promise<void>;
}

/** Stands in for SpaceFort's server, answering every request with `answer`. */
async function fakeFort(answer: () => { status: number; body: string }): Promise<FakeFort> {
  const seen: FakeFort['seen'] = [];
  const server: Server = createServer((request, response) => {
    const secret = request.headers['x-bridge-secret'];
    seen.push({ path: request.url ?? '', secret: typeof secret === 'string' ? secret : undefined });
    const { status, body } = answer();
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}

const ask = (port: number, pilotKey: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/api/fort`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pilotKey }),
  });

/** A store that already knows one pilot, as a server does after they have flown. */
function knownPilots(): MemoryPilotStore {
  const pilots = new MemoryPilotStore();
  pilots.save(KEY, { xp: 10, missionIndex: 0, missionProgress: 0, missionsDone: 0 });
  return pilots;
}

describe("the fort's name for a pilot", () => {
  it('is the same every time, differs by pilot and by secret, and does not contain the key', () => {
    const id = fortPlayerId(SECRET, KEY);
    expect(id).toMatch(/^pilot_[0-9a-f]{32}$/);
    expect(fortPlayerId(SECRET, KEY)).toBe(id);
    expect(fortPlayerId(SECRET, STRANGER)).not.toBe(id);
    expect(fortPlayerId('another-secret', KEY)).not.toBe(id);
    expect(id).not.toContain(KEY);
  });
});

describe('reading a fort over HTTP', () => {
  it('asks SpaceFort with the secret and the derived id, and passes the fort on', async () => {
    const fort = await fakeFort(() => ({
      status: 200,
      body: JSON.stringify({ ok: true, fort: FORT }),
    }));
    const server = await startServer({
      port: 0,
      pilots: knownPilots(),
      bridgeSecret: SECRET,
      fortUrl: fort.url,
    });
    try {
      const reply = await ask(server.port, KEY);
      expect(reply.status).toBe(200);
      expect(await reply.json()).toEqual({ ok: true, fort: FORT });
      expect(fort.seen).toEqual([
        { path: `/api/bridge/fort/${fortPlayerId(SECRET, KEY)}`, secret: SECRET },
      ]);
    } finally {
      await server.close();
      await fort.close();
    }
  });

  it('does not ask for a pilot the game has never seated, so forts cannot be made by inventing keys', async () => {
    const fort = await fakeFort(() => ({
      status: 200,
      body: JSON.stringify({ ok: true, fort: FORT }),
    }));
    const server = await startServer({
      port: 0,
      pilots: knownPilots(),
      bridgeSecret: SECRET,
      fortUrl: fort.url,
    });
    try {
      expect(await (await ask(server.port, STRANGER)).json()).toEqual({
        ok: false,
        reason: 'no-pilot',
      });
      expect((await ask(server.port, 'nonsense')).status).toBe(400);
      expect((await ask(server.port, 7)).status).toBe(400);
      expect(fort.seen).toEqual([]);
    } finally {
      await server.close();
      await fort.close();
    }
  });

  it('says the fort is off when the server has no fort or no secret', async () => {
    for (const options of [{}, { fortUrl: 'http://127.0.0.1:9' }, { bridgeSecret: SECRET }]) {
      const server = await startServer({ port: 0, pilots: knownPilots(), ...options });
      try {
        expect(await (await ask(server.port, KEY)).json()).toEqual({ ok: false, reason: 'off' });
      } finally {
        await server.close();
      }
    }
  });

  it('says the fort did not answer when it is down, refuses, or sends something else', async () => {
    const answers = [
      { status: 403, body: JSON.stringify({ ok: false, error: 'not allowed' }) },
      { status: 500, body: 'oops' },
      { status: 200, body: 'not json' },
      { status: 200, body: JSON.stringify({ ok: true, fort: { ...FORT, crew: 'everyone' } }) },
    ];
    for (const answer of answers) {
      const fort = await fakeFort(() => answer);
      const server = await startServer({
        port: 0,
        pilots: knownPilots(),
        bridgeSecret: SECRET,
        fortUrl: fort.url,
      });
      try {
        expect(await (await ask(server.port, KEY)).json()).toEqual({
          ok: false,
          reason: 'unreachable',
        });
      } finally {
        await server.close();
        await fort.close();
      }
    }
    // Nothing listening at all.
    const dead = await fakeFort(() => ({ status: 200, body: '{}' }));
    await dead.close();
    const server = await startServer({
      port: 0,
      pilots: knownPilots(),
      bridgeSecret: SECRET,
      fortUrl: dead.url,
    });
    try {
      expect(await (await ask(server.port, KEY)).json()).toEqual({
        ok: false,
        reason: 'unreachable',
      });
    } finally {
      await server.close();
    }
  });
});

describe('checking what the fort sent', () => {
  it('accepts a whole fort and keeps only the fields it knows', () => {
    expect(parseFortView(FORT)).toEqual(FORT);
    expect(parseFortView({ ...FORT, walletAddress: 'x' })).toEqual(FORT);
    expect(parseFortReply({ ok: true, fort: FORT })).toEqual({ ok: true, fort: FORT });
    expect(parseFortReply({ ok: false, reason: 'off' })).toEqual({ ok: false, reason: 'off' });
  });

  it('refuses a fort with a part missing or of the wrong kind', () => {
    const [first] = FORT.crew;
    const broken: unknown[] = [
      null,
      'fort',
      { ...FORT, now: -1 },
      { ...FORT, currencies: { ...FORT.currencies, credits: '100' } },
      { ...FORT, crew: [{ ...first, state: 'asleep' }] },
      { ...FORT, crew: [{ ...first, until: 'soon' }] },
      { ...FORT, crew: [{ ...first, name: '' }] },
      { ...FORT, hold: { ...FORT.hold, crates: [{ id: 'x' }] } },
      { ...FORT, reports: [{ id: 'in_1', at: 1, title: 7, detail: null }] },
      { ...FORT, hold: undefined },
    ];
    for (const value of broken) expect(parseFortView(value)).toBeNull();
    expect(parseFortReply({ ok: true, fort: null })).toBeNull();
    expect(parseFortReply({ ok: false, reason: 'because' })).toBeNull();
    expect(parseFortReply({ fort: FORT })).toBeNull();
  });
});
