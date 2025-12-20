# Orbit Runner - PvP Multiplayer Mode

## Overview

PvP Multiplayer is a survival-based competitive mode where players fight to be the longest survivor. Unlike the original 3-minute timed mode, PvP has no time limit - players compete until death.

**Key Concept**: Survive as long as possible. The longest survivor earns the pot when they die.

## Economy System

### Entry Fee (3 DEM)
When a player joins, they pay **3 DEM**:
- **2 DEM** → Server wallet (operations + contests fund)
- **1 DEM** → Prize pot

### Store Purchases
When players buy items (bombs: 3/6/9 DEM):
- **20%** → Server wallet
- **80%** → Prize pot

Example: 9 DEM bomb purchase = 7 DEM to pot, 2 DEM to server

### Pot Distribution
When the **longest survivor** dies:
- **66%** → Longest survivor (the player who just died)
- **22%** → Killer of the longest survivor
- **12%** → Stays in pot (seeds next round)

If no killer (asteroid/disconnect), the killer's 22% also stays in pot.

### Configuration (`server/index.js`)
```javascript
const PVP_CONFIG = {
  ENTRY_FEE: 3,
  SERVER_SHARE: 2,
  POT_SHARE: 1,
  SURVIVOR_PERCENT: 0.66,
  KILLER_PERCENT: 0.22,
};
```

## Game Mechanics

### Survival Rules
- **No voluntary exit** - Players cannot leave voluntarily
- **Death = Exit** - Only way out is dying (killed by player, asteroid, or planet collision)
- **Disconnect = Death** - Abandoning the game counts as death (no penalty, just dies)
- **No time limit** - Game continues indefinitely

### Longest Survivor Tracking
- Server tracks survival time for each player (`joinedAt` timestamp)
- Player with longest survival time is the "Longest Survivor"
- HUD displays crown icon (👑) for the longest survivor
- When longest survivor dies, pot payout is triggered

### Map Layout
- **Blue Planet**: Centered at origin (0, 0, 0), radius 1200
- **Asteroid Belt**: Ring around planet (inner: 3600, outer: 5200)
- **Player Spawn**: Random position within asteroid belt
- **Starfield**: Compact (8000-20000 units)

### HUD Display
```
Speed X | HP X% | Shield X% | Points X | Kills X | Ast X | Bombs X | 💰 POT: X DEM | 👑 LONGEST
```

## Technical Architecture

### Server State (`pvpState`)
```javascript
const pvpState = {
  pot: 0,                    // Current pot in DEM (integer)
  activePlayers: new Map(),  // playerId -> { address, joinedAt, odId, potContribution }
  pendingPayouts: new Map(), // walletAddress -> { survivorAmount, killerAddress, killerAmount, survivalSec, kills, timestamp }
};
```

State is persisted to `server/pvp-state.json`.

### WebSocket Events

**Server → Client:**
- `pot-update` - Pot amount changed
  ```json
  { "type": "pot-update", "pot": 15 }
  ```
- `longest-survivor-update` - New longest survivor
  ```json
  { "type": "longest-survivor-update", "playerId": "abc123", "survivalSec": 120 }
  ```
- `champion-payout` - Pot was distributed
  ```json
  { "type": "champion-payout", "payload": { "winner": "0x...", "survivorAmount": 10, "killerAmount": 3, "survivalSec": 300 } }
  ```

**Client → Server:**
- Standard input messages (position, shooting, etc.)

### REST Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/pvp/state` | GET | Current pot, player count, longest survivor |
| `/pvp/pending-payout` | POST | Check if player has unclaimed payout |
| `/pvp/submit-score` | POST | Claim payout and record to blockchain |
| `/pvp/forfeit-payout` | POST | Forfeit unclaimed payout |
| `/pay/info` | GET | Entry fee info and current pot |
| `/pay/verify` | POST | Verify entry payment |
| `/bomb/verify` | POST | Verify bomb purchase (adds 80% to pot) |

### Key Files
- `server/index.js` - PvP state, payout logic, WebSocket handlers
- `main.js` - Client-side HUD, death screens, payment flow
- `server/pvp-state.json` - Persisted pot and pending payouts

## Blockchain Integration

### Score Submission Flow
1. Player dies as longest survivor
2. Death screen shows "Submit Score to Demos" button
3. Player connects wallet and signs message
4. Server verifies signature, records stats on-chain
5. Server broadcasts transaction to Demos network
6. Player receives DEM payout

### Pending Payout Recovery
If a player disconnects before claiming:
1. Payout is stored in `pvpState.pendingPayouts`
2. On reconnect, client checks `/pvp/pending-payout`
3. Modal appears offering to claim or forfeit
4. Payouts persist indefinitely until claimed/forfeited

### On-Chain Data Structure
```json
{
  "game": "Orbit Runner PvP",
  "version": "1.0.0",
  "playerAddress": "0x...",
  "survivalSec": 300,
  "kills": 5,
  "potWon": 15,
  "timestamp": 1234567890
}
```

## Death Screens

### Regular Death (Not Longest Survivor)
- Shows killer name
- Options: "Play Again" (pay 3 DEM), "Demo Mode" (free, no pot)

### Longest Survivor Death
- Shows survival time and pot amount
- "Submit Score to Demos" button (claims payout + records on-chain)
- "Skip & Play Again" (forfeits payout)

## Testing

### Current Status
- ✅ Entry fee payment (3 DEM)
- ✅ Pot accumulation from entry + store purchases
- ✅ Longest survivor tracking
- ✅ Payout calculation and distribution
- ✅ Death screen with Submit Score
- ✅ Blockchain recording
- ✅ Smaller map (belt-focused)
- ⚠️ Pending payout recovery (needs more testing)
- ⚠️ Multi-player stress testing

### Local Development
```bash
# Start server
PORT=8787 node server/index.js

# Open game
open http://localhost:8787
```

### Environment Variables
```bash
DEMOS_SERVER_MNEMONIC="..."   # Server wallet for receiving payments
DEMOS_TREASURY_MNEMONIC="..." # Treasury wallet (can be same as server)
PORT=8787                      # Server port
```

## Future Work

### Planned Features
1. **PvP Mode Toggle** - Button on welcome screen to choose PvP vs Original (3-min) mode
2. **Token Store** - Convert point-based store items to DEM purchases
3. **Production Deployment** - Deploy to `https://orbit.demos.sh/` with mode selection

### Integration Plan
- Original mode: `https://orbit.demos.sh/` (default)
- PvP mode: Same URL with PvP button, or `?mode=pvp` parameter
- Shared leaderboards with mode indicator

## Quick Reference

| Item | Value |
|------|-------|
| Entry Fee | 3 DEM |
| Server Share (entry) | 2 DEM |
| Pot Share (entry) | 1 DEM |
| Store → Server | 20% |
| Store → Pot | 80% |
| Survivor Payout | 66% of pot |
| Killer Payout | 22% of pot |
| Pot Remainder | 12% |
| Belt Inner Radius | 3600 |
| Belt Outer Radius | 5200 |
| Planet Position | (0, 0, 0) |
| Planet Radius | 1200 |

---

## Session Notes

### 2024-12-16: PvP Economy Implementation

**Completed:**
- Entry fee system: 3 DEM (2 server, 1 pot)
- Store purchase split: 20% server, 80% pot
- Pot distribution: 66% survivor, 22% killer, 12% remains
- Longest survivor tracking with crown indicator
- Death screens with Submit Score button
- Blockchain recording via DAHR flow
- Signature verification with SDK error handling
- Smaller map: Planet at origin, belt-focused gameplay
- Server spawn points updated for new map layout
- Pending payout persistence (pvp-state.json)

**Fixed:**
- Spawn position mismatch (server was spawning far from belt)
- DAHR signature verification hex format error
- Pot updates broadcast to all connected players

**Known Issues:**
- Pending payout recovery needs more testing
- Multi-player stress testing not yet performed

**Next Steps:**
- Deploy to Railway for online testing
- Test with multiple real players
- Add PvP mode toggle button (vs original 3-min mode)
- Convert store items from points to DEM purchases

### Architecture Notes

**Why monolithic files?**
- `main.js` (10k lines): Single-file client for easy browser loading
- `server/index.js` (3.4k lines): All server logic in one place

**Third-party implementation:**
1. Set environment variables (see `.env.example`)
2. Deploy server to Node.js host (Railway, Heroku, etc.)
3. Configure wallet mnemonics for server + treasury
4. Point client to server URL via `ORBIT_RUNNER_API`

**Configuration points:**
- `PVP_CONFIG` in server/index.js - Economy settings
- `RING_INNER/RING_OUTER` in main.js - Belt dimensions
- `targetPlanet` position in main.js - Map center

**State persistence:**
- `server/leaderboards.json` - High scores
- `server/pvp-state.json` - Pot and pending payouts
