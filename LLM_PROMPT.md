## Orbit‑Runner: Deploy + Review Brief for an Advanced LLM

### What you received
- A playable browser game built with Three.js and vanilla ESM.
- Two zips may be attached:
  - orbit-runner-client.zip: client-only, uses CDN for Three.js (no node_modules).
  - orbit-runner-full-clean.zip: full project (no node_modules/.git) including optional leaderboard server.

### Goal
- Keep gameplay/feel and visuals the same while improving performance, robustness, and code structure. Provide concrete code edits and deployment guidance.

### How to run
- Client-only zip:
  - Unzip → in that folder run: python3 -m http.server 8000
  - Open http://localhost:8000
  - Optional: set window.ORBIT_RUNNER_API = 'https://your-server.example.com' in index.html to use leaderboards.
- Full project zip:
  - Unzip → npm install
  - Client: python3 -m http.server 8000 → http://localhost:8000
  - Server (leaderboards): npm run server (default http://localhost:8787)
  - Client auto-detects http://<host>:8787 unless window.ORBIT_RUNNER_API is set.

### Key files
- index.html: bootstraps Three via CDN import map and loads main.js.
- main.js: all gameplay/rendering/UI (≈2k lines). Imports FontLoader/TextGeometry via CDN; font JSON loaded from Three CDN.
- style.css: HUD/overlay.
- server/index.js: optional Express+WS leaderboards with simple validation, on-disk JSON persistence.

### API (if server used)
- GET /health → { ok: true }
- GET /leaderboards → { points, kills, asteroids, belt, survival }
- POST /submit → JSON body requires uid; clamps values; per-IP rate limit; persists and broadcasts WS update
- WS: connects on the same base URL; pushes { type:'leaderboards', payload } snapshots/updates

### Constraints
- Do not change controls or core feel.
- Keep API backward compatible.
- Maintain visual fidelity; improvements are welcome but avoid regressions.

### Primary tasks (prioritized)
1) Performance under load
   - Profile hotspots: asteroid updates, collision checks, particle systems, bullets.
   - Ensure broad-phase spatial hashing is effective; reduce per-frame allocations.
   - Convert asteroid meshes to InstancedMesh where feasible without losing variety.
   - Consider far culling/Lod in dense belt and cap spawns sanely.

2) Collision robustness
   - Add simple continuous collision for fast bullets (swept sphere vs sphere/AABB) using existing spatial hash; avoid tunneling.
   - Keep O(n) per bullet for nearby candidates; avoid global scans.

3) Structure and readability
   - Propose a minimal refactor splitting main.js into modules: input, player/ship, entities (asteroids/orbs/bots), rendering+FX, UI/HUD, net.
   - Keep public, typed-ish function signatures and early returns; remove magic numbers into named constants.

4) Networking resilience (client)
   - WS reconnection with exponential backoff; reflect connection state in overlay.
   - Debounce/fail-soft HTTP fetches for /leaderboards; cache last-good.

5) Server hardening
   - Validate request bodies with a small schema; keep clamping.
   - Better per-IP rate limiting (e.g., token bucket).
   - Configurable persistence path; handle file I/O errors gracefully.

6) Packaging/DX
   - Provide optional Vite config to bundle for production while preserving ESM and avoiding heavy changes.
   - Make CDN vs local module choice via a single flag for offline builds.

### Suggested next steps
- Establish baseline FPS: outside belt vs inside ring, on mid-tier laptop; record metrics.
- Implement InstancedMesh for asteroids; keep a small set of base geometries/materials for variety.
- Add swept-volume bullet collision; measure missed-hit reduction and frame cost.
- Add WS auto-reconnect and UI indicator; test server restarts.
- Extract collision/spatial-hash and entities into separate modules without behavior changes.
- Add a minimal Vite build (vite.config.js + index.html tweaks) and verify CDN/offline toggles.

### Important notes
- Client uses CDN imports for Three.js examples and the font JSON; requires network access. For offline use, switch imports back to local modules or vendor them.
- Leaderboards persist to server/leaderboards.json on disk; ephemeral hosts may lose data across restarts.
- Anti-tamper is minimal (clamping + uid required). Consider signatures or server-side score validation for production.

### Deliverables expected from you
- A short summary of issues found and prioritized fixes.
- Direct code edits (snippets/diffs) for:
  - InstancedMesh conversion and perf fixes
  - Continuous collision for bullets
  - WS reconnection logic and UI state
  - Modularity refactor outline with file boundaries
  - Optional Vite config and index.html adjustments
- A production runbook: local build, deploy (static + server), and configuration.

### Test checklist
- Smooth 60 FPS outside belt; improved stability inside belt after optimizations.
- Bullets no longer pass through targets at high speeds.
- Leaderboards fetch/WS continue after server restart; overlay updates live.
- Game retains control feel and visuals.





