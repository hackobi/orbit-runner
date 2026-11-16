# Orbit Runner v2: plan and checkpoint

This file is the running checkpoint. A new session should read it first, then `docs/DECISIONS.md`.

## Status

| Phase | State | Gate |
|---|---|---|
| 0. Research and plan | Done 2026-11-13. Approved the same day with defaults D1–D7 | STOP |
| 1. Core loop | **Done 2026-11-13.** Every acceptance check passes; numbers below | Node tests pass |
| 2. Multiplayer | **Done 2026-11-13, approved 2026-11-14.** Every acceptance check passes; numbers below | STOP, with measured numbers |
| 3. Content and mobile | **Built and tested 2026-11-14, except what needs a real phone.** The device checklist (`docs/DEVICE-TESTING.md`) and the LAN HTTPS server are waiting for the user | |
| 4. Mac app | **Built and tested 2026-11-14 on this Mac.** Other Macs and a 120 Hz display: UNVERIFIED | |
| Dogfight feel (user request, 2026-11-15) | **In progress on branch `feature/dogfight`.** Energy, boost, brake and the heavy shot are built; tasks in [Dogfight feel](#dogfight-feel-before-phase-5) | The user approves before it is merged to `feature/v2-rebuild`, which deploys |
| 5. Demos integration | Not started. Direction from the user recorded under Phase 5 (reuse v1's payment flow; King of the Hill) | Separate approval, and a payment proposal first |

**Next action:** continue [Dogfight feel](#dogfight-feel-before-phase-5) at its first task not marked Done. Phases 1 to 4 are built. Phase 5 (Demos) needs separate approval and starts with a written payment proposal, not code. Open items that need the user: `npm run dev:lan` (it changes the Mac's keychain) and the phone checklist in `docs/DEVICE-TESTING.md`; opening the Mac app themselves.

## How to run it

| Command | What it does |
|---|---|
| `npm run server` | Game server on `127.0.0.1:8790` (Node runs the TypeScript directly; no build) |
| `npm run build` then `ORBIT_CLIENT_DIR=dist npm run server` | The production setup: one server gives out the built page and runs the game socket on the same address. The `Dockerfile` does this, listening on `PORT` |
| `npm run dev` | Vite on `localhost:5173`, proxying `/ws` to the game server. Open it in two windows and fly: A/D or the arrows turn, I/K or the arrows pitch, W/S change speed, Space fires, hold the mouse button to steer, 1 2 3 buy from the store, P shows the players. On a touch screen: stick on the left, buttons on the right |
| `npm run dev:lan` | The same over HTTPS to the local network, for a phone. **Its first run changes the Mac's keychain.** Read `docs/DEVICE-TESTING.md` first. Not run yet |
| `npm test` | Unit and virtual-time tests of the simulation, the netcode, the content and the client's logic (about 1 s) |
| `npm run test:integration` | Bots over real sockets (one for 60 s, four hunters for 60 s, four through the proxy with 2% real loss), server boot, production-bundle check. About 65 s |
| `npm run test:e2e` | Playwright against the minified production build with the debug hook on: single-client checks in Chromium and WebKit (determinism, flight, HUD and store), the installable app and touch controls in Chromium, the four-browser suite on three network profiles, resilience, the Mac app in a real window, and a Firefox smoke run. Starts its own server, `vite preview` and network proxy on ports 8797, 5273 and 8798. About 7 minutes; the Mac app tests open a window |
| `npm run test:load` | 16 bots firing without pause for 5 minutes; reports tick time, heap and bandwidth. `npm run test:load -- 60` for a shorter look |
| `npm run typecheck`, `npm run lint` | Must pass before a task is marked done |
| `npm run console-check` | Builds the production client, opens it in a real browser window for 40 s, and records the console, the renderer and the browser's verdict on installing it |
| `npm run app` | The Mac app from source, in a window, showing the last production build copied into it (run `npm run package:mac` once first) and connecting to `ws://127.0.0.1:8790/ws`. `app/config.json` sets where it loads from |
| `npm run package:mac` | Builds `release/Orbit Runner-darwin-arm64/Orbit Runner.app`, signs it ad hoc, starts it once against a server of its own and checks that it connects. About a minute |
| `npm run update-check` | A real update from one build to the next, in Chromium with a kept profile and in the Mac app. About two minutes; opens windows |
| `npm run results` | Rewrites the latest-results section of this file from `docs/results/` and fails if a gate fails |
| `npm run screenshot -- <dir> [phone]` | Stages a few moments and takes pictures of them |
| `npm run icons` | Redraws the app icons into `public/icons/` |
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
| Prediction, latency | Pass: 0 corrections and 0 late inputs over 60 s at 100 ± 20 ms and at 200 ± 50 ms round trip, warm-up included | same |
| Tick clock | Pass. From 10 s to 60 s on six link and frame-rate combinations the clock stays within 0.2% of real time, the worst recent input slack stays between 1.8 and 3.5 ticks, and typical slack stays under the cap of 6 | same |
| Death and respawn | Pass. A client flown into the planet predicts its death on the same tick (no correction), gets exactly one flagged teleport at respawn 180 ticks later, and the drawn ship never moves more than a frame of flight except for that one jump | same |
| Reconcile | Pass. A one-tick input the server never receives gives exactly 1 correction (under 0.5 units); every later acknowledged tick matches bit for bit | same |
| Server authority | Pass. A client flooding 100 future inputs every millisecond covers no more path than an honest one; one input per tick, first copy wins; malformed messages are counted and the 20th closes the connection | `tests/unit/room.test.ts` |
| Real socket | Pass. 60 s over a real `ws` connection: 3,598 inputs, 1,800 snapshots, 0 corrections, 0 missed, round trip 1.7 ms, slack 3.4 ticks | `tests/integration/realSocket.test.ts` |
| Browser | Pass in Chromium and in WebKit (the plan asked for Chromium only). 20 s flown by real key events: 0 corrections, 0 missed inputs. Chromium 60 frames a second (p99 16.8 ms), WebKit 100 (p99 12 ms) | `tests/e2e/flight.spec.ts` |
| Hygiene | Pass. `typecheck`, `lint`, `test` clean. The production bundle does not contain `__orbit`; the test build does | `tests/integration/bundle.test.ts` |

Not covered by these numbers:

- On a link whose delays jump by more than six ticks (100 ms), the slack is capped and some inputs are late by design. A test covers this. Phase 2 measured the cost on the lossy profile: 15–18% of inputs late, own-ship correction p95 at most 1.27 units.
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
- **The tick-clock controller was rewritten after review.** The first version met every acceptance check but drifted about one tick every 45 s on a clean link. The current one is described in `DECISIONS.md` 5.3.
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

<!-- Recorded at the end of Phase 2 (commit ff11047), before any content existed. Not regenerated since: the latest run is under Phase 3. -->

### Phase 2 results

Measured on this Mac (M3 Ultra) with headless browsers. Browser suite: 2026-11-13T23:27Z. Load test: 2026-11-13. Thresholds are in `tests/thresholds.ts`; raw numbers are in `docs/results/`. Distances are world units; a ship is 4.0 long. This section is generated from those files by `npm run results`.

**Thresholds from the brief**

| Threshold | Limit | Measured | Result |
|---|---|---|---|
| Remote position error p95, 100 ms profile | < 2.0 | 0.007 (worst of four clients) | Pass |
| Remote position error max, 100 ms profile | < 8.0 | 0.018 (worst of four) | Pass |
| No visible snaps, every profile | 0 frames over 3 × speed limit × frame time | 0 (worst of four clients on three profiles) | Pass |
| Own-ship corrections, 200 ms lossy profile | p95 < 4.0 | 1.221 (worst of four) | Pass |
| Own-ship corrections, clean network | none over 0.01 | largest 0.000; 0 corrections of any size | Pass |
| Hit agreement, 100 ms profile (ships kept alive) | ≥ 95% | 100.0% (lowest of four; fewest hits seen by one client: 57; server hits not shown: 0) | Pass |
| Load: tick time p99, 16 bots, 300 s | ≤ 8.33 ms | 1.76 ms (p50 0.72, worst single tick 8.80) | Pass |
| Load: heap after garbage collection, end against 1 minute | growth ≤ 10% | 13.0 MB → 8.6 MB (-34.4%) | Pass |
| Load: bandwidth per client | reported | 15.2 kB/s down in 39 messages/s | Reported |

No threshold failed.

**Clean profile (no added latency)**

| Client | Frames/s | Remote error p95 | Remote error max | Drawn past newest sample | Snaps | Own corrections | Correction p95 | Correction max | Hits confirmed of seen | Server hits not shown | Late inputs | View delay | Interp. delay |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Chromium desktop | 60 | 0.007 | 0.013 | 0.0% | 0 | 0 | 0.000 | 0.000 | 90 of 90 (100.0%) | 0 | 0.0% | 128 ms | 67 ms |
| WebKit desktop | 100 | 0.007 | 0.016 | 0.0% | 0 | 0 | 0.000 | 0.000 | 77 of 77 (100.0%) | 0 | 0.0% | 129 ms | 67 ms |
| iPhone 15 (WebKit) | 100 | 0.007 | 0.016 | 0.0% | 0 | 0 | 0.000 | 0.000 | 107 of 107 (100.0%) | 0 | 0.0% | 128 ms | 67 ms |
| Pixel 7 (Chromium) | 60 | 0.007 | 0.009 | 0.0% | 0 | 0 | 0.000 | 0.000 | 111 of 111 (100.0%) | 0 | 0.0% | 126 ms | 67 ms |

**100ms profile (100 ms round trip ± 20 ms)**

| Client | Frames/s | Remote error p95 | Remote error max | Drawn past newest sample | Snaps | Own corrections | Correction p95 | Correction max | Hits confirmed of seen | Server hits not shown | Late inputs | View delay | Interp. delay |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Chromium desktop | 60 | 0.007 | 0.015 | 0.0% | 0 | 0 | 0.000 | 0.000 | 112 of 112 (100.0%) | 0 | 0.0% | 232 ms | 70 ms |
| WebKit desktop | 100 | 0.007 | 0.018 | 0.0% | 0 | 0 | 0.000 | 0.000 | 57 of 57 (100.0%) | 0 | 0.0% | 232 ms | 71 ms |
| iPhone 15 (WebKit) | 100 | 0.007 | 0.018 | 0.0% | 0 | 0 | 0.000 | 0.000 | 134 of 134 (100.0%) | 0 | 0.0% | 232 ms | 70 ms |
| Pixel 7 (Chromium) | 60 | 0.007 | 0.010 | 0.0% | 0 | 0 | 0.000 | 0.000 | 109 of 109 (100.0%) | 0 | 0.0% | 222 ms | 71 ms |

**200ms-lossy profile (200 ms round trip ± 50 ms, 2% loss as an in-order 260 ms stall).** Only the snap and correction columns are gated on this profile; the rest is reported.

| Client | Frames/s | Remote error p95 | Remote error max | Drawn past newest sample | Snaps | Own corrections | Correction p95 | Correction max | Hits confirmed of seen | Server hits not shown | Late inputs | View delay | Interp. delay |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Chromium desktop | 60 | 0.058 | 3.313 | 7.9% | 0 | 114 | 0.481 | 1.013 | 118 of 118 (100.0%) | 0 | 18.2% | 350 ms | 250 ms |
| WebKit desktop | 100 | 0.027 | 0.401 | 4.9% | 0 | 129 | 0.254 | 0.444 | 139 of 141 (98.6%) | 0 | 15.3% | 350 ms | 250 ms |
| iPhone 15 (WebKit) | 100 | 0.041 | 0.572 | 7.7% | 0 | 114 | 0.286 | 0.358 | 85 of 85 (100.0%) | 0 | 15.4% | 350 ms | 250 ms |
| Pixel 7 (Chromium) | 60 | 0.027 | 0.482 | 5.2% | 0 | 105 | 1.221 | 1.599 | 90 of 90 (100.0%) | 0 | 15.2% | 350 ms | 250 ms |

How to read the tables:

- Each test takes two 20-second measurements. In each, two clients hunt and shoot while two fly erratically; then they swap. Ships are kept alive by a test hook, so the hit column measures lag compensation and not who died first.
- "Remote error" is the distance between where a client drew another ship and where the server had that ship at the moment being drawn.
- "Late inputs" is the share of the client's inputs that reached the server after their tick had been simulated.
- "View delay" is how far behind its own ship a client sees the others. The server honours up to 350 ms of it. "Interp. delay" is the part of that spent waiting so there are two samples to draw between.
- "Hits confirmed of seen" counts the hits a shooter's screen showed and whether the server agreed. "Server hits not shown" is the other direction: hits the server counted that the shooter's own test did not find, so the bullet vanishes and the damage lands without a hit flash.
- On the lossy profile the shooters' screens showed 434 hits and the server confirmed 432 of them (99.5%), and the server counted 0 hits that were not shown (0.0% of the server's hits; worst client 0). Neither figure is gated on this profile, where the view delay is pinned at the 350 ms cap. Before the fix of 2026-11-14 (a shot is tested again over past ticks when a correction changes it) the server counted 48 unshown hits here, 14.5% of its hits.
- Frame rates are headless browsers on a desktop GPU. They say nothing about phones.

**Hit agreement in real play (reported, not gated)**

Four hunter bots over real sockets through the proxy on the 100 ms profile, with real kills, regrouped every 12 s, 60 s: **140 of 145 hits seen by shooters were confirmed (96.6%)**, with 20 kills. Of the 5 not confirmed, 5 were on a ship another player had already destroyed on the server. The server decided 0 hits that the shooter's screen did not show. The gated figure above is higher because its ships cannot die; this run also clears 95%.

**Other acceptance checks**

| Check | Measured |
|---|---|
| One bot, real socket, 60 s | 3598 inputs, 1800 snapshots, 0 corrections, 0 late inputs, round trip 1.9 ms |
| Four hunters, real sockets, no added latency, 60 s | all joined and saw each other; 111 bullets, 35 server hits, 35 of 36 seen hits confirmed (97.2%), 5 kills |
| Loss mode `drop`: four hunters, 200 ms, 2% of inputs and snapshots discarded, 40 s | 323 messages dropped of 15536; 42 hits, 6 deaths; the server ran 0 ticks without an input; every bot ended in the right life of its ship and had heard of every death |
| Tab hidden for 3 s, 100 ms profile | the other player saw 0 snaps and at most 0.009 units of error over 481 frames; the hidden client resumed in its seat without reconnecting |
| Connections cut, 100 ms profile | both clients reconnected once and kept their player ids; nobody died (asserted by the test; no numbers) |
| Late joiner, 100 ms profile | drew both other ships within 0.002 units (p95) of the server, 0 snaps, and drew their bullets |
| Firefox 159.0 smoke run | WebGL2 yes, 99 frames a second, saw 1 other player, 0 corrections |
| Same simulation bits as Node: chromium 158.0.8127.18 | 10,000-tick hash equal, 0 fused multiply-adds in 2,000,000 tries, handshake fingerprint equal |
| Same simulation bits as Node: webkit 27.2 | 10,000-tick hash equal, 0 fused multiply-adds in 2,000,000 tries, handshake fingerprint equal |
| Same simulation bits as Node: firefox 159.0 | 10,000-tick hash equal, 0 fused multiply-adds in 2,000,000 tries, handshake fingerprint equal |

Load test detail: 16 bots in one place firing without pause for 300 s, about 137 bullets a second, each tested against 15 targets every tick. The server held 60.00 ticks a second with 0 catch-ups and 0 dropped ticks; 0.00% of inputs were late. Bandwidth is payload bytes handed to the sockets; WebSocket and TCP framing are extra.


What changed from the plan during Phase 2:

- **Shooter-view hits wait for the shot to be confirmed, and the client tracks a target's expected hit points.** Both were added after the first four-player test, where shooters saw hits on ships that were already dead. See `DECISIONS.md` 5.6.
- **The hit-agreement gate is measured with ships kept alive** by a test hook, because in a free-for-all some disagreement is inherent (two players shooting one ship). Kills and free-for-alls are measured separately and reported above.
- **The hidden-tab test fires the page's real `visibilitychange` handler** with `document.hidden` overridden. It does not make the browser freeze timers or drop the socket, which a real phone does.
- **Remote ships get a red dot** so players can find each other across the belt. v1 used the minimap for this, which is Phase 3.
- **The load test's bots do not hunt.** Sixteen hunters end up circling too close to line up shots and the fight dies down, so the load bots fly erratically and fire without pause. That keeps about 416 bullets in the air, which is the worst case.
- **`runSummary` and the admission interface are not built.** Nothing uses them before Phase 5. The room's listener delivers joins, leaves, deaths (with a unique id) and hits.
- **Tests share one server**, and the ten-second seat hold kept one test's players in the room at the start of the next, so each multi-client test waits for an empty room first.

UNVERIFIED after Phase 2 (nothing here has been measured on the real thing):

- **Frame rate, heat and battery on a real phone.** The "iPhone" and "Pixel" clients are desktop WebKit and Chromium with a phone's viewport and user agent, on this Mac's GPU.
- **Touch controls.** There are none yet (Phase 3). The pointer steering works with a finger in principle; not tried on a device.
- **Real iOS backgrounding.** The tests fire the visibility event; they do not suspend the page or kill the socket the way iOS does. The reconnect path is tested by cutting the socket.
- **A real network.** Latency, jitter and loss come from the proxy's model: uniform jitter, and loss as a 260 ms in-order stall. Real links have bursts and reordering below TCP that this does not model.
- **An x86 server with ARM clients.** The simulation is bit-identical across Node, Chromium, WebKit and Firefox on this ARM64 Mac (table above). `npm test` on an x86 machine settles it (the pinned-hash test).
- **A 120 Hz display.** Covered in virtual time only.
- **The Mac app.** Not built yet (Phase 4).
- **The ReadPixels warning in a GPU-backed Chrome.** Phase 3.

## Phase 3: content and mobile

Goal: v1's gameplay content and look, and proper phone support.

Tasks:

| # | Task | State |
|---|---|---|
| 0 | D8–D12 | Accepted at their defaults by the user, 2026-11-14 |
| 1 | Asteroid belt in the shared sim, ship and bullet collisions, near-miss sparks | Done |
| 2 | Orbs, server-owned: shield, pink, Fenix, Zaphire, wormhole, boost, miner, hunter | Done |
| 3 | Fenix; wormhole jump (D9); shield (D8); world edge (D11) | Done |
| 4 | Server-kept score, the store, scoreboard | Done. A shared all-time leaderboard needs accounts and is Phase 5 |
| 5 | HUD, map, name labels, death screen, kill feed | Done |
| 6 | Exhaust, bursts, camera shake, lighting, wormhole shader, Fenix model | Done |
| 7 | Touch stick and buttons, tilt option, rotate overlay, safe areas, settings | Done in code. Tilt and everything on a real phone: UNVERIFIED |
| 8 | Adaptive quality | Done in code. Never run on a slow device: UNVERIFIED |
| 8a | Idle rule, seat limit, welcome rate limit | Done |
| 9 | Installable app, opens offline, updates between lives | Done. A real update from one build to the next is checked by `npm run update-check` |
| 10 | LAN HTTPS dev server and iPhone instructions | Written, **not run** (it changes the Mac's keychain) |
| 11 | Console of a headed, GPU-backed browser | Done: no ReadPixels message |

Acceptance:

| Check | Pass condition | Result |
|---|---|---|
| Phase 2 suite | Still passes with content enabled | **Pass.** Numbers below, measured with 2,000 rocks and 1,360 orbs in the room |
| Content, unit | Each orb's effect, scoring rule and store purchase is decided by the server and covered by a test | **Pass.** `tests/unit/orbs.test.ts`, `scoring.test.ts`, `belt.test.ts` |
| Collisions | Asteroid and planet deaths are server-decided; a client cannot skip them | **Pass.** A client that sends nothing is still flown into the rock (`belt.test.ts`); the planet since Phase 1 |
| Touch | Stick and fire button drive the same input axes as the keyboard; two simultaneous pointers work | **Pass in Chromium** at a phone's screen size, with real touch events and three fingers at once (`tests/e2e/touch.spec.ts`). WebKit and real phones: UNVERIFIED |
| PWA | Manifest and service worker pass Chrome's install criteria; update is offered between lives | **Pass in Chromium; not run in Safari or Firefox.** Installing: in a real window Chromium 158 raises no objection to the production build and does object ("no-manifest") to a control page (`npm run console-check`). Headless Chromium raises none for any page, so the headless test checks the conditions one by one instead, and that the page opens offline (`tests/e2e/pwa.spec.ts`). A real update from one build to the next, with a kept profile: the old build keeps flying with the new one waiting, the page loads the new one when the ship is destroyed and comes back to the same seat and points (`npm run update-check`) |
| LAN | The dev build loads over HTTPS from a second device on the LAN, including the game socket | **Not run.** Needs the user: `docs/DEVICE-TESTING.md` |
| ReadPixels | Absent from the headed Chrome console, or root-caused and fixed | **Pass.** Absent, in headed Chromium 158 on this Mac's GPU at 100 frames a second |
| Devices | Manual checklist run by the user; results recorded | **Not run.** `docs/DEVICE-TESTING.md` has the 18 checks. Until then: UNVERIFIED |

<!-- RESULTS:START (written by scripts/results.ts; do not edit by hand) -->

### Latest results, with all content switched on

The Phase 2 suite run again on the current build: 2,000 rocks, 1,360 orbs, Fenix ships, scoring and the store all in play. Measured on this Mac (M3 Ultra) with headless browsers. Browser suite: 2026-11-14T01:48Z. Load test: 2026-11-14. Thresholds are in `tests/thresholds.ts`; raw numbers are in `docs/results/`. Distances are world units; a ship is 4.0 long. This section is generated from those files by `npm run results`.

**Thresholds from the brief**

| Threshold | Limit | Measured | Result |
|---|---|---|---|
| Remote position error p95, 100 ms profile | < 2.0 | 0.007 (worst of four clients) | Pass |
| Remote position error max, 100 ms profile | < 8.0 | 0.018 (worst of four) | Pass |
| No visible snaps, every profile | 0 frames over 3 × speed limit × frame time | 0 (worst of four clients on three profiles) | Pass |
| Own-ship corrections, 200 ms lossy profile | p95 < 4.0 | 0.836 (worst of four) | Pass |
| Own-ship corrections, clean network | none over 0.01 | largest 0.000; 0 corrections of any size | Pass |
| Hit agreement, 100 ms profile (ships kept alive) | ≥ 95% | 100.0% (lowest of four; fewest hits seen by one client: 79; server hits not shown: 0) | Pass |
| Load: tick time p99, 16 bots, 300 s | ≤ 8.33 ms | 2.21 ms (p50 1.24, worst single tick 8.48) | Pass |
| Load: heap after garbage collection, end against 1 minute | growth ≤ 10% | 14.5 MB → 10.0 MB (-31.2%) | Pass |
| Load: bandwidth per client | reported | 16.3 kB/s down in 40 messages/s | Reported |

No threshold failed.

**Clean profile (no added latency)**

| Client | Frames/s | Remote error p95 | Remote error max | Drawn past newest sample | Snaps | Own corrections | Correction p95 | Correction max | Hits confirmed of seen | Server hits not shown | Late inputs | View delay | Interp. delay |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Chromium desktop | 60 | 0.008 | 0.017 | 0.0% | 0 | 0 | 0.000 | 0.000 | 77 of 77 (100.0%) | 0 | 0.0% | 133 ms | 67 ms |
| WebKit desktop | 100 | 0.007 | 0.017 | 0.0% | 0 | 0 | 0.000 | 0.000 | 99 of 99 (100.0%) | 0 | 0.0% | 123 ms | 67 ms |
| iPhone 15 (WebKit) | 100 | 0.007 | 0.017 | 0.0% | 0 | 0 | 0.000 | 0.000 | 102 of 102 (100.0%) | 0 | 0.0% | 131 ms | 67 ms |
| Pixel 7 (Chromium) | 60 | 0.007 | 0.011 | 0.0% | 0 | 0 | 0.000 | 0.000 | 99 of 99 (100.0%) | 0 | 0.0% | 118 ms | 67 ms |

**100ms profile (100 ms round trip ± 20 ms)**

| Client | Frames/s | Remote error p95 | Remote error max | Drawn past newest sample | Snaps | Own corrections | Correction p95 | Correction max | Hits confirmed of seen | Server hits not shown | Late inputs | View delay | Interp. delay |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Chromium desktop | 60 | 0.007 | 0.014 | 0.0% | 0 | 0 | 0.000 | 0.000 | 79 of 79 (100.0%) | 0 | 0.0% | 229 ms | 71 ms |
| WebKit desktop | 100 | 0.007 | 0.018 | 0.0% | 0 | 0 | 0.000 | 0.000 | 101 of 101 (100.0%) | 0 | 0.0% | 239 ms | 79 ms |
| iPhone 15 (WebKit) | 100 | 0.007 | 0.018 | 0.0% | 0 | 0 | 0.000 | 0.000 | 105 of 105 (100.0%) | 0 | 0.0% | 229 ms | 70 ms |
| Pixel 7 (Chromium) | 60 | 0.007 | 0.010 | 0.0% | 0 | 0 | 0.000 | 0.000 | 105 of 105 (100.0%) | 0 | 0.0% | 222 ms | 70 ms |

**200ms-lossy profile (200 ms round trip ± 50 ms, 2% loss as an in-order 260 ms stall).** Only the snap and correction columns are gated on this profile; the rest is reported.

| Client | Frames/s | Remote error p95 | Remote error max | Drawn past newest sample | Snaps | Own corrections | Correction p95 | Correction max | Hits confirmed of seen | Server hits not shown | Late inputs | View delay | Interp. delay |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Chromium desktop | 60 | 0.048 | 1.624 | 7.6% | 0 | 114 | 0.199 | 0.367 | 47 of 48 (97.9%) | 1 | 18.1% | 350 ms | 250 ms |
| WebKit desktop | 100 | 0.025 | 0.457 | 4.8% | 0 | 107 | 0.258 | 0.481 | 90 of 91 (98.9%) | 0 | 14.7% | 350 ms | 250 ms |
| iPhone 15 (WebKit) | 100 | 0.039 | 0.507 | 6.6% | 0 | 133 | 0.209 | 0.405 | 25 of 26 (96.2%) | 0 | 15.5% | 350 ms | 250 ms |
| Pixel 7 (Chromium) | 60 | 0.021 | 0.305 | 4.7% | 0 | 104 | 0.836 | 1.553 | 38 of 40 (95.0%) | 0 | 15.4% | 350 ms | 250 ms |

How to read the tables:

- Each test takes two 20-second measurements. In each, two clients hunt and shoot while two fly erratically; then they swap. Ships are kept alive by a test hook, so the hit column measures lag compensation and not who died first.
- "Remote error" is the distance between where a client drew another ship and where the server had that ship at the moment being drawn.
- "Late inputs" is the share of the client's inputs that reached the server after their tick had been simulated.
- "View delay" is how far behind its own ship a client sees the others. The server honours up to 350 ms of it. "Interp. delay" is the part of that spent waiting so there are two samples to draw between.
- "Hits confirmed of seen" counts the hits a shooter's screen showed and whether the server agreed. "Server hits not shown" is the other direction: hits the server counted that the shooter's own test did not find, so the bullet vanishes and the damage lands without a hit flash.
- On the lossy profile the shooters' screens showed 205 hits and the server confirmed 200 of them (97.6%), and the server counted 1 hits that were not shown (0.5% of the server's hits; worst client 1). Neither figure is gated on this profile, where the view delay is pinned at the 350 ms cap.
- A correction of size 0.000 moved nothing; a field other than position differed. Here it is the hull: the fights run among the rocks, a client rightly predicts the hull lost in a crash, and the test's keep-alive hook then gives it back on the server. One crash under the hook is one such correction (checked in virtual time: none without the hook).
- Frame rates are headless browsers on a desktop GPU. They say nothing about phones.

**Hit agreement in real play (reported, not gated)**

Four hunter bots over real sockets through the proxy on the 100 ms profile, with real kills, regrouped every 12 s, 60 s: **117 of 123 hits seen by shooters were confirmed (95.1%)**, with 16 kills. Of the 6 not confirmed, 6 were on a ship another player had already destroyed on the server. The server decided 2 hits that the shooter's screen did not show. The gated figure above is higher because its ships cannot die; this run also clears 95%.

**Other acceptance checks**

| Check | Measured |
|---|---|
| One bot, real socket, 60 s | 3598 inputs, 1800 snapshots, 0 corrections, 0 late inputs, round trip 1.7 ms |
| Four hunters, real sockets, no added latency, 60 s | all joined and saw each other; 111 bullets, 35 server hits, 35 of 36 seen hits confirmed (97.2%), 5 kills |
| Loss mode `drop`: four hunters, 200 ms, 2% of inputs and snapshots discarded, 40 s | 321 messages dropped of 15748; 42 hits, 6 deaths; the server ran 0 ticks without an input; every bot ended in the right life of its ship and had heard of every death |
| Tab hidden for 3 s, 100 ms profile | the other player saw 0 snaps and at most 0.011 units of error over 480 frames; the hidden client resumed in its seat without reconnecting |
| Connections cut, 100 ms profile | both clients reconnected once and kept their player ids; nobody died (asserted by the test; no numbers) |
| Late joiner, 100 ms profile | drew both other ships within 0.002 units (p95) of the server, 0 snaps, and drew their bullets |
| Firefox 159.0 smoke run | WebGL2 yes, 59 frames a second, saw 1 other player, 0 corrections |
| Same simulation bits as Node: chromium 158.0.8127.18 | 10,000-tick hash equal, 0 fused multiply-adds in 2,000,000 tries, handshake fingerprint equal |
| Same simulation bits as Node: webkit 27.2 | 10,000-tick hash equal, 0 fused multiply-adds in 2,000,000 tries, handshake fingerprint equal |
| Same simulation bits as Node: firefox 159.0 | 10,000-tick hash equal, 0 fused multiply-adds in 2,000,000 tries, handshake fingerprint equal |
| Headed browser on this Mac's GPU, 30 s of play | Chromium 158.0.8127.18, headed; ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Ultra, Unspecified Version); 100 frames a second; 0 console warnings or errors; 0 "ReadPixels" messages; software rendering no |
| Can it be installed? The browser's own verdict, same headed run, production build | objections to the game: none; to a control page with no manifest: no-manifest |
| A real update in Chromium, profile kept between visits (`npm run update-check`) | first visit: build A. Build B put on the server. Second visit: build A opens and is still flying 3 s later (A) with the new one waiting; when the ship is destroyed the page loads build B, in the same seat (yes) with its points (yes). Third visit: build B |
| The same update in the Mac app, four starts with one profile | builds shown: A, B, B, B; service workers registered: 0 |
| Mac app from source, in a window on this Mac's 100 Hz display, 15 s of flying | Electron 45.3.2 (Chromium 156.0.8078.100); 100.0 frames a second; frame time p50 10.0 ms, p99 12.0 ms, worst 12.1 ms; 0 corrections, largest 0.000 |
| The packaged, ad hoc signed app (`npm run package:mac`), started once | release/Orbit Runner-darwin-arm64/Orbit Runner.app, 254 MB; opened, connected (1 player in the room), showed "Hull 100"; packaged build yes; debug hook in it no; 0 console warnings or errors |

Load test detail: 16 bots in one place firing without pause for 300 s, about 137 bullets a second, each tested against 15 targets every tick. The server held 60.00 ticks a second with 0 catch-ups and 0 dropped ticks; 0.00% of inputs were late. Bandwidth is payload bytes handed to the sockets; WebSocket and TCP framing are extra.

<!-- RESULTS:END -->

UNVERIFIED after Phase 3:

- Everything on a real phone: frame rate, heat, touch in Safari, tilt steering, safe areas, backgrounding, Add to Home Screen. The "iPhone 15" and "Pixel 7" rows above are those screen sizes inside desktop browser engines.
- The service worker in Safari and Firefox: opening offline and the update between lives are checked in Chromium only. The iPhone's Home Screen app is Safari.
- Tilt steering has never run on a device. Its sign convention is written down and unit-tested, which shows it is consistent, not that it is right.
- The quality controller has only seen made-up frame times.
- The LAN HTTPS server and the certificate steps.
- x86: determinism is measured on ARM64 only (as in Phase 1).

What changed from the plan during Phase 3 (`DECISIONS.md` 5.10 and Appendix A.2 have the reasons):

- **Rocks are drawn at the own ship's moment in time.** Other ships are drawn a view delay earlier, so another ship can appear to clip a rock.
- **No drifting rocks outside the ring**, and a destroyed rock is back after 30 s.
- **Orbs sit still on the ring** and come back 30 s after being taken.
- **A shot orb acts on the shooter half a second later**, on a tick the server names, so the shooter's client is not corrected. v1 applied it at once.
- **A kill pays 330** (doubled over the belt and by the hunter orb). v1 paid that only for bots.
- **The store sells one thing per Zaphire orb, within 20 s**, and refuses what would change nothing.
- **Points are kept across lives.**
- **Two minutes without a control moving destroys the ship** until one moves. After five minutes the seat is given up and the client is told why, so the page does not reconnect and take it straight back.
- **A copied session token does not share a seat.** A duplicated browser tab copies the token. The server waits up to half a second: if the first connection sends another input, the newcomer is a second player; if it stays silent or closes, the newcomer is the same player reloading and takes the seat.
- **Choices that were not in the plan are numbered D13–D20** in `DECISIONS.md` section 1, each with the alternative, so that they can be overruled.
- **A page reload keeps the seat** (the session token is kept for the life of the tab).
- **The mechanism tests run in emptier space.** Tests of one rock, one orb or a duel use a thin belt or no orbs so that one thing decides the result; they say so where they do. The browser suite, the real-socket tests and the load test run with everything on.

## Phase 4: Mac app

Goal: the same game in a Mac app, driven by the same tests.

What was built (`app/`, three small files, plain JavaScript):

- `main.mjs`: one window. If `gameUrl` in `app/config.json` is set, the window shows the game from that address, page and socket both, which is the normal case once the game is deployed: the app can never be out of step with the server's rules. If it is empty, the window shows the copy of the client packed into the app, from `app://game/`, and its socket goes to `serverUrl`. That is for one machine: a packed client is refused by the server as soon as the rules change.
- `preload.cjs`: tells the page it is in the app and, for the packed copy, which socket to use. Nothing of Node is within the page's reach.
- The page may show only the one origin it was started with, cannot open windows, is refused every permission, and the packed copy carries a content security policy that lets it load its own files and reach its game server and nothing else.
- `npm run package:mac` builds the `.app`, signs it ad hoc and starts it once to check it.

Acceptance:

| Check | Pass condition | Result |
|---|---|---|
| Smoke test | Playwright launches the app, it connects and flies | **Pass**, both ways of loading the client (`tests/e2e/macapp.spec.ts`): flies by keyboard with zero corrections; the page cannot reach Node, be sent elsewhere, open a window or read a file outside the client's folder |
| The `.app` | Opens on this Mac | **Pass.** `npm run package:mac` starts the packaged, signed app: it opens, connects, shows the game, has no debug hook and logs nothing to the console. 254 MB |
| Frame pacing | Recorded as measured, or UNVERIFIED | **Measured on this Mac's display, which is 100 Hz:** 100.0 frames a second, frame time p50 10.0 ms, p99 12.0 ms, worst 12.1 ms over 15 s. **A 120 Hz display is UNVERIFIED**: there is none here |

Numbers are in the latest-results table under Phase 3.

UNVERIFIED after Phase 4:

- Any other Mac. The app is signed ad hoc, which this Mac accepts because it was built here. Gatekeeper rejects it (`spctl` says so) as it would on another Mac after a download; handing it to someone needs an Apple Developer ID and notarisation, which is not done.
- A 120 Hz display, an Intel Mac, and a Mac's built-in GPU on battery.
- The user opening it by hand: fullscreen, the Dock icon, quitting. The tests drive it through a debugger connection.

Found while building, and what was done:

- **Under Electron 45, a start with a service worker's update waiting never finished loading** (the window sat on an empty address, on every later start too). Chromium itself has no such trouble: the same three visits there end on the new build. The cause in Electron was not found. The Mac app therefore registers no service worker; it has no use for one, since it loads the page from the network or from inside itself at every start. `npm run update-check` runs four starts across an update.
- **Test runs of the app were writing a browser profile into `~/Library/Application Support/Electron`.** The tests and scripts now give the app a temporary profile folder and remove it; the stray folder, created by those runs, was deleted.
- **A top-level `await app.whenReady()` in the app's main file makes Playwright's launch hang**, because Playwright holds back "ready" until the file has loaded.

Changing where the packaged app connects: `config.json` is sealed inside the app, so either rebuild after editing `app/config.json`, or start the app with `ORBIT_GAME_URL` or `ORBIT_SERVER_URL` set. As packaged it shows its own copy of the client and connects to `ws://127.0.0.1:8790/ws`.

Manual checks for the user, when convenient: open `release/Orbit Runner-darwin-arm64/Orbit Runner.app` with `npm run server` running; fly; fullscreen and back; quit.

## Dogfight feel (before Phase 5)

Asked for by the user on 2026-11-15 and approved to come before Phase 5: fights should be about readable choices. Built in three steps; this section is step 1, in the free-for-all room that exists. Step 2 is a match around it (3-minute rounds, a score to reach, 1v1 and 2v2 with team colours); step 3 is zone control and the other modes. The user's first mode is a 3-minute 2v2 "Belt Duel".

Work is on `feature/dogfight`, one commit a task. Nothing here is on the live site until the user approves a merge into `feature/v2-rebuild`. Each task changes the wire format, so the Mac app must be rebuilt after a merge.

The rule for every task: anything that changes how the ship moves or what it can do lives in the shared ship state and step, or arrives on a named tick, so the client predicts it with zero corrections as it does everything else.

| # | Task | State |
|---|---|---|
| 1 | Energy; boost and brake buttons that spend it (D21) | Done. Predicted with zero corrections on the clean and 100 ms links (`tests/unit/netcode.test.ts`) |
| 2 | Heavy shot: slow, fat, straight, two a life (D22) | Done. Fired, predicted and decided through the room with no correction (`tests/unit/combat.test.ts`) |
| 3 | Charged homing shot: the server steers it; a hard break evades it; the target is warned | Not started |
| 4 | Fenix orb keeps the transformation and adds a timed weapon upgrade (user's choice, 2026-11-15) | Not started |
| 5 | Feedback on the client: shield-coloured flash, smoke on a low hull, a short slow-motion camera on a kill. Shake and exhaust exist | Not started |

Turn speed is one number, `SIM.yawRate`: a half turn takes 1.57 s (`tests/unit/ship.test.ts`). Unchanged so far.

## Phase 5: Demos integration (separate approval)

Before any code: a written proposal for how phone and Mac-app players pay or play free (`DECISIONS.md` section 10), and a review of the economy rules against Appendix B. Known constraints: `@kynesyslabs/demosdk` >= 4.0.5 (4.0.21 is current), ESM only, Node >= 22.15; on-chain amounts in OS units (1 DEM = 1e9 OS).

Design points already fixed so this fits without rework: server-decided kills and survival time, a unique ID per death, admission and economy behind interfaces.

User direction, 2026-11-14:

- Wallets and payments are wanted in v2. v1's payment flow (DEMOS entry, treasury payouts, Postgres) keeps running as the `orbit-runner` Railway service and should be reused where its architecture fits, rather than rewritten.
- Competitions come next, starting with **King of the Hill**: the player with the most kills holds the title and a bounty; whoever destroys them takes both. The server already decides every kill and gives each death a unique ID, which is what a bounty needs.

## Manual device checklist

Phones: `docs/DEVICE-TESTING.md` (18 checks, with the LAN HTTPS steps). Not run yet.

**Mac app**: see the manual checks at the end of the Phase 4 section.

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

### 2026-11-13: Phase 2

- Built in this order, committing after each: shared layer (HP, firing, bullets, quantised remote samples, the shared interpolation function, wire format v2); room (bullets, lag-compensated hits, tiers, events, tokens, seat hold); client (remote timeline, predicted bullets, shooter-view hit test, session); virtual-time combat tests; browser client (other ships, bullets, HUD); bots, proxy and test hooks; the four-browser Playwright suite; the load test.
- After Phase 1's review: confirmed v1's working tree is unchanged from the Phase 0 baseline; added the fused-multiply probe, the pinned trace hash and the simulation fingerprint in the handshake; rewrote the tick-clock controller, which had been drifting.
- Found by tests and fixed: hits shown for shots the server never fired; one or two extra hits shown on every destroyed ship; the tick clock reading its own adjustments as jitter; the drawn ship skipping a tick at the moment of death.
- Found by tests and left as designed: on the lossy profile the view delay sits at its 350 ms cap, so the shooter must lead.
- Found by the final run of 2026-11-13 and **fixed on 2026-11-14**: on the lossy profile the server counted 48 hits (14.5% of its hits) that the shooter was never shown. Cause, found by replaying the fight in virtual time and sorting every unshown hit: with late inputs the client predicts a shot from a ship position the server then corrects; the rebuilt shot was only tested from the present tick on, and the hit already found for the old one was thrown away. The client now tests a new or replaced shot over the ticks it has already flown, takes the server's shot when it was fired from somewhere else, and takes back damage noted for a discarded hit. After the fix: 0 unshown hits on all four browsers on the lossy profile, 432 of 434 shown hits confirmed. `tests/unit/combat.test.ts` has the test (24% unshown without the fix).
- Not done in Phase 2, by design: touch controls, asteroids, orbs, scoring, minimap, sound, PWA, Mac app.

Blockers: none.

### 2026-11-14: Phase 3

- The user approved Phase 2, asked for the unshown-hits fix before Phase 3 (done first; see the Phase 2 log) and accepted D8–D12 at their defaults.
- Built in this order, committing after each: asteroid belt; orbs, Fenix, wormholes and the world edge; scoring, store and scoreboard; HUD; visuals; touch, tilt and settings; adaptive quality; room rules; installable app; LAN HTTPS setup; the headed console check.
- Wire format went from version 2 to 6 (belt, orbs, scoring, the idle refusal). The pinned trace hash is 1339382450; Chromium, WebKit and Firefox agree with Node on it.
- Re-read from v1 while porting: the ring's creation and orbit update, the crash, bullets against rocks, lights, exhaust, bursts and camera shake, by line. The orb, Fenix, wormhole, store, scoring and HUD rules were extracted by a helper reading `main.js` (read-only) and spot-checked by line for the constants that went into `src/shared` (pickup radius, wormhole distance, store prices, boost length, belt income, Fenix speed).
- Found by tests and fixed while building: a wormhole jump in a duel fixture (fixtures that test one mechanism now leave orbs out); the store panel covering the ship and the thumbs on a phone-sized screen (moved to the top).
- Raised in review before building and designed for: effects delivered a round trip late would have broken the clean-network gate (hence the shared step and the named tick); world state must not go through the 2,800-unit event filter; the shooter's hit-point tracking had to learn about shields and 30-damage beams.
- Advisories: `npm audit` lists 14 (2 low, 12 moderate) under three packages: `minimatch` and `glob` in ESLint's tree, and `deepmerge` and `glob` under `workbox-build`, which `vite-plugin-pwa` runs at build time to write the service worker. All three are tools that run on this machine during a build; `npm audit --omit=dev` finds none, and none of the three names appears in the built client. Not acted on: the fixes on offer downgrade `vite-plugin-pwa` and `typescript-eslint`.
- Corrected after review: the seat limit was first tested on a bare client; the page runs a session, which reconnected and took a seat straight back. The installability check was first run headless, where it cannot fail.
- Not done, by design: bombs (paid in DEM), accounts, names and a shared leaderboard (Phase 5); sound (v1 has none).

Blockers: none for Phase 4. For closing Phase 3's last two rows: the user's phones, and their say-so for `npm run dev:lan`.

### 2026-11-14: Phase 4

- Spiked first: Playwright can launch Electron 45 and see the window, once the main file has no top-level await.
- Built `app/` (main process, preload, config), the smoke tests, the packaging script (which starts what it built), and `npm run update-check`.
- The update check found that the Mac app hung on start whenever a service worker update was waiting; the app no longer uses a service worker. The same check confirmed the browser's update path end to end, which Phase 3 had left unverified: update held while flying, applied at death, same seat and points afterwards.
- A first version of that check destroyed the wrong player's ship (the previous visit's held seat) and so "showed" that updates never applied. The check now asks the page which player it is.
- Electron and the packager are development tools only; `npm audit --omit=dev` still finds nothing.
- After review: a reload could have lost its seat if the new page's hello beat the old socket's close; the server now waits to see whether the old connection speaks again (`tests/unit/room.test.ts`). Every measured suite was then run again on one tree.
- Done outside the repository, for the record: Electron's binary (about 100 MB) and the mkcert plugin's package were downloaded by `npm install` (mkcert itself was not downloaded or run); browser and app windows were opened on the desktop by the headed checks and the Mac app tests, for under a minute each; `~/Library/Application Support/Electron`, a profile folder created by the first app test runs at 02:12 on 2026-11-14, was deleted after confirming its creation time, and the tests now use temporary folders; `release/` in the repository holds the 254 MB app and is ignored by git.

Blockers: none. Waiting for the user: Phase 5 needs separate approval.

### 2026-11-14: phone test and first deploy

- The phone checklist was run on an iPhone through Tailscale: 16 of 18 passed. Fixed since: double-tap zoom (#6), and a dropped connection now keeps its seat and points for five minutes instead of losing them after 10 s (#13, decision D6). #13 is waiting for the user to check again.
- The default port moved from 8787 to 8790; another local service held 8787.
- The server can now serve the built client itself (`ORBIT_CLIENT_DIR`) and listens on `PORT`, so one container holds the whole game. `Dockerfile` and `railway.json` deploy it to Railway as a new `orbit-runner-v2` service in the `delightful-radiance` project, beside v1, which is left as it was.

### 2026-11-15: stars, hull colour, and the start of dogfight feel

- On a phone the stars read bigger than the belt's rocks, and the player's own near-black hull vanished against space. Stars are now 1 pixel and mostly faint; the own ship has the light hull other players have. Deployed.
- Bombs: v1 has them (`main.js:357`), paid in DEM. Left out of v2 on purpose until Phase 5.
- Dogfight feel, task 1: energy with boost and brake (D21). Wire format 6 to 7; the pinned trace hash is now 4204857823, and Chromium, WebKit and Firefox agree with Node on it. The full browser suite passes, 22 of 22.
- Dogfight feel, task 2: the heavy shot (D22). A bullet's `beam` flag became a kind of shot (bullet, beam, heavy), so the straight-line maths, lag compensation and events are shared. A ship fires one thing a tick. Wire format 8; trace hash 3094701666.
