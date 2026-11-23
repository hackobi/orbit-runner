// What pilots have earned in flight and not yet told their fort: experience,
// and what they shot or took, by kind. The fort turns it into upgrade points,
// experience for the crew member on board, and progress on a contract.
//
// Kept in memory only. It is sent every time the pilot's page reads the fort
// (every half minute in flight), so a restart loses at most that much.

import { randomBytes } from 'node:crypto';
import type { MissionKind } from '../shared/progress.ts';

export type Tally = Partial<Record<MissionKind, number>>;

export interface FlightReport {
  /** Unique for ever: the fort counts a report once however often it is sent. */
  readonly id: string;
  /** Pilot experience earned. */
  readonly xp: number;
  readonly tally: Tally;
}

export class FlightLog {
  private readonly earned = new Map<string, { xp: number; tally: Tally }>();
  /** The report on its way to the fort. It is sent again, unchanged, until the fort has it. */
  private readonly sending = new Map<string, FlightReport>();

  /** A pilot earned experience in flight. */
  earn(key: string, xp: number): void {
    this.entry(key).xp += xp;
  }

  /** A pilot did one of something a contract may ask for. */
  count(key: string, kind: MissionKind): void {
    const tally = this.entry(key).tally;
    tally[kind] = (tally[kind] ?? 0) + 1;
  }

  /** The report to send for this pilot now, or null if there is nothing to say. */
  next(key: string): FlightReport | null {
    const waiting = this.sending.get(key);
    if (waiting) return waiting;
    const earned = this.earned.get(key);
    if (!earned) return null;
    this.earned.delete(key);
    const report = { id: randomBytes(12).toString('hex'), xp: earned.xp, tally: earned.tally };
    this.sending.set(key, report);
    return report;
  }

  /** The fort has this report. */
  sent(key: string, id: string): void {
    if (this.sending.get(key)?.id === id) this.sending.delete(key);
  }

  private entry(key: string): { xp: number; tally: Tally } {
    let entry = this.earned.get(key);
    if (!entry) {
      entry = { xp: 0, tally: {} };
      this.earned.set(key, entry);
    }
    return entry;
  }
}
