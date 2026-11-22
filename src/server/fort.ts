// Reads a pilot's fort from SpaceFort's server. This server is the only thing
// that talks to it: it knows which pilot is asking, names them by an id
// SpaceFort cannot be handed by anyone else, and proves itself with the bridge
// secret. The pilot's browser never reaches SpaceFort.

import { createHmac } from 'node:crypto';
import { parseFortDone, parseFortView } from '../shared/fort.ts';
import type { FortOrder, FortOrderReply, FortReply, FortView } from '../shared/fort.ts';
import type { Crate } from './crates.ts';
import type { FlightLog } from './flight.ts';

export interface FortLink {
  /** SpaceFort's server, such as http://127.0.0.1:5001. */
  readonly url: string;
  /** The same secret SpaceFort's server holds as ORBIT_BRIDGE_SECRET. */
  readonly secret: string;
  /**
   * What pilots' fort names are made with. It is its own key, kept for good:
   * the bridge secret can then be changed without every pilot losing their fort.
   */
  readonly idKey: string;
  /** How long to wait for the fort before saying it did not answer. */
  readonly timeoutMs?: number;
}

/**
 * The fort's name for a pilot. It is made from the pilot's key with a key
 * only this server holds, so it cannot be worked out from the pilot's key
 * alone, and the pilot's key itself never leaves this server.
 */
export function fortPlayerId(idKey: string, pilotKey: string): string {
  return `pilot_${createHmac('sha256', idKey).update(`fort:${pilotKey}`).digest('hex').slice(0, 32)}`;
}

/** What SpaceFort answered, or null if it did not answer with JSON and a 200. */
async function ask(link: FortLink, pilotKey: string, order?: object): Promise<unknown> {
  const path = `/api/bridge/fort/${fortPlayerId(link.idKey, pilotKey)}${order ? '/order' : ''}`;
  try {
    const response = await fetch(new URL(path, link.url), {
      method: order ? 'POST' : 'GET',
      headers: {
        'x-bridge-secret': link.secret,
        ...(order ? { 'content-type': 'application/json' } : {}),
      },
      ...(order ? { body: JSON.stringify(order) } : {}),
      signal: AbortSignal.timeout(link.timeoutMs ?? 4000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function fortIn(body: unknown): FortView | null {
  return parseFortView((body as { fort?: unknown } | null)?.fort, (entries) => {
    // Shown to the pilot without them; said here so it does not pass unseen.
    console.warn(`fort: ${entries} entries from SpaceFort could not be read and were left out`);
  });
}

/** The fort of the pilot with this key, or why there is none to show. */
export async function readFort(link: FortLink, pilotKey: string): Promise<FortReply> {
  const fort = fortIn(await ask(link, pilotKey));
  return fort ? { ok: true, fort } : { ok: false, reason: 'unreachable' };
}

/**
 * Carries a pilot's order to their fort and brings back how it went. A
 * recruit depends on the pilot's level, which only this server may state:
 * it is put on the order here, never taken from the page.
 */
export async function orderFort(
  link: FortLink,
  pilotKey: string,
  order: FortOrder,
  pilotLevel: number,
): Promise<FortOrderReply> {
  const body = await ask(
    link,
    pilotKey,
    order.kind === 'recruit' ? { ...order, pilotLevel } : order,
  );
  const fort = fortIn(body);
  const done = parseFortDone((body as { done?: unknown } | null)?.done);
  return fort && done ? { ok: true, fort, done } : { ok: false, reason: 'unreachable' };
}

/**
 * Hands crates won in flight to the pilot's fort. True only when SpaceFort
 * said it has them: until then they stay where they are. SpaceFort takes a
 * crate once however often it is sent, so a lost answer costs nothing.
 */
export async function bankCrates(
  link: FortLink,
  pilotKey: string,
  crates: readonly Crate[],
): Promise<boolean> {
  const body = await ask(link, pilotKey, { kind: 'bank', crates });
  return parseFortDone((body as { done?: unknown } | null)?.done)?.ok === true;
}

/**
 * Tells a pilot's fort what they have earned in flight since it last heard.
 * A report the fort did not answer for is kept and sent again next time; the
 * fort counts it once. After one sent again, what was earned since follows,
 * so the fort is never read or given an order with earnings still here.
 */
export async function reportFlight(
  link: FortLink,
  pilotKey: string,
  log: FlightLog,
): Promise<void> {
  for (let sends = 0; sends < 2; sends++) {
    const report = log.next(pilotKey);
    if (!report) return;
    const body = await ask(link, pilotKey, { kind: 'flight', ...report });
    if (parseFortDone((body as { done?: unknown } | null)?.done)?.ok !== true) return;
    log.sent(pilotKey, report.id);
  }
}
