// When a new version of the game may be loaded. Loading it reloads the page,
// so it never happens while the player's ship is flying or while they are
// reading the fort: only between lives, or while there is no game to interrupt.

import type { ClientStatus } from '../net/client.ts';

export function shouldApplyUpdate(
  updateReady: boolean,
  status: ClientStatus,
  shipAlive: boolean,
  fortOpen: boolean,
): boolean {
  if (!updateReady || fortOpen) return false;
  // Connecting, away, rejected or closed: nothing is being flown.
  if (status !== 'playing') return true;
  return !shipAlive;
}
