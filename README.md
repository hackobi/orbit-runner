# Orbit‑Runner

Open‑world 3D space‑flight playground built with Three.js and vanilla ES modules. Fly through dense asteroid belts, collect and shoot glowing orbs, transform into the Fenix ship, and warp via wormholes. Includes optional live multiplayer (single lobby) with input-based server simulation, WebSocket sync, PvP hits, and respawns.

## Features
- Free flight with banking, dynamic FOV, and camera shake
- Massive asteroid fields and a dense planetary ring
- Orb types with unique behaviors and VFX:
  - Shield (green)
  - Pink (neon)
  - Fenix (neon orange + yellow glow)
  - Zaphire (red) → opens Store
  - Wormhole (black/white mirror glow)
  - Boost (green/purple rings)
- Health + Shields, impacts, near‑miss sparks, exhaust trails
- In‑game Store (points‑based)

## Controls
- W / S: accelerate / decelerate (min speed enforced)
- Left / Right or A / D: yaw
- I / K or Up / Down: pitch
- Space: shoot
- Mouse drag: assist yaw/pitch
- H: face target planet
- T: dev turbo (500 speed)
- R: restart after crash

## Run locally (single player or with live server)
```bash
npm install
python3 -m http.server 8000
# open http://localhost:8000/
```

Optional live server (leaderboards + multiplayer):
```bash
npm run server
# server on http://localhost:8787 (WS /mp)
```

Notes
- Uses ES modules via importmap in `index.html` (Three loaded from `node_modules`).
- `index.html` cache‑busts `main.js` for easier local development.

## Multiplayer
- Single lobby using deterministic world seed
- Client sends inputs at 30 Hz; server simulates and broadcasts compact binary state for all players
- PvP collisions and hitscan (timestamp rewind); server respawns with brief i‑frames
- Interest filtering to reduce bandwidth

Client auto-detects `http://<host>:8787` locally. For production, set a global before loading `main.js`:
```html
<script>window.ORBIT_RUNNER_API = 'https://your-railway-app.up.railway.app';</script>
```

## Troubleshooting
- “Failed to resolve module specifier 'three'” → run `npm install` and serve from repo root.
- “THREE is not defined” → ensure you launch via `index.html` in this repo.
- rAF long handler warnings → reduce counts in `seedAsteroids` / `createRings` if needed.

Multiplayer notes:
- Background tabs are throttled by browsers; the server continues, and the client resyncs on focus.
- For best results, host client and server on the same origin or set `window.ORBIT_RUNNER_API`.

## Store (Zaphire orbs)
- Shoot/fly through Zaphire to open the Store.
- Spend Points on HP +100%, Shield +100%, or Fenix upgrade.

## Structure
- `index.html` – bootstraps Three + loads `main.js`
- `main.js` – gameplay, rendering, spawning, UI overlays
- `style.css` – HUD and overlays
- `server/index.js` – Express + WebSocket multiplayer/leaderboards server

## License
MIT © Contributors. See `LICENSE`.

