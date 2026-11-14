// When a new version of the game may be loaded. Loading it reloads the page,
// so it never happens while the player's ship is flying: only between lives,
// or while there is no game to interrupt.

import type { ClientStatus } from '../net/client.ts';

export function shouldApplyUpdate(
  updateReady: boolean,
  status: ClientStatus,
  shipAlive: boolean,
): boolean {
  if (!updateReady) return false;
  // Connecting, away, rejected or closed: nothing is being flown.
  if (status !== 'playing') return true;
  return !shipAlive;
}
