import { describe, expect, it } from 'vitest';
import {
  ReportWatch,
  SortieTracker,
  askFort,
  askLaunch,
  clockText,
  crewLine,
  debriefLines,
  gearChoices,
  jobChoices,
  secondsUntil,
  stepFortGate,
  unavailableText,
} from '../../src/client/fortModel.ts';
import type { FortFacts, FortGate } from '../../src/client/fortModel.ts';
import type { CrewMember, FortItem, FortJob, FortView } from '../../src/shared/fort.ts';

const member = (over: Partial<CrewMember>): CrewMember => ({
  id: 'nft_1',
  name: 'Maya "Comet" Ranger',
  className: 'Space Recruit',
  level: 4,
  state: 'ready',
  until: null,
  doing: null,
  points: 0,
  skills: [],
  gear: [],
  ...over,
});

describe('clocks', () => {
  it('reads as minutes and seconds, and hours when there are any', () => {
    expect(clockText(0)).toBe('0:00');
    expect(clockText(0.2)).toBe('0:01');
    expect(clockText(83)).toBe('1:23');
    expect(clockText(3600 + 62)).toBe('1:01:02');
    expect(clockText(-5)).toBe('0:00');
  });

  it("turns the fort's moments into seconds from now, whatever the two clocks read", () => {
    // The fort's clock said 1,000,000 when read; that was 2 s ago here.
    expect(secondsUntil(1_090_000, 1_000_000, 5000, 7000)).toBe(88);
    expect(secondsUntil(1_001_000, 1_000_000, 5000, 7000)).toBe(-1);
  });
});

describe("a crew member's line", () => {
  it('says ready, and that they can be given something to do', () => {
    expect(crewLine(member({}), null)).toEqual({ text: 'Ready', free: true, due: false });
  });

  it('counts down a mission and a rest', () => {
    expect(crewLine(member({ state: 'mission', until: 1 }), 83)).toEqual({
      text: 'On a mission · 1:23',
      free: false,
      due: false,
    });
    expect(crewLine(member({ state: 'resting', until: 1 }), 9).text).toBe(
      'Resting · ready in 0:09',
    );
  });

  it('says a unit is due when its time is up, so the fort is read again', () => {
    expect(crewLine(member({ state: 'mission', until: 1 }), 0)).toEqual({
      text: 'Due back',
      free: false,
      due: true,
    });
    expect(crewLine(member({ state: 'resting', until: 1 }), -3).due).toBe(true);
  });

  it('says what a unit is doing even when the fort gave no end time', () => {
    expect(crewLine(member({ state: 'raid' }), null)).toEqual({
      text: 'On a raid',
      free: false,
      due: false,
    });
  });
});

describe('a sortie', () => {
  const totals = (score: number, kills: number, xp: number, crateDrops: number) => ({
    score,
    kills,
    xp,
    crateDrops,
  });

  it('is what the pilot gained between the ship appearing and its loss', () => {
    const tracker = new SortieTracker();
    tracker.update(false, totals(0, 0, 0, 0), 0);
    expect(tracker.last).toBeNull();
    tracker.update(true, totals(1000, 2, 300, 1), 10_000);
    tracker.update(true, totals(4200, 5, 900, 2), 60_000);
    expect(tracker.last).toBeNull();
    tracker.update(false, totals(4200, 5, 900, 2), 95_000);
    expect(tracker.last).toEqual({ seconds: 85, points: 3200, kills: 3, xp: 600, crates: 1 });
    // Staying dead changes nothing.
    tracker.update(false, totals(4200, 5, 900, 2), 200_000);
    expect(tracker.last?.seconds).toBe(85);
  });

  it('never reports less than nothing when a new seat starts the totals again', () => {
    const tracker = new SortieTracker();
    tracker.update(true, totals(5000, 9, 800, 0), 0);
    tracker.update(false, totals(0, 0, 800, 0), 1000);
    expect(tracker.last).toEqual({ seconds: 1, points: 0, kills: 0, xp: 0, crates: 0 });
  });

  it('is laid out line by line, with what it brought in picked out', () => {
    const lines = debriefLines({ seconds: 85, points: 3200, kills: 0, xp: 600, crates: 1 });
    expect(lines).toEqual([
      { label: 'Flown', value: '1:25', gain: false },
      { label: 'Points', value: '+3,200', gain: true },
      { label: 'Experience', value: '+600', gain: true },
      { label: 'Kills', value: '0', gain: false },
      { label: 'Salvage', value: '1 crate', gain: true },
    ]);
    expect(debriefLines({ seconds: 1, points: 0, kills: 0, xp: 0, crates: 0 }).at(-1)?.value).toBe(
      'none',
    );
    expect(debriefLines({ seconds: 1, points: 0, kills: 0, xp: 0, crates: 3 }).at(-1)?.value).toBe(
      '3 crates',
    );
  });
});

describe('when there is no fort to show', () => {
  it('says why in words, for each reason', () => {
    expect(unavailableText('off')).toContain('no fort connected');
    expect(unavailableText('unreachable')).toContain('not answering');
    expect(unavailableText('no-pilot')).toContain('keeps no pilot');
  });
});

describe('the way in and out', () => {
  const CLOSED: FortGate = { open: false, launching: false };
  const OPEN: FortGate = { open: true, launching: false };
  const facts = (over: Partial<FortFacts>): FortFacts => ({
    playing: true,
    shipAlive: false,
    held: false,
    ...over,
  });

  it('opens at once for a pilot without a ship, before the server has answered', () => {
    expect(askFort(CLOSED, facts({}))).toEqual(OPEN);
    expect(stepFortGate(OPEN, facts({ held: false }))).toEqual(OPEN);
    expect(stepFortGate(OPEN, facts({ held: true }))).toEqual(OPEN);
  });

  it('does not open for a pilot who is flying, or while the game is not running', () => {
    expect(askFort(CLOSED, facts({ shipAlive: true }))).toEqual(CLOSED);
    expect(askFort(CLOSED, facts({ playing: false }))).toEqual(CLOSED);
  });

  it('closes whenever the ship is flying: a refusal, or a respawn that beat the press', () => {
    expect(stepFortGate(OPEN, facts({ shipAlive: true }))).toEqual(CLOSED);
    expect(stepFortGate(OPEN, facts({ shipAlive: true, held: true }))).toEqual(CLOSED);
  });

  it('opens when the server says the pilot is there: back from away, or a reloaded page', () => {
    expect(stepFortGate(CLOSED, facts({ held: true }))).toEqual(OPEN);
    expect(stepFortGate(CLOSED, facts({ held: true, playing: false }))).toEqual(CLOSED);
  });

  it('closes on Launch at once and stays closed until the ship is out, even while the server still says "held"', () => {
    const launching = askLaunch(OPEN);
    expect(launching).toEqual({ open: false, launching: true });
    expect(stepFortGate(launching, facts({ held: true }))).toEqual(launching);
    expect(stepFortGate(launching, facts({ held: false }))).toEqual(launching);
    expect(stepFortGate(launching, facts({ shipAlive: true }))).toEqual(CLOSED);
    expect(askLaunch(CLOSED)).toEqual(CLOSED);
  });

  it('stays open when the connection drops or the seat is given up: the fort does not need a seat', () => {
    expect(stepFortGate(OPEN, facts({ playing: false }))).toEqual(OPEN);
    expect(stepFortGate(OPEN, facts({ playing: false, shipAlive: true }))).toEqual(OPEN);
  });
});

describe('what a crew member can be told to do', () => {
  const maya = member({});
  const item = (over: Partial<FortItem>): FortItem => ({
    id: 'upg_1',
    name: 'Plasma Rifle',
    rarity: 'rare',
    slot: 'PRIMARY_WEAPON',
    bonus: 20,
    wornBy: null,
    fits: [maya.id],
    ...over,
  });
  const job = (over: Partial<FortJob>): FortJob => ({
    id: 'task_1',
    title: 'Sweep the outer beacons',
    rarity: 'common',
    lasts: 240_000,
    cost: 0,
    pays: { credits: 30, upgradePoints: 1, experience: 40 },
    open: [maya.id],
    ...over,
  });
  const fort = (items: FortItem[], jobs: FortJob[], credits = 100): FortView => ({
    now: 0,
    currencies: { credits, upgradePoints: 0, renown: 0 },
    crew: [maya],
    hold: { crates: [], itemCount: items.length, items },
    jobs,
    reports: [],
  });

  it('offers for a slot only what is made for it, free, and theirs to wear, strongest first', () => {
    const view = fort(
      [
        item({ id: 'weak', bonus: 5 }),
        item({ id: 'strong', bonus: 35 }),
        item({ id: 'worn', wornBy: 'nft_2' }),
        item({ id: 'armor', slot: 'ARMOR_SYSTEM' }),
        item({ id: 'not-theirs', fits: ['nft_2'] }),
      ],
      [],
    );
    expect(gearChoices(view, maya, 'PRIMARY_WEAPON').map((one) => one.id)).toEqual([
      'strong',
      'weak',
    ]);
    expect(gearChoices(view, maya, 'ARMOR_SYSTEM').map((one) => one.id)).toEqual(['armor']);
    expect(gearChoices(view, maya, 'UTILITY_MODULE')).toEqual([]);
  });

  it('lists the jobs open to them, shortest first, and says what each takes and gives', () => {
    const view = fort(
      [],
      [job({ id: 'long', lasts: 900_000 }), job({ id: 'short' }), job({ id: 'closed', open: [] })],
    );
    const choices = jobChoices(view, maya);
    expect(choices.map((choice) => choice.job.id)).toEqual(['short', 'long']);
    // The pay is not promised: a job can fail.
    expect(choices[0]?.line).toBe(
      '4 min · about 30 credits, 1 upgrade point, 40 experience if it succeeds',
    );
    expect(choices[1]?.line).toContain('15 min');
    expect(choices.every((choice) => choice.blocked === '')).toBe(true);
  });

  it('says what a job costs, and that it cannot be afforded when it cannot', () => {
    const dear = job({ cost: 12, pays: { credits: 0, upgradePoints: 0, experience: 0 } });
    expect(jobChoices(fort([], [dear], 12), maya)[0]).toMatchObject({
      line: '4 min · costs 12 credits',
      blocked: '',
    });
    expect(jobChoices(fort([], [dear], 11), maya)[0]?.blocked).toBe('Not enough credits');
  });
});

describe('reports that arrive while flying', () => {
  const report = (id: string) => ({ id, at: 1, title: id, detail: null });

  it('are told once each, oldest first, and what was there at the first look is old news', () => {
    const watch = new ReportWatch();
    expect(watch.take([report('b'), report('a')])).toEqual([]);
    expect(watch.take([report('b'), report('a')])).toEqual([]);
    // The fort lists the newest first.
    expect(watch.take([report('d'), report('c'), report('b')]).map((one) => one.id)).toEqual([
      'c',
      'd',
    ]);
    expect(watch.take([report('d'), report('c')])).toEqual([]);
  });
});
