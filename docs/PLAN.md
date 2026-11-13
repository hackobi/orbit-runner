# Orbit Runner v2: plan and checkpoint

This file is the running checkpoint. A new session should read it first, then `docs/DECISIONS.md`.

## Status

| Phase | State | Gate |
|---|---|---|
| 0. Research and plan | Done 2026-11-13. Approved the same day with defaults D1–D7 | STOP |
| 1. Core loop | **Done 2026-11-13.** Every acceptance check passes; numbers below | Node tests pass |
| 2. Multiplayer | **Next.** Not started | STOP, with measured numbers |
| 3. Content and mobile | Not started | |
| 4. Mac app | Not started | |
| 5. Demos integration | Not started | Separate approval, and a payment proposal first |

**Next action:** start Phase 2 at task 1 (remote ship snapshot buffer). There is no STOP between Phases 1 and 2; the next STOP is the end of Phase 2.

## How to run it

| Command | What it does |
|---|---|
| `npm run server` | Game server on `127.0.0.1:8787` (Node runs the TypeScript directly; no build) |
| `npm run dev` | Vite on `localhost:5173`, proxying `/ws` to the game server. Open it and fly: arrows or A/D/I/K steer, W/S throttle, or hold the pointer down |
| `npm test` | Unit and virtual-time netcode tests (under 1 s) |
| `npm run test:integration` | Real-socket bot for 60 s, server boot, production-bundle check (about 62 s) |
| `npm run test:e2e` | Playwright in Chromium and WebKit against the minified production build with the debug hook on; starts its own server and `vite preview` on ports 8797 and 5273 |
| `npm run typecheck`, `npm run lint` | Must pass before a task is marked done |
| `npm run spike:webgl` | Re-runs the headless WebGL measurement |

## Where things are

- New project: `/Users/jacobo/Documents/Claude/orbit-runner-v2`, branch `feature/v2-rebuild`. Local only.
- Old project: `/Users/jacobo/Documents/Claude/orbit-runner`, branch `feature/multiplayer-pvp`. **Read only.** Pushing it deploys to a live Railway service.
- v1 constants and what v2 changes: `DECISIONS.md` Appendix A.
- v1 trust boundary: `DECISIONS.md` Appendix B.

## Rules for every phase

- Never read, copy or print `.env` files or wallet mnemonics.
- No push, deploy, remote repo, Railway or Netlify action without asking.
- Commit in small steps on the feature branch. No co-author lines.
- No stubs or TODO placeholders in work marked done.
- A failed threshold is reported as a failure, with the numbers.
- Device frame rate and phone or Mac-app behaviour are UNVERIFIED until measured on a real device.
- Update the Status table and the Log below at the end of every working session.

## Phase 1: core loop

Goal: one shared simulation, an authoritative server, and one browser client flying with prediction.

Tasks, in order:

1. **Headless rendering spike.** Install Playwright 1.65 browsers. Open four contexts in headless Chromium and four in headless WebKit on this Mac, each with a small WebGL2 scene, and record whether a context is created and what rate `requestAnimationFrame` runs at in each. This decides whether end-to-end tests render or run with `render=off`.
2. **Scaffold.** npm, Vite 8, TypeScript 6.0.3 strict, ESLint, Prettier, Vitest 5. Separate tsconfigs so `src/shared` and `src/net` cannot import DOM or Node. Lint rule banning `Math.sin`, `cos`, `tan`, `pow`, `hypot`, `**` and `Math.random` in `src/shared/sim`.
3. **Deterministic maths.** `sin`, `cos`, `atan2` from `+ − × ÷` and `sqrt`, tested against `Math.*` for accuracy.
4. **Constants.** One file, values from Appendix A, each with its v1 line reference.
5. **Sim step.** Flight model, Y clamp, planet collision, spawn. Pure function of (state, input).
6. **Protocol.** Binary codec for hello, welcome, input, snapshot, events. Version and constants hash.
7. **Transport.** The interface, the WebSocket implementations, and the loopback transport on a fake clock.
8. **Server.** Room, accumulator tick loop, per-player input buffer, snapshots, session tokens, HTTP health.
9. **Client netcode core** (`src/net`). Clock and tick alignment, prediction, reconcile with replay, correction log.
10. **Browser client.** Three.js scene with planet, starfield and the ship; v1 camera, FOV and bank; keyboard and pointer steering; render interpolation between ticks.
11. **Debug hook**, build-flagged, plus the test that the production bundle does not contain it.

Acceptance (criteria as written before the work; results are in the next table):

| Check | Pass |
|---|---|
| Determinism | Two runs of 10,000 ticks with the same seed and inputs give byte-identical state |
| Maths | Own `sin`/`cos` within 1e-9 of `Math.sin`/`Math.cos` over the tested range |
| Prediction, clean | Client and server on the loopback transport with 0 latency: zero corrections over 60 s of scripted input |
| Prediction, latency | Loopback at 100 ms and 200 ms with jitter: zero corrections when no input arrives late |
| Reconcile | An input forced to arrive late produces exactly one correction, and after replay the client state equals the server state at the next acknowledged tick |
| Server authority | A client that sends inputs faster than one per tick does not move faster; malformed messages are rejected |
| Real socket | A headless Node bot over a real `ws` connection flies for 60 s with zero corrections |
| Browser | One Chromium client connects and flies; the debug hook reports zero corrections on a local server |
| Hygiene | `npm run typecheck`, `lint` and `test` pass; production bundle contains no debug hook |

### Phase 1 results (measured 2026-11-13 on this Mac, M3 Ultra)

| Check | Result | Where |
|---|---|---|
| Determinism | Pass on this ARM64 Mac. Two 10,000-tick runs are byte-identical. The same run hashes to the same value in Node 22, Chromium 158 and WebKit 27.2 (minified production build). No engine fuses multiply-add in 2,000,000 optimised iterations. **x86 not measured** | `tests/unit/ship.test.ts`, `tests/e2e/determinism.spec.ts` |
| Maths | Pass. Own `sin`/`cos` within 1e-12 of `Math.sin`/`Math.cos` over ±4π (criterion was 1e-9) | `tests/unit/math.test.ts` |
| Prediction, clean | Pass. 60 s of steering, 0 latency: 0 corrections, 0 missed inputs. Also 0 after warm-up at 30, 100 and 120 frames a second | `tests/unit/netcode.test.ts` |
| Prediction, latency | Pass after the 2 s warm-up: 0 corrections and 0 late inputs over 60 s at 100 ± 20 ms and at 200 ± 50 ms round trip | same |
| Reconcile | Pass. A one-tick input the server never receives gives exactly 1 correction (under 0.5 units); every later acknowledged tick matches bit for bit | same |
| Server authority | Pass. A client flooding 100 future inputs every millisecond covers no more path than an honest one; one input per tick, first copy wins; malformed messages are counted and the 20th closes the connection | `tests/unit/room.test.ts` |
| Real socket | Pass. 60 s over a real `ws` connection: 3,597 inputs, 1,799 snapshots, 0 corrections, 0 missed, round trip 1.5 ms, slack 2.3 ticks | `tests/integration/realSocket.test.ts` |
| Browser | Pass in Chromium and in WebKit (the plan asked for Chromium only). 20 s flown by real key events: 0 corrections, 0 missed inputs. Chromium 60 frames a second (p99 16.8 ms), WebKit 100 (p99 12 ms) | `tests/e2e/flight.spec.ts` |
| Hygiene | Pass. `typecheck`, `lint`, `test` clean. The production bundle does not contain `__orbit`; the test build does | `tests/integration/bundle.test.ts` |

Not covered by these numbers:

- During the first 2 s on the 200 ms profile, before the tick clock settles, inputs can arrive late and cause corrections. An earlier version of the client showed 16 late inputs and 3 corrections there; the client now starts with 2 extra ticks of slack, and the test asserts only on the time after warm-up.
- One Chromium run showed a single 433 ms frame and one WebKit run a 270 ms frame; two later runs showed none (worst 16.8 ms and 28 ms). Not explained. It did not cause a correction.
- Frame rates are from headless browsers on a desktop GPU. They say nothing about phones: UNVERIFIED.

Headless rendering spike (task 1), four contexts open at once, 10 s each:

| Browser | Renderer | Frames a second | Worst frame |
|---|---|---|---|
| Chromium headless shell, default | SwiftShader (software) | 5.8 | 250–367 ms |
| Chromium headless shell, `--use-angle=metal` | Apple M3 Ultra via Metal | 60.0 | 16.8 ms |
| Chromium new headless, default | Metal | 56–60 | 750 ms once, in the two phone profiles |
| WebKit | Apple GPU | 100 | 11–13 ms (38 ms in the first run) |

Decision from the spike: the end-to-end suite renders for real. Chromium runs with `--use-angle=metal` (set in `playwright.config.ts`). The `render=off` fallback in `DECISIONS.md` 7.1 was not needed and is not built.

What changed from the plan during Phase 1:

- **`atan2` is not written.** Nothing in the simulation needs it yet. It will be added with its first user.
- **Session tokens moved to Phase 2**, where reconnecting uses them. Issuing a token nothing reads would have been a stub.
- **Death and respawn arrived early.** Planet collision needs an outcome, so the ship dies and the server respawns it in the belt after 3 s (D5). HP, damage and invulnerability are still Phase 2.
- **The comparison in reconciliation is exact**, not within a tolerance. Any differing bit triggers a rewind; the tolerance in `tests/thresholds.ts` only classifies the event's size.
- **After a stall the client skips ahead** instead of sending the missed inputs late: it predicts the gap with its last sent input, which is what the server did. Covered by the "frozen client" test.
- **The handshake compares a simulation fingerprint**, not only a hash of the constants, so a cached client with old step code is rejected (`src/shared/sim/fingerprint.ts`).
- Design details are in `DECISIONS.md` 5.3, 5.4, 5.8 and Appendix A.2.

## Phase 2: multiplayer

Goal: several players see each other smoothly and can shoot each other fairly.

Tasks:

1. Remote ship snapshot buffer, adaptive interpolation delay, capped extrapolation, offset smoothing. Remote ships are added to the snapshot message (quantised); bump `PROTOCOL_VERSION`.
2. Interest tiers.
3. Bullets in the shared sim; fire cooldown; swept collision.
4. Server rewind history and lag-compensated hit test using the shared interpolation function.
5. HP, damage, respawn invulnerability, disconnect grace (D6), session tokens and reconnect, late-join full state, hidden-tab handling. (Death by planet and the 3 s respawn already exist from Phase 1.)
6. Client: predicted own bullets, shooter-view hit sparks, remote bullets, basic HUD (HP, speed, kills).
7. Headless bot client with scripted and random-walk behaviours.
8. Network proxy with seeded delay, jitter and the two loss modes.
9. The rest of `tests/thresholds.ts` (the file exists with the Phase 1 values) and the metric calculators. The debug hook gains remote ships and scripted inputs.
10. Playwright suite: one server, 2 to 4 contexts across Chromium, WebKit, iPhone and Pixel profiles, scripted inputs, three network profiles.
11. One desktop Firefox smoke run on the clean profile: connect, fly, see a second player. Firefox is a target browser but is outside the brief's full suite.
12. Load test: 16 bots for 5 minutes.

Acceptance:

| Check | Pass |
|---|---|
| Lag compensation, unit | A bullet aimed at where a moving target is drawn under a simulated 230 ms view delay hits; the same shot without rewind misses |
| Rewind cap | A claimed view delay above the cap is clamped |
| Bots vs real server | 4 bots for 60 s: all join, see each other, register kills; server and bot hit logs agree |
| Loss mode `drop` | Bots at 2% drop: no stuck state, no missed death or spawn |
| Playwright suite | Every threshold in `DECISIONS.md` 7.3 passes on its stated profile, in every browser profile |
| Resilience | Hidden tab for 3 s resumes without a visible snap in other clients' view; reconnect within grace keeps the seat; a late joiner sees the same world |
| Load | Tick p99 ≤ 8.3 ms; heap at 5 min within 10% of 1 min; bandwidth per client reported |

**STOP.** Report: each threshold with its measured number per browser and profile, failures as failures, and the UNVERIFIED list.

## Phase 3: content and mobile

Goal: v1's gameplay content and look, and proper phone support.

Tasks:

1. Asteroid belt in the shared sim (closed-form ring orbits, spatial index), ship and bullet collisions, near-miss sparks.
2. Orbs, server-owned: Shield, Pink, Fenix, Zaphire, Wormhole, Boost, and the two multiplier orbs.
3. Fenix transform; wormhole teleport (D9); shield behaviour (D8); world edge (D11).
4. Server-computed scoring, points store, leaderboards.
5. HUD, minimap, labels, death and respawn screens.
6. Visuals to match v1: ship models, exhaust, impacts, tone mapping; wormhole shader.
7. Touch controls, tilt option, landscape overlay, safe areas.
8. Adaptive quality controller.
9. PWA: manifest, icons, service worker, update prompt.
10. LAN HTTPS dev server with instructions for trusting the certificate on the iPhone.
11. Record the console of a headed, GPU-backed Chrome run for the ReadPixels warning.

Acceptance:

| Check | Pass |
|---|---|
| Phase 2 suite | Still passes with content enabled |
| Content, unit | Each orb's effect, scoring rule and store purchase is decided by the server and covered by a test |
| Collisions | Asteroid and planet deaths are server-decided; a client cannot skip them |
| Touch | Playwright touch emulation: stick and fire button drive the same input axes as the keyboard; two simultaneous pointers work |
| PWA | Manifest and service worker pass Chrome's install criteria; update is offered between lives |
| LAN | The dev build loads over HTTPS from a second device on the LAN, including the game socket |
| ReadPixels | Absent from the headed Chrome console, or root-caused and fixed |
| Devices | Manual checklist below run by the user; results recorded here. Until then: UNVERIFIED |

## Phase 4: Mac app

Tasks: Electron main process that loads the client from the game server's HTTPS origin (so it stays in step with the server's protocol version), with a bundled copy on a privileged `app://` scheme for local development; server address from config; packaged `.app` with ad-hoc signing; Playwright smoke test that launches it, connects and flies.

Acceptance: the smoke test passes; the `.app` opens on this Mac; frame pacing on the real display is recorded as measured or UNVERIFIED.

## Phase 5: Demos integration (separate approval)

Before any code: a written proposal for how phone and Mac-app players pay or play free (`DECISIONS.md` section 10), and a review of the economy rules against Appendix B. Known constraints: `@kynesyslabs/demosdk` >= 4.0.5 (4.0.21 is current), ESM only, Node >= 22.15; on-chain amounts in OS units (1 DEM = 1e9 OS).

Design points already fixed so this fits without rework: server-decided kills and survival time, a unique ID per death, admission and economy behind interfaces.

## Manual device checklist (draft; final version ships with Phases 3 and 4)

**iPhone (Safari, then installed to Home Screen)**
1. Trust the mkcert root certificate; open the LAN HTTPS address. Page and game connect.
2. Rotate to landscape. Controls clear the notch and the home indicator.
3. Stick steers, fire button fires, both at once.
4. Enable tilt: the permission prompt appears on tap, and tilt steers.
5. Fly for 5 minutes with a second player on desktop. Note stutter, heat, and the on-screen frame counter.
6. Lock the phone for 5 s and unlock: the game resumes without a jump on the other player's screen.
7. Turn on Low Power Mode: the game still plays at the lower frame rate.
8. Add to Home Screen, relaunch: no browser chrome, and it reconnects.

**Android phone (Chrome)**
1. Open the LAN address; install the app from Chrome's prompt.
2. Fullscreen and landscape lock engage.
3. Steps 3, 5 and 6 from the iPhone list.
4. Switch to another app for 10 s and return.

**Mac app**
1. Open the `.app`. It connects and flies.
2. Note the frame counter on your display (60 or 120 Hz).
3. Fullscreen and back.
4. Play 5 minutes against a phone.

## Log

### 2026-11-13: Phase 0

- Read v1: `README.md`, `PVP_MULTIPLAYER.md`, `git log` (198 commits), `server/index.js` in full, the pending ReadPixels todo and the earlier audit report. `main.js`: gameplay, rendering and networking read in full (lines 1–90, 236–483, 541–660, 3790–10230); the wallet, payment and overlay code in between was only grep-swept and needs a proper read in Phase 5. Spot-checked the key constants and server claims by line.
- Checked current docs and registries for versions, WebGPU and WebTransport support, Colyseus 0.18, Playwright, Tauri, Electron, iOS constraints.
- Tested on this Mac: Node 22.22.3 runs `.ts` files with `.ts` imports directly.
- Created the repo and branch `feature/v2-rebuild`. Wrote `DECISIONS.md` and this file.
- Not done: no code, no dependency installed, nothing measured in a browser.

Findings that changed the brief's assumptions:

- Colyseus 0.18 (August 2026) now ships prediction, reconciliation and rewind. The recommendation is still to write the core; see D1.
- WebTransport works in iOS Safari since 26.4. It is still not added, because Node and the hosting side are not ready.
- v1's weapon is a 3-second projectile, so "rewind to when the shot was fired" needed a definition; see D2.
- TypeScript `latest` is 7.0, which typescript-eslint does not support yet. Pinned to 6.0.3.
- v1 does not use Pointer Lock, so it does not decide the Mac wrapper.

Blockers: none. Waiting for approval.

### 2026-11-13: Phase 1

- Approved by the user with defaults D1–D7.
- Ran the headless WebGL spike first; result above.
- Built in this order, committing after each: scaffold; shared sim, maths and wire format; room, client core and transports; browser client and debug hook.
- Tested the riskiest premise early: before any server code existed, the 10,000-tick trace was hashed in Node, Chromium and WebKit. All three agree.
- Re-read v1's flight update (`main.js:8690-8809`), spawn, planet check, camera, ship model and input bindings line by line while porting. `DECISIONS.md` Appendix A marks are updated.
- Found while porting, and put to the user as D12: v1's working pointer control steers away from the pointer (drag style). Kept as v1 for now.
- Not done in Phase 1, by design: other players on screen, shooting, HP, HUD beyond a speed readout, touch stick, asteroids, orbs.

Blockers: none.
