// Reads a pilot's fort from SpaceFort's server. This server is the only thing
// that talks to it: it knows which pilot is asking, names them by an id
// SpaceFort cannot be handed by anyone else, and proves itself with the bridge
// secret. The pilot's browser never reaches SpaceFort.

import { createHmac } from 'node:crypto';
import { parseFortView } from '../shared/fort.ts';
import type { FortReply } from '../shared/fort.ts';

export interface FortLink {
  /** SpaceFort's server, such as http://127.0.0.1:5001. */
  readonly url: string;
  /** The same secret SpaceFort's server holds as ORBIT_BRIDGE_SECRET. */
  readonly secret: string;
  /** How long to wait for the fort before saying it did not answer. */
  readonly timeoutMs?: number;
}

/**
 * The fort's name for a pilot. It is made from the pilot's key with the
 * bridge secret, so it cannot be worked out from the key alone, and the key
 * itself never leaves this server.
 */
export function fortPlayerId(secret: string, pilotKey: string): string {
  return `pilot_${createHmac('sha256', secret).update(`fort:${pilotKey}`).digest('hex').slice(0, 32)}`;
}

/** The fort of the pilot with this key, or why there is none to show. */
export async function readFort(link: FortLink, pilotKey: string): Promise<FortReply> {
  let response: Response;
  try {
    response = await fetch(
      new URL(`/api/bridge/fort/${fortPlayerId(link.secret, pilotKey)}`, link.url),
      {
        headers: { 'x-bridge-secret': link.secret },
        signal: AbortSignal.timeout(link.timeoutMs ?? 4000),
      },
    );
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (!response.ok) return { ok: false, reason: 'unreachable' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  const fort = parseFortView((body as { fort?: unknown } | null)?.fort);
  return fort ? { ok: true, fort } : { ok: false, reason: 'unreachable' };
}
