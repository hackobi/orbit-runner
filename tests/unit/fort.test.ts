import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  parseFortOrder,
  parseFortOrderReply,
  parseFortReply,
  parseFortView,
} from '../../src/shared/fort.ts';
import { MemoryCrateStore } from '../../src/server/crates.ts';
import { fortPlayerId } from '../../src/server/fort.ts';
import { MemoryPilotStore } from '../../src/server/pilots.ts';
import { startServer } from '../../src/server/server.ts';

const KEY = '0102030405060708090a0b0c0d0e0f10';
const STRANGER = 'ffeeddccbbaa99887766554433221100';
const SECRET = 'test-bridge-secret';
const ID_KEY = 'test-fort-id-key';

const GEAR = [
  { slot: 'PRIMARY_WEAPON', item: null },
  { slot: 'SECONDARY_WEAPON', item: null },
  { slot: 'ARMOR_SYSTEM', item: null },
  { slot: 'UTILITY_MODULE', item: null },
];

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
      experience: 30,
      nextLevel: 150,
      state: 'mission',
      until: 1_800_000_090_000,
      doing: 'Escort a convoy',
      points: 0,
      skills: [{ name: 'COMBAT', value: 12 }],
      gear: [
        { slot: 'PRIMARY_WEAPON', item: { id: 'upg_0', name: 'Basic Rifle', rarity: 'common' } },
        ...GEAR.slice(1),
      ],
    },
    {
      id: 'nft_2_1',
      name: 'Ivan "Frost" Pilot',
      className: 'Tech Trainee',
      level: 3,
      experience: 30,
      nextLevel: 150,
      state: 'ready',
      until: null,
      doing: null,
      points: 3,
      skills: [
        { name: 'ENGINEERING', value: 9 },
        { name: 'SENSORS', value: 4 },
      ],
      gear: GEAR,
    },
  ],
  hold: {
    crates: [{ id: 'a'.repeat(24), tier: 'Rare', source: 'boss' }],
    itemCount: 1,
    items: [
      {
        id: 'upg_1',
        name: 'Plasma Rifle',
        rarity: 'rare',
        slot: 'PRIMARY_WEAPON',
        bonus: 20,
        wornBy: null,
        fits: ['nft_1_1'],
      },
    ],
  },
  bunks: [
    { price: 400, level: 4 },
    { price: 900, level: 7 },
  ],
  jobs: [
    {
      id: 'task_7_1',
      title: 'Sweep the outer beacons',
      rarity: 'common',
      lasts: 240_000,
      cost: 0,
      pays: { credits: 30, upgradePoints: 2, experience: 40 },
      open: ['nft_1_1', 'nft_2_1'],
    },
  ],
  reports: [{ id: 'in_1', at: 1_799_999_000_000, title: 'Mission complete', detail: null }],
};

interface Seen {
  path: string;
  secret: string | undefined;
  /** What was sent with it, for a request that carried anything. */
  body?: unknown;
}

interface FakeFort {
  readonly url: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

/** Stands in for SpaceFort's server, answering every request with `answer`. */
async function fakeFort(
  answer: (request: Seen) => { status: number; body: string },
): Promise<FakeFort> {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const secret = request.headers['x-bridge-secret'];
    let sent = '';
    request.on('data', (chunk: Buffer) => (sent += chunk.toString()));
    request.on('end', () => {
      const entry: Seen = {
        path: request.url ?? '',
        secret: typeof secret === 'string' ? secret : undefined,
        ...(sent ? { body: JSON.parse(sent) as unknown } : {}),
      };
      seen.push(entry);
      const { status, body } = answer(entry);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    });
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

const order = (port: number, pilotKey: unknown, sent: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/api/fort/order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pilotKey, order: sent }),
  });

describe("the fort's name for a pilot", () => {
  it('is the same every time, differs by pilot and by key, and does not contain the pilot key', () => {
    const id = fortPlayerId(ID_KEY, KEY);
    expect(id).toMatch(/^pilot_[0-9a-f]{32}$/);
    expect(fortPlayerId(ID_KEY, KEY)).toBe(id);
    expect(fortPlayerId(ID_KEY, STRANGER)).not.toBe(id);
    expect(fortPlayerId('another-key', KEY)).not.toBe(id);
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
      fortIdKey: ID_KEY,
      fortUrl: fort.url,
    });
    try {
      const reply = await ask(server.port, KEY);
      expect(reply.status).toBe(200);
      expect(await reply.json()).toEqual({ ok: true, fort: FORT });
      expect(fort.seen).toEqual([
        { path: `/api/bridge/fort/${fortPlayerId(ID_KEY, KEY)}`, secret: SECRET },
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
      fortIdKey: ID_KEY,
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

  it('says the fort is off when the server has no fort, no secret or no key for fort names', async () => {
    const url = 'http://127.0.0.1:9';
    for (const options of [
      {},
      { fortUrl: url },
      { bridgeSecret: SECRET },
      { fortUrl: url, bridgeSecret: SECRET },
      { fortUrl: url, fortIdKey: ID_KEY },
    ]) {
      const server = await startServer({ port: 0, pilots: knownPilots(), ...options });
      try {
        expect(await (await ask(server.port, KEY)).json()).toEqual({ ok: false, reason: 'off' });
        expect(
          await (await order(server.port, KEY, { kind: 'open', crateId: 'c' })).json(),
        ).toEqual({ ok: false, reason: 'off' });
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
        fortIdKey: ID_KEY,
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
      fortIdKey: ID_KEY,
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

describe('the bridge secret and the key for fort names are separate', () => {
  it('a new bridge secret leaves every pilot with the fort they had', async () => {
    const paths: string[] = [];
    for (const secret of [SECRET, 'a-new-bridge-secret']) {
      const fort = await fakeFort(() => ({
        status: 200,
        body: JSON.stringify({ ok: true, fort: FORT }),
      }));
      const server = await startServer({
        port: 0,
        pilots: knownPilots(),
        bridgeSecret: secret,
        fortIdKey: ID_KEY,
        fortUrl: fort.url,
      });
      try {
        await ask(server.port, KEY);
        expect(fort.seen[0]?.secret).toBe(secret);
        paths.push(fort.seen[0]?.path ?? '');
      } finally {
        await server.close();
        await fort.close();
      }
    }
    expect(paths[0]).toBe(paths[1]);
  });
});

describe('orders', () => {
  const DONE = { ok: true, message: 'Rare Plasma Rifle' };
  const answering = () =>
    fakeFort(() => ({ status: 200, body: JSON.stringify({ ok: true, done: DONE, fort: FORT }) }));
  const serving = (fort: FakeFort, crates?: MemoryCrateStore) =>
    startServer({
      port: 0,
      pilots: knownPilots(),
      bridgeSecret: SECRET,
      fortIdKey: ID_KEY,
      fortUrl: fort.url,
      ...(crates ? { crates } : {}),
    });

  it("carries an order to the pilot's own fort and brings back how it went and the fort after", async () => {
    const fort = await answering();
    const server = await serving(fort);
    try {
      const sent = { kind: 'open', crateId: 'a'.repeat(24) };
      const reply = await order(server.port, KEY, { ...sent, playerId: 'somebody-else' });
      expect(await reply.json()).toEqual({ ok: true, done: DONE, fort: FORT });
      // Only the order's own fields went on, to the id made from the pilot's key.
      expect(fort.seen).toEqual([
        {
          path: `/api/bridge/fort/${fortPlayerId(ID_KEY, KEY)}/order`,
          secret: SECRET,
          body: sent,
        },
      ]);
    } finally {
      await server.close();
      await fort.close();
    }
  });

  it("puts the pilot's level on a recruit order itself, whatever the page sent", async () => {
    const fort = await answering();
    // 900 experience is level 4; the page claims 50.
    const pilots = new MemoryPilotStore();
    pilots.save(KEY, { xp: 900, missionIndex: 0, missionProgress: 0, missionsDone: 0 });
    const server = await startServer({
      port: 0,
      pilots,
      bridgeSecret: SECRET,
      fortIdKey: ID_KEY,
      fortUrl: fort.url,
    });
    try {
      await order(server.port, KEY, { kind: 'recruit', pilotLevel: 50, price: 0 });
      await order(server.port, KEY, { kind: 'trainAll', unitId: 'u1', pilotLevel: 50 });
      expect(fort.seen.map((seen) => seen.body)).toEqual([
        { kind: 'recruit', pilotLevel: 4 },
        { kind: 'trainAll', unitId: 'u1' },
      ]);
    } finally {
      await server.close();
      await fort.close();
    }
  });

  it('passes nothing on that is not an order, or that comes from a pilot it does not know', async () => {
    const fort = await answering();
    const server = await serving(fort);
    try {
      for (const sent of [
        null,
        'open',
        { kind: 'bank', crates: [] },
        { kind: 'open' },
        { kind: 'train', unitId: 'u', skill: 'COMBAT', points: 1.5 },
        { kind: 'train', unitId: 'u', skill: 'COOKING', points: 1 },
        { kind: 'unequip', unitId: 'u', slot: 'HAT' },
      ]) {
        expect((await order(server.port, KEY, sent)).status).toBe(400);
      }
      expect((await order(server.port, 'nonsense', { kind: 'open', crateId: 'c' })).status).toBe(
        400,
      );
      expect(
        await (await order(server.port, STRANGER, { kind: 'open', crateId: 'c' })).json(),
      ).toEqual({ ok: false, reason: 'no-pilot' });
      expect(fort.seen).toEqual([]);
    } finally {
      await server.close();
      await fort.close();
    }
  });

  it('says the fort did not answer when the order got no proper reply', async () => {
    const fort = await fakeFort(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    const server = await serving(fort);
    try {
      expect(await (await order(server.port, KEY, { kind: 'open', crateId: 'c' })).json()).toEqual({
        ok: false,
        reason: 'unreachable',
      });
    } finally {
      await server.close();
      await fort.close();
    }
  });

  it('knows each order there is and nothing else', () => {
    const orders = [
      { kind: 'open', crateId: 'c1' },
      { kind: 'equip', unitId: 'u1', itemId: 'i1' },
      { kind: 'unequip', unitId: 'u1', slot: 'ARMOR_SYSTEM' },
      { kind: 'send', unitId: 'u1', jobId: 'j1' },
      { kind: 'train', unitId: 'u1', skill: 'SENSORS', points: 2 },
      { kind: 'trainAll', unitId: 'u1' },
      { kind: 'recruit' },
    ];
    for (const one of orders) expect(parseFortOrder({ ...one, extra: true })).toEqual(one);
    for (const one of [
      { kind: 'sell', itemId: 'i1' },
      { kind: 'equip', unitId: 'u1' },
      { kind: 'send', unitId: '', jobId: 'j1' },
      { kind: 'train', unitId: 'u1', skill: 'SENSORS', points: 0 },
      { kind: 'train', unitId: 'u1', skill: 'SENSORS', points: 101 },
      { kind: 'open', crateId: 'c'.repeat(81) },
      { kind: 'trainAll' },
    ]) {
      expect(parseFortOrder(one)).toBeNull();
    }
    expect(parseFortOrderReply({ ok: true, fort: FORT, done: DONE })).toEqual({
      ok: true,
      fort: FORT,
      done: DONE,
    });
    expect(parseFortOrderReply({ ok: true, fort: FORT })).toBeNull();
    expect(parseFortOrderReply({ ok: false, reason: 'off' })).toEqual({ ok: false, reason: 'off' });
  });
});

describe('crates won in flight come into the fort', () => {
  const start = async (banked: boolean, whileHandingOver?: (crates: MemoryCrateStore) => void) => {
    const crates = new MemoryCrateStore();
    const first = crates.add(KEY, 'Rare', 'raider', 3);
    const second = crates.add(KEY, 'Common', 'orb', 3);
    const fort = await fakeFort((request) => {
      const handingOver = request.path.endsWith('/order');
      if (handingOver) whileHandingOver?.(crates);
      return {
        status: 200,
        body: JSON.stringify(
          handingOver
            ? { ok: true, done: { ok: banked, message: '' }, fort: FORT }
            : { ok: true, fort: FORT },
        ),
      };
    });
    const server = await startServer({
      port: 0,
      pilots: knownPilots(),
      crates,
      bridgeSecret: SECRET,
      fortIdKey: ID_KEY,
      fortUrl: fort.url,
    });
    return { crates, fort, server, sent: [first, second] };
  };

  it('they are handed over when the fort is read, and leave this server once the fort has them', async () => {
    const { crates, fort, server, sent } = await start(true);
    try {
      expect(await (await ask(server.port, KEY)).json()).toEqual({ ok: true, fort: FORT });
      expect(
        fort.seen.map((request) => request.path.replace(/.*\/fort\/pilot_[0-9a-f]+/, '')),
      ).toEqual(['/order', '']);
      expect(fort.seen[0]?.body).toEqual({ kind: 'bank', crates: sent });
      expect(crates.count(KEY)).toBe(0);
      // Nothing left to hand over: the next read only reads.
      await ask(server.port, KEY);
      expect(fort.seen).toHaveLength(3);
    } finally {
      await server.close();
      await fort.close();
    }
  });

  it('they stay here when the fort does not say it has them, and are offered again', async () => {
    const { crates, fort, server } = await start(false);
    try {
      await ask(server.port, KEY);
      expect(crates.count(KEY)).toBe(2);
      await ask(server.port, KEY);
      expect(fort.seen.filter((request) => request.path.endsWith('/order'))).toHaveLength(2);
      expect(crates.count(KEY)).toBe(2);
    } finally {
      await server.close();
      await fort.close();
    }
  });

  it('a crate won while the handing over was under way is not lost with the others', async () => {
    const late: unknown[] = [];
    const { crates, fort, server, sent } = await start(true, (store) => {
      late.push(store.add(KEY, 'Epic', 'boss', 3));
    });
    try {
      await ask(server.port, KEY);
      expect(fort.seen[0]?.body).toEqual({ kind: 'bank', crates: sent });
      expect(crates.pending(KEY)).toEqual(late);
      expect(late).toHaveLength(1);
    } finally {
      await server.close();
      await fort.close();
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

  it('refuses what is not a fort at all', () => {
    const broken: unknown[] = [
      null,
      'fort',
      { ...FORT, now: -1 },
      { ...FORT, currencies: { ...FORT.currencies, credits: '100' } },
      { ...FORT, crew: 'everyone' },
      { ...FORT, hold: { ...FORT.hold, itemCount: -1 } },
      { ...FORT, reports: undefined },
      { ...FORT, hold: undefined },
    ];
    for (const value of broken) expect(parseFortView(value)).toBeNull();
    expect(parseFortReply({ ok: true, fort: null })).toBeNull();
    expect(parseFortReply({ ok: false, reason: 'because' })).toBeNull();
    expect(parseFortReply({ fort: FORT })).toBeNull();
  });

  it('leaves out an entry it cannot read, keeps the rest, and says how many', () => {
    const [first, second] = FORT.crew;
    let leftOut = 0;
    const fort = parseFortView(
      {
        ...FORT,
        crew: [{ ...first, state: 'asleep' }, second, { ...first, until: 'soon' }],
        hold: { ...FORT.hold, crates: [{ id: 'x' }, ...FORT.hold.crates] },
        reports: [{ id: 'in_0', at: 1, title: 7, detail: null }, ...FORT.reports],
      },
      (entries) => {
        leftOut = entries;
      },
    );
    expect(fort?.crew).toEqual([second]);
    expect(fort?.hold.crates).toEqual(FORT.hold.crates);
    expect(fort?.reports).toEqual(FORT.reports);
    expect(leftOut).toBe(4);
    // A whole fort reports nothing left out.
    leftOut = -1;
    parseFortView(FORT, (entries) => {
      leftOut = entries;
    });
    expect(leftOut).toBe(-1);
  });

  it('cuts long words to fit instead of refusing them', () => {
    const [first] = FORT.reports;
    const fort = parseFortView({
      ...FORT,
      reports: [{ ...first, title: 't'.repeat(900), detail: 'd'.repeat(900) }],
    });
    expect(fort?.reports[0]?.title).toHaveLength(200);
    expect(fort?.reports[0]?.detail).toHaveLength(400);
  });
});
