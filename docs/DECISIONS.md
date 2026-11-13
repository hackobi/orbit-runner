# Orbit Runner v2: decisions

Phase 0 output. Written 2026-11-13 and approved the same day with defaults D1–D7. Phases 1 and 2 are built; where building changed or confirmed something, the text says so ("As built"). `PLAN.md` has the status and the measured numbers.

How to read the evidence labels:

- **Checked**: read from a primary source on 2026-11-13 (link in [Sources](#sources)), or from v1 code with a line number.
- **Unconfirmed**: no primary source found. These are listed in [What is still unconfirmed](#what-is-still-unconfirmed) with the phase that resolves each.
- **Derived**: my arithmetic or reasoning from checked facts.

Line numbers refer to v1 at `/Users/jacobo/Documents/Claude/orbit-runner`, branch `feature/multiplayer-pvp`, commit `42757f5`. `main.js:N` is the client, `server:N` is `server/index.js`.

## 1. Decisions that need your answer

Each has a default. If you approve the plan without comment, the defaults apply. **The user approved D1–D7 on 2026-11-13 and D8–D12 on 2026-11-14, all at their defaults.**

| # | Decision | Default | Alternative | Needed by |
|---|---|---|---|---|
| D1 | Netcode: write it or use Colyseus 0.18 | Write it, on plain `ws` ([section 4](#4-netcode-library-write-it-or-use-colyseus)) | Colyseus 0.18 built-in prediction and rewind | Phase 1 |
| D2 | Shooting model | Server-simulated projectiles (v1's 230 u/s bullets), each tested against targets rewound by the shooter's view delay ([5.6](#56-shots-and-lag-compensation)) | Hitscan with a cosmetic tracer | Phase 2 |
| D3 | Meaning of "100 ms ± 20 ms" | Round trip: 50 ± 10 ms each way | One-way: twice as harsh | Phase 2 |
| D4 | Meaning of "2% loss" on a WebSocket | A lost message arrives late and holds up everything behind it, as TCP does. This is harsh: about a third of the time the input stream is stalled ([7.2](#72-network-profiles)) | Messages are dropped, which is milder but is not what a WebSocket does | Phase 2 |
| D5 | Death in free play | Respawn after 3 s in the belt with 1.3 s invulnerability. "Death = exit, pay again" becomes a room rule switched on in Phase 5 | Death always exits | Phase 2 |
| D6 | Disconnect or backgrounded tab | Seat held 10 s. The ship flies straight and can be hit. After 10 s it dies with cause `disconnect` | v1 rule: disconnect is instant death | Phase 2 |
| D7 | Mac wrapper | Electron ([section 9](#9-mac-app)) | Tauri 2, or no wrapper (installed PWA) | Phase 4 |
| D8 | Shield | Shield absorbs damage first, overflow goes to HP. In v1 it absorbs nothing ([A.3](#a3-v1-behaviours-that-look-accidental)) | Keep v1: a second meter that drains alongside HP | Phase 3 |
| D9 | Wormhole exit | Another wormhole at least 5,000 units away inside the belt. v1 always throws you 12,000 to 20,000 units out | Keep v1 | Phase 3 |
| D10 | Pitch direction | Keep v1: Up / I pushes the nose toward −Y. Add an invert option in settings | Flip it | Phase 3 |
| D11 | World edge | Keep v1's Y clamp of ±500. Add a combat-zone radius of 9,000 in XZ; outside it the hull takes damage | No XZ limit, as v1 | Phase 3 |
| D12 | Pointer steering direction (found in Phase 1) | Keep v1: while the pointer is held, the ship turns away from it, as if dragging the view. Pointer right of centre turns left; pointer below centre lifts the nose ([A.3](#a3-v1-behaviours-that-look-accidental)) | Steer toward the pointer, which is what v1's broken M-mode did | Phase 3 |

Kept from v1 without asking, because they read as intended feel: ring asteroids orbiting at 43 to 218 u/s (faster than the ship), Fenix obtained only by shooting its orb and lasting until death, +500 points per PvP hit.

Removed without asking: the dev turbo flag (500 u/s) and the teleport flag, which v1's server accepts from any player (server:2446, server:2788). They exist only in dev and test builds in v2.

## 2. What went wrong in v1, and what replaces it

| v1 problem (evidence) | v2 mechanism |
|---|---|
| Two physics engines. The server integrated yaw, pitch and speed (server:3020) while the client ran its own update (main.js:8697). Remote ships appeared about 18,000 units off (commit `84b78b6`) | One `src/shared/sim` module, imported by server, browser and bots. A lint rule and tsconfig forbid DOM or Node imports in it |
| Client-authoritative position. `msg.p` and `msg.q` are copied into server state unvalidated (server:2438-2443) | Clients send tick-numbered inputs only. The protocol has no position field in the client-to-server direction |
| Client-claimed hits. `player-hit` is applied after clamping damage to 1–50 (server:2508-2521). No range, cooldown or self-target check | The server simulates every bullet. The protocol has no hit message from client to server |
| Floaty remotes. `r.mesh.position.lerp(serverP, 0.02)` per frame from the latest sample only (main.js:9986). A 30-sample buffer is kept and never interpolated | Snapshot buffer, interpolation in the past, capped extrapolation, time-based smoothing |
| 50 Hz `setInterval`, 47 bytes × all players to all sockets, `INTEREST_RADIUS = Infinity` (server:2803, 3248, 3390) | Fixed-step accumulator loop, 30 Hz snapshots, two interest tiers, measured bandwidth |
| Touch is `touchmove` mapped to the mouse variables, and throws because `gameStarted` is never declared (main.js:6527) | Pointer Events virtual stick and buttons, optional tilt ([section 8](#8-platforms)) |
| "GPU stall due to ReadPixels" at startup | See [3.2](#32-the-readpixels-startup-stall) |
| Reverted reconcile attempts (`580df20`, `9fcf65f`, `b15fc28`, `0a69b14`) blended toward server state by a fixed fraction instead of replaying inputs | Rewind to the acknowledged tick and replay unacknowledged inputs ([5.4](#54-own-ship-prediction-and-reconciliation)) |

## 3. Stack

| Part | Choice | Version checked | Why |
|---|---|---|---|
| Runtime | Node | 22.22.3 installed; require >= 22.19 | Vitest 5 needs ^22.12, ESLint 10 needs ^22.13, `vite-plugin-mkcert` needs >= 22.19, Demos SDK needs >= 22.15 |
| Language | TypeScript, strict | **6.0.3**, not `latest` (7.0.2) | `typescript-eslint` 8.72.2 peers on `typescript >=4.8.4 <6.1.0` (checked on the registry). TS 7.0 ships no compiler API yet. Move to 7 when typescript-eslint supports it |
| Server TypeScript | Run `.ts` directly with Node | Tested on 22.22.3 | No server build step. Needs `erasableSyntaxOnly` (no enums or parameter properties) and `.ts` import extensions. Fallback: `tsx` 4.23.15 |
| Build | Vite | 8.3.8 | Required by the brief. Vite 8 bundles with Rolldown |
| Renderer | Three.js `WebGLRenderer` (WebGL2) | 0.187.0 | See [3.1](#31-webgl2-or-webgpu) |
| Unit tests | Vitest | 5.1.0 | Required by the brief |
| End-to-end | Playwright | 1.65.0 (Chromium 158, WebKit 27.2, Firefox 159) | Required by the brief. Also drives Electron |
| Lint and format | ESLint + typescript-eslint, Prettier | 10.14.0, 8.72.2, 3.10.1 | Type-aware rules such as no-floating-promises matter in network code |
| Server sockets | `ws` | 8.23.0 | Baseline transport. Disables Nagle by default (`lib/websocket.js:269`), `perMessageDeflate` off by default |
| PWA | `vite-plugin-pwa` | 2.0.0 | Peers on Vite up to 8 |
| LAN HTTPS | `vite-plugin-mkcert` | 2.1.0 | See [8.4](#84-device-testing-over-the-lan) |
| Package manager | npm | 10.9.8 installed | Already present; pnpm is not installed |

One package, not a monorepo: `src/shared`, `src/net`, `src/client`, `src/server`, `tests`. Each has its own tsconfig so `shared` and `net` cannot see DOM or Node types.

### 3.1 WebGL2 or WebGPU

**Decision: `WebGLRenderer`. No measured reason to switch.**

- The three.js manual for r187 says `WebGPURenderer` "is still in an experimental state" and that you may find "a better performance with `WebGLRenderer`". It calls `WebGLRenderer` "still maintained and the recommended choice for pure WebGL 2 applications".
- Open three.js reports measure `WebGPURenderer` as slower to initialise materials (16–36× in one collaborator's test, issue 33821) and about 2× CPU per frame in one user's r183 test. I found no iOS benchmark.
- Bundle: 195 KB gzipped for the WebGL path against 322 KB for the WebGPU path (measured from the jsDelivr builds, before tree-shaking).
- WebGPU reach is still partial: Safari only on macOS 26 and later, Firefox on Android behind a flag, Chrome on Android 12+ on listed GPUs. WebGL2 is everywhere the brief targets.
- `WebGPURenderer` does fall back to a WebGL2 backend, but that is its own backend, not `WebGLRenderer`, and it carries the same costs.

v1's problems were netcode and architecture. Revisit only if Phase 3 measures a rendering bottleneck that WebGPU would remove.

### 3.2 The ReadPixels startup stall

What is checked:

- In three r187, `gl.readPixels` is called only inside `readRenderTargetPixels()` and its async variant. Nothing calls it at construction.
- The message is a GL driver message that Chrome relays. The other public reports of it are on software rendering (SwiftShader) or headless Chromium.
- v1's audit ran in headless Playwright Chromium, and Playwright passes `--enable-unsafe-swiftshader`.
- v1 gives every wormhole its own `WebGLCubeRenderTarget(256)` and `CubeCamera` (main.js:5548). That is 120 to 220 cube targets, each run through PMREM when first drawn.

What I conclude (**derived, not measured**): the warning is most likely an artifact of software GL in the audit, made worse by the per-wormhole cube targets. I did not reproduce it.

What v2 does: no per-orb render targets (wormholes use a fresnel shader), no synchronous readback anywhere, and Phase 3 records the console of a headed, GPU-backed Chrome run. If the warning appears there, it is a real bug and gets fixed before Phase 3 closes.

## 4. Netcode library: write it or use Colyseus

**Decision (D1): write the netcode core, about 1,500 to 2,000 lines, on plain `ws`.** This is a close call and worth your attention, because Colyseus changed in August 2026.

Checked facts about Colyseus 0.18 (released 2026-08-25, `colyseus` 0.18.12, MIT, Node >= 22):

- It now ships the techniques this brief asks for. Its docs say: "The framework runs the prediction, reconciliation, and rewind loops. You supply the deterministic step function."
- Server: `defineInput()`, `setFixedTimestep()`, `allowRewindState({maxRewindMs})`, `rewind.lastSeenBy()` and `rewind.at(time)`.
- Client: `Predict.reconciler`, remote smoothing modes, drift telemetry (`me.drift.ema`, `me.drift.peak`).
- Its roadmap says: "Stabilize the input and prediction tools that 0.18 introduced. Settle the public API". `@colyseus/core` is already at 0.18.28, 11 weeks after release.
- Prediction and rewind are fed by `@colyseus/schema` patches (default 20 Hz). If you send your own binary snapshots you do not get them.
- `server.simulateLatency(ms)` takes one fixed delay. Jitter and loss on the server side are not documented.
- Its WebTransport transport is marked experimental and "hasn't been battle tested".

| Criterion | Write it | Colyseus 0.18 |
|---|---|---|
| Code to write | About 1,500–2,000 lines of netcode, plus rooms and reconnect | Step function, schema, glue |
| Tests in virtual time | Yes. Client core, server core and a loopback transport run in one process on a fake clock, so prediction, reconcile and rewind tests are deterministic and fast | Not documented. Tests go through real rooms and wall-clock time |
| Debug hook data the brief requires | Direct: every correction, snapshot arrival and rendered remote position is ours to record | Drift is exposed as an average and a peak. Per-correction events and snapshot arrival times: unconfirmed |
| Projectile rewind per tick over a 3 s flight | Designed for it | Possible with `rewind.at(time)`; unconfirmed in practice |
| API stability across a five-phase project | Ours | Roadmap says unsettled |
| Money path auditability (Phase 5) | Every line that decides a hit is in the repo and under test | Hit geometry runs through framework rewind |
| Rooms, matchmaking, reconnection | Written by hand (small: one room type, 16 seats) | Built in |
| Datagram transport later | Ours to add behind the interface | Experimental H3 transport exists |

Why I come down on writing it: the brief's pass thresholds are measurements of netcode internals, and v1 failed precisely because nobody could see inside the sync. Owning the core makes each mechanism testable on a fake clock and measurable in the browser. The cost is real: we forgo working code.

What would change my answer: if you prefer less custom code and accept API churn, a one-day spike can check the three unknowns (per-correction events, headless `Predict` in Node, projectile rewind). The room and transport boundaries in [5.1](#51-layout) keep a later swap possible.

Other libraries checked and set aside: `lance-gg` (no release since 2024-05), `@geckos.io/snapshot-interpolation` (dormant since 2025-02), `nengi` (release candidates only), `geckos.io` (WebRTC, needs a UDP port range), `socket.io` (starts on long-polling, adds framing we do not need).

## 5. Netcode design

### 5.1 Layout

```
src/shared/   sim step, constants, deterministic math, protocol codec,
              snapshot interpolation function. No DOM, no Node.
src/net/      client netcode core: clock, prediction, interpolation buffer.
              No DOM. Used by the browser client and by headless bots.
src/client/   renderer, input devices, HUD, audio, PWA shell.
src/server/   room, tick loop, input buffers, rewind history, HTTP, ports
              for economy and admission.
tests/        Vitest (unit, virtual-time, bots) and Playwright (multi-client).
```

### 5.2 One simulation, fixed timestep

- **Tick rate: 60 Hz**, `dt = 1/60` exactly. v1 advanced the ship once per rendered frame, so 60 Hz reproduces its feel on a 60 Hz display. The per-tick cost is small: ships are kinematic (velocity is always `forward × speed`, main.js:8804) and ring asteroids follow a closed-form orbit.
- **Loops.** Server and client both use an accumulator ("Fix Your Timestep"). The server never uses a bare `setInterval` as its clock; it steps as many fixed ticks as real time requires, capped to avoid a spiral.
- **Rendering between ticks.** The client draws the own ship interpolated between its last two predicted ticks, so motion is smooth on 120 Hz displays.
- **Deterministic maths.** `Math.sin` and `Math.cos` are "implementation-approximated" in the ECMAScript spec, so V8 and JavaScriptCore may differ. The shared sim uses its own `sin`, `cos` and `atan2` built only from `+ − × ÷` and `Math.sqrt`, which the spec defines exactly. `Math.pow`, `Math.hypot` and `**` are banned in `src/shared/sim` by a lint rule. Expected result: bit-identical state across engines.
- **How that is verified.** Vitest only compares V8 with V8. The cross-engine check is `tests/e2e/determinism.spec.ts`: a 10,000-tick run covering turning, the pitch clamp, throttle, boost, the Y clamp, death and respawn is hashed in Node and in the page. **Measured in Phase 1, on one ARM64 Mac: Node 22, Chromium 158 and WebKit 27.2 give the same hash**, from the minified production build, and a WebKit client flown for 20 s had zero corrections. An x86 server against an ARM phone is not yet measured. The hash is pinned in `tests/unit/ship.test.ts`, so `npm test` on any x86 machine settles it, and a probe checks that the engine never fuses a multiply with an add (the one hardware-dependent rounding difference a JIT could introduce). The lint rule became an allowlist: in `src/shared` only `sqrt`, `abs`, `floor`, `ceil`, `round`, `trunc`, `min`, `max`, `sign`, `fround`, `imul` and `PI` may be used from `Math`.
- **Randomness.** A seeded PRNG in room state drives boost duration, crash damage and spawns. The client does not predict random outcomes; it receives them.

### 5.3 Inputs

- **Content.** One input per tick: tick number, yaw axis and pitch axis as int8 (−127..127), throttle (−1, 0, +1), button bits (fire, bomb), and the view time described in [5.6](#56-shots-and-lag-compensation). About 10 bytes. As built: 5 bytes per input (two axes, one byte of throttle and fire, and a 16-bit view delay in sixteenths of a tick), 21 bytes per message with its two redundant copies. In the real-socket test with 2% of inputs genuinely dropped, the redundant copies meant the server missed none.
- **Encoded input is the input.** The client quantises first, then predicts from the quantised value it sends, so client and server step from identical numbers.
- **Tick alignment.** The client runs ahead of the server by its one-way latency plus a margin, so the input for tick T arrives before the server simulates tick T. This is the Overwatch model. Each snapshot tells the client how early its inputs arrived; the client speeds up or slows down its tick clock by up to 5% to hold the margin. It never skips a tick number.
- **Adaptive margin.** The margin starts at two ticks and grows with observed lateness, up to a cap of six ticks (100 ms, config value). A larger margin means fewer late inputs but a longer view delay, so it is capped. As built: every snapshot reports the worst slack of the client's inputs since the last one. The client keeps five seconds of these reports, with its own clock adjustments subtracted so it cannot mistake them for jitter, and steers the tick clock so the worst of them stays between 2 and 3.25 ticks. Typical slack is then the worst case plus whatever the jitter is, and is capped at six. The client begins two ticks more generous, because its first round-trip figure is a single sample. Measured on the virtual clock: once settled the clock runs within 0.2% of real time, typical slack is 2.8 to 3.5 ticks on a clean link and 3.3 on the 200 ms profile, and no input is late at any point, warm-up included. (A first version estimated jitter separately and hunted: about one tick of drift every 45 s on a clean link.)
- **After a stall.** If more than 8 ticks are due in one frame, the client does not send them late. It predicts the gap with its last sent input (what the server did in the meantime) and carries on from the present. This keeps the tick clock aligned without a round trip.
- **Missing input.** If the input for tick T has not arrived, the server reuses the previous one and moves on. A late input is discarded. The ship never freezes for others, and a lag switch gains nothing. A reused input causes a correction only if the player changed their controls during the gap.
- **Redundancy.** Each input message also carries the previous few inputs. Over WebSocket this is unused; it is there so a datagram transport works without a protocol change.
- **Limits enforced by the server.** At most one input per tick per player, axes clamped to ±1, fire rate enforced by the sim's cooldown, view time clamped to a window. Speed hacks are impossible by construction: inputs are per tick, and carry no time step.

### 5.4 Own ship: prediction and reconciliation

1. The client applies each input locally in the same tick it is sent, and stores the input and the resulting state in a ring buffer.
2. Every snapshot carries the own ship's authoritative state for server tick S **at full float64 precision**. Remote ships are quantised; the own ship is not, so the comparison is exact.
3. The client compares that state with what it predicted for tick S.
   - **Equal**: nothing happens. No rewind, no correction event. As built the comparison is exact on every field, with no tolerance; the tolerance in `tests/thresholds.ts` only decides which recorded events count against the browser threshold.
   - **Different**: the client sets its state at S to the server's, replays its stored inputs from S+1 to the present with the shared step, and records a correction event with the size of the change at the present tick.
4. **Smoothing.** After a replay the sim state is correct immediately. The drawn ship keeps a visual offset equal to the jump, which decays over about 100 ms. Corrections larger than 5 ship lengths snap, since a slow slide would look worse.

Sources of correction that remain, by design: an input that arrived late, a collision with another ship, being hit, and server-decided events such as respawn. On a clean network with no collisions there are none.

### 5.5 Remote ships: snapshot interpolation

- **Snapshots at 30 Hz** (every second tick). Derived check that this is enough: for a ship turning at v1's maximum 2 rad/s, the gap between a straight line and the true arc over 33 ms is 0.02 units at 60 u/s and 0.07 units at the boosted Fenix speed of 246 u/s. The threshold is 2 units.
- **Buffer and delay.** Each remote ship has a buffer of snapshots. The client renders remotes at `server time − interpolation delay`. The delay starts at two snapshot intervals (67 ms) and adapts to measured arrival jitter, within 67 to 250 ms.
- **Missing snapshots.** If the next snapshot has not arrived, the client extrapolates along the last known velocity and turn for at most 150 ms, then holds.
- **No snaps.** When fresh data arrives after extrapolation, the drawn position does not jump. The difference becomes a visual offset that decays, with its per-frame change capped below the snap threshold. Teleports (respawn, wormhole) are flagged in the snapshot and are drawn as jumps on purpose.
- **Angles** are sent as yaw, pitch and roll, the sim's own state, and interpolated along the shortest arc.
- **Interest tiers.** Ships within 2,000 units (with hysteresis) are sent at 30 Hz. Farther ships are sent at 5 Hz with position only, for the radar. v1 sent everything to everyone at 50 Hz.
- **Size, derived:** about 23 bytes per nearby ship. Sixteen players all in range is about 11 kB/s per client, against v1's 37.6 kB/s. The load test reports the measured figure.
- **As built.** A nearby ship is 20 bytes (position at 1/256 unit, height at 1/64, three 16-bit angles, hit points, flags, spawn number); a distant one is 13. A ship that leaves the near tier is sent once more straight away so it does not vanish until the next 5 Hz update. The delay is two snapshot intervals plus the measured spread of arrival times over the last five seconds plus one tick, between 67 and 250 ms; the remote clock is steered toward it at up to 5% so it never jumps. Late data that moves a ship leaves an offset that closes by half every 50 ms but never faster than 60 u/s. Other ships are drawn 1.5× size as in v1, with a dot on each so they can be found across the belt (the dot is new; Phase 3 replaces it with the minimap). Measured: see `PLAN.md`. On the 100 ms profile the delay settles at 70 ms; on the lossy profile it sits at the 250 ms cap.

### 5.6 Shots and lag compensation

**Decision (D2): keep v1's visible projectiles and compensate them. Hitscan is the alternative.**

v1's live weapon is a projectile: 230 u/s, 3.0 s life, 690 units of range (main.js:351-352). "Rewind to when the shot was fired" describes hitscan exactly. For a projectile that flies for up to 3 seconds it needs a precise definition, and this is the one I propose:

- **View delay.** When the shooter fires at tick T, the remote ships on their screen are drawn at an earlier time, `T − viewDelay`. The view delay is roughly round-trip time plus the input margin plus the interpolation delay: about 230 ms on the 100 ms profile (derived). The client reports its view time in every input.
- **Server test.** The server spawns the bullet at tick T from the shooter's authoritative state. On every later tick t it tests the bullet's swept segment against each target's position at `t − viewDelay`. So for its whole flight the bullet meets targets where the shooter's screen shows them.
- **Same geometry on both sides.** The server's rewind uses the same quantised snapshot samples and the same shared interpolation function that the client renders with.
- **Cap.** The server clamps view delay to 350 ms (config value). Beyond that the shooter must lead the target. This limits how far "behind" a victim can be hit: at 60 u/s and the full 350 ms, 21 units, about 5 ship lengths.
- **Shooter's screen.** The client predicts its own bullets and shows a hit spark when one meets a drawn remote ship. That is a "hit shown in the shooter's view" for the 95% agreement threshold. Damage, HP and kills change only when the server confirms.
- **Other players' bullets** arrive as a spawn event (origin, direction, tick) and are drawn on the remote timeline.
- **Swept collision.** v1 tested bullet position once per frame, so a bullet moving 3.8 units per frame could pass through the edge of a 4.5-unit hit zone. v2 tests the segment travelled each tick. Grazing hits that v1 missed will now land.

Cost of this choice, stated plainly: victims are sometimes hit by a bullet that looked like a near miss on their screen. That is the standard "favour the shooter" trade, and the cap bounds it.

As built in Phase 2:

- **One test, run once per tick, on both sides.** The client measures how far behind its predicted tick the other ships are being drawn, rounds it to a sixteenth of a tick, uses that number for its own hit test on that tick, and sends the same number in that tick's input. The server uses the number from the input for that tick. Both call the same function on the same samples. The test is per tick, not per rendered frame, because browsers render at different rates.
- **The server keeps what it sent.** For each ship it stores the quantised sample from every snapshot at the tick it was sent (64 of them, over two seconds). Rewinding interpolates those, exactly as the client's drawing does.
- **Eligibility.** A target counts if it is alive now, and the shooter was looking at the same life of it, alive and past its spawn protection.
- **Shots are confirmed.** The server announces every bullet to its owner too. A predicted bullet that is not announced by the snapshot of its tick never happened and is removed. A hit seen on an unconfirmed bullet waits for the confirmation before it is shown. This relies on events and snapshots arriving in order, which a WebSocket guarantees; a datagram transport would need a sequence number on events.
- **Expected hit points.** The shooter's client counts its own recent hits and other players' announced hits on a target, from the tick the displayed hit points belong to, and stops registering hits on a ship that should already be dead. Without this the shooter saw one or two extra hits land on every wreck.
- **Measured view delay:** 115–133 ms clean, 222–241 ms on the 100 ms profile (the estimate was 230), and pinned at the 350 ms cap on the 200 ms lossy profile, where the true figure is about 580 ms. There the shooter has to lead. Agreement on that profile is not gated; in the run of record 432 of 434 hits a shooter saw were confirmed and the server counted none the shooter was not shown.
- **A shot is tested again when it changes.** With late inputs the client fires from a predicted position the server then corrects. When a correction rebuilds a shot, or the server announces one from a different place, the client tests it over the ticks it has already flown, each with the view delay sent for that tick. Without this, one server hit in seven on the lossy profile was never shown (found and fixed 2026-11-14).
- **What agreement cannot reach.** In a free-for-all, two players can shoot one ship; a hit seen on a ship another player destroyed a moment earlier is not confirmed. The 95% gate is therefore measured with ships kept alive by a test hook. Kills are tested separately (the shooter sees exactly the seven hits that counted), and free-for-all figures are reported in `PLAN.md`.

Hitscan would be simpler and makes agreement near-perfect, but it removes dodging and changes how v1's combat feels.

### 5.7 Transport

```ts
interface Transport {
  send(data: Uint8Array, channel: 'reliable' | 'droppable'): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}
```

- **Baseline: WebSocket** (`ws` on the server, browser `WebSocket` on the client), binary frames, one coalesced send per tick. Both channels map to the same socket.
- **Why two channels now.** Snapshots and inputs are `droppable`: the protocol tolerates losing them. Spawns, deaths and other events are `reliable`. The test proxy uses the flag, and a datagram transport would map it directly.
- **Also implemented:** a loopback transport on a fake clock, for Vitest.
- **WebTransport: not added.** It is confirmed in Safari on iOS since 26.4 (2026-03-24), including datagrams. The browser is no longer the obstacle. The server side is: Node has no production WebTransport (`node:quic` is absent in Node 22 and experimental later; the main library describes itself as "a duct tape-style solution"), and Railway documents HTTP/1.1, HTTP/2 and a TCP proxy; its docs do not mention inbound UDP or HTTP/3. Devices below iOS 26.4 would still need WebSocket. Revisit when hosting changes.
- **WebRTC data channels: not added.** They work on iOS Safari, but need signalling, ICE and a UDP port range.

### 5.8 Resilience

- **Hidden tab.** On `visibilitychange` to hidden the client stops its sim and tells the server. The server treats the player as away (D6). On return the client asks for a full state, resets its tick clock and prediction history, and never tries to catch up on the gap.
- **iOS.** Timers, `requestAnimationFrame` and usually the socket stop soon after backgrounding, and one open WebKit bug (308073) reports `new WebSocket()` hanging after resume. So on return the client always opens a fresh socket if the old one fails a 1 s ping, with a connect timeout and retry.
- **Reconnect.** The server issues a session token at join. Reconnecting with it inside the grace period returns the same seat, score and ship.
- **As built.** The token is 16 random bytes. A `Session` object owns the connection: when it closes it retries after 250 ms, 500 ms, 1 s, then every 2 s, presenting the token; a new connection with a known token takes the seat over even if the server has not yet noticed the old socket died. Hiding the tab sends a one-byte "away"; showing it sends "back", and the server answers with a fresh welcome. If that answer does not come within 1 s the session opens a new socket. A ship whose player is away longer than the grace period dies with cause `disconnect`; if the socket is still open the player stays seated and respawns on return.
- **Late joiners** receive a full state: world seed, current tick, all players, destroyed asteroids, orb states.
- **Version check.** The hello carries a protocol version and a simulation fingerprint. A stale cached client is rejected with "update required" instead of desyncing. This matters because the PWA caches the client. As built: the fingerprint is computed at load by running a fixed 2,000-tick flight and hashing every state, mixed with a hash of the constants, so it changes if a constant, the step function, or the engine's arithmetic differs. Changes to the wire format still need `PROTOCOL_VERSION` bumped by hand.

### 5.9 Designed now for Phase 5

The room talks to the outside through two interfaces. Phases 1 to 4 ship free-play implementations.

- **Admission**: `admit(token)` returns `{ accountId, wallet | null, paid }`. Phase 5 adds a wallet signature challenge and paid entry.
- **Economy events** from the room: `playerJoined`, `playerDied { deathId, victim, killer | null, cause, survivalTicks, kills }`, `runSummary`. Every death has a unique `deathId` so a payout can be made idempotent. v1 has no such ID.
- **As built.** `RoomListener` in `src/server/room.ts` delivers `playerJoined`, `playerLeft`, `playerDied` (with the fields above) and `hit`. `runSummary` and the admission interface are not built: nothing uses them before Phase 5, and `join()` is the one place admission will go.

Survival time, kills and cause of death are already server-decided from Phase 2 on, so Phase 5 adds accounting, not game logic. [Appendix B](#appendix-b-v1-trust-boundary) lists what v1's economy trusts today.

## 6. What cheating is still possible

- **Aim assistance and radar.** The client knows the position of every ship within 2,000 units and the coarse position of the rest. No browser game can hide what it must draw.
- **View-delay choice.** The server believes the view delay a client sends, up to 350 ms. A modified client can send any value from 0 to the cap on each tick, and so pick, per shot, whichever moment of a target's last 350 ms puts it in the bullet's path. At 60 u/s that is a choice among positions up to 21 units apart. The cap is the limit; a tighter defence would have the server estimate each client's delay itself.
- **Holding a seat.** A connected player who sends nothing keeps flying straight and keeps one of the 16 seats for as long as the socket stays open. A hidden tab with a live socket does the same after its ship has died. There is no idle timeout yet; one belongs with the room rules in Phase 3.
- **Asking for welcomes.** Each "back" presence message gets a full welcome and every live bullet's announcement, with no rate limit. It is cheap for the server but is free amplification; a limit of one per second belongs with the idle timeout.
- **Flying on while "away".** An away ship cannot steer or shoot but can still be hit, so there is nothing to gain.
- **Input automation.** Perfect dodging bots are indistinguishable from good players at the protocol level.

Positions, hits, damage, deaths, survival time and scores cannot be forged, because clients never send them.

## 7. Verification design

### 7.1 Debug hook

- Compiled in only when `VITE_TEST_HOOKS=1`. A test builds the production bundle and fails if the hook's identifier appears in it.
- Client side, `window.__orbit` records per frame: the frame's real `dt`, the predicted own state and tick, the last acknowledged state and tick, and for each remote ship the sim time it was drawn at and the transform handed to the renderer. It also logs every correction event, every snapshot arrival time, and every shooter-view hit.
- **Metrics come from the transforms handed to the renderer, not from pixels.** Results therefore do not depend on the GPU. A `render=off` mode was planned as a fallback; the Phase 1 spike showed headless WebGL works in both browsers, so it is not built.
- Server side, a test-only endpoint returns authoritative per-tick positions and confirmed hits for a tick range.
- As built: with `ORBIT_TEST_HOOKS=1` the server adds `GET /debug/truth`, `POST /debug/place` (move a ship) and `POST /debug/sustain` (keep ships alive during a measurement). Without the flag those paths return 404, and a test checks that. The page's hook also takes a named behaviour (hunter, wanderer, circler) to fly the ship from a script, and in test builds the page accepts `?server=` to connect through the network proxy. A test checks none of this is in the production bundle.

### 7.2 Network profiles

A standalone Node WebSocket proxy sits between each browser and the server. It works the same for every browser, keeps test code out of the server, and uses a seeded random generator so runs repeat. (Playwright's `routeWebSocket` can drop frames, but delaying them is not a documented use.)

| Profile | Round trip | Jitter | Loss |
|---|---|---|---|
| clean | 0 | 0 | 0 |
| 100 ms | 100 ms (50 each way) | ±20 ms round trip (±10 each way) | 0 |
| 200 ms lossy | 200 ms (100 each way) | ±50 ms round trip (±25 each way) | 2% |

- **D3.** I read the brief's latency as round trip, as a ping display shows it. It is one config value.
- **D4, loss mode `stall` (default).** A WebSocket never loses a message; TCP retransmits it and everything behind it waits. So a "lost" message is delivered about one round trip plus 60 ms late, and later messages in that direction queue behind it. This is what players on a lossy connection will feel.
- **What `stall` costs, derived.** At 60 input messages a second and 2% loss there are about 1.2 stalls a second upstream, each about 260 ms. Inputs are held up roughly 30% of the time, and snapshots (30 a second) about 16% of the time. The six-tick margin cannot absorb a 260 ms stall, so late inputs and visible hitches are expected on this profile whatever the netcode does. The lossy correction threshold may fail for that reason; if it does I report it as a failure with the numbers, and the fix is a datagram transport or a different threshold, not hiding it.
- **Loss mode `drop`.** `droppable` messages are discarded; `reliable` ones stall. It runs in the Node bot tests to prove the protocol survives real loss.
- **Measured in Phase 2.** On the lossy profile 15 to 19% of inputs reached the server too late to be used, the input slack sat at its cap of six ticks, and the own-ship correction threshold passed anyway (p95 0.3 to 1.3 units against 4.0), because each late input costs only a tick or two of slightly different steering. The warning above turned out pessimistic.

### 7.3 Pass thresholds

All in one file, `tests/thresholds.ts`. Ship length is derived from the hull constant: the saucer is 2 × radius 2.0 = **4.0 units** (main.js:4220), and the Fenix cone is also 4.0 long.

| Check | Pass | How it is measured |
|---|---|---|
| Remote position error | p95 < 2.0 units (0.5 ship length), max < 8.0 units, on the 100 ms profile | Drawn position at sim time t against the server's position at t, excluding flagged teleports |
| No visible snaps | Frame-to-frame change of a remote ship ≤ 3 × (speed limit × the frame's real `dt`). The speed limit is the larger of that ship's current max speed and its actual server speed at that sim time, so a ship still slowing down after a boost is not counted as a snap | Every frame, all profiles |
| Local corrections, lossy | p95 < 4.0 units | Correction events, 200 ms lossy profile |
| Local corrections, clean | Zero events larger than 0.01 units, with no collisions, after a 2 s warm-up | Clean profile, Chromium and WebKit |
| Hit agreement | ≥ 95% of shooter-view hits confirmed by the server, 100 ms profile | Client hit log joined to server hit log by bullet ID |
| Load | 16 bots, 5 minutes: tick time p99 ≤ 8.3 ms (half a tick); heap after GC at 5 min within 10% of the 1 min value; bandwidth per client reported | Node, `--expose-gc` |

Hit agreement and remote error are also reported for the 200 ms lossy profile, without a gate.

### 7.4 Honest limits

- Headless WebGL frame rate says nothing about device performance.
- Playwright's WebKit is a desktop WebKit build with an iPhone viewport and user agent. It is not iOS Safari: no iOS backgrounding, no iOS frame pacing, no touch hardware.
- Frame rate, touch feel, tilt, thermal behaviour and the Mac app's frame pacing are reported as **UNVERIFIED** until measured on a real device with the checklist in `PLAN.md`.

## 8. Platforms

### 8.1 Phone controls

- A hand-written virtual stick and fire button on Pointer Events, with `setPointerCapture` and `touch-action: none`, one tracked `pointerId` per control. `nipplejs` 1.0.4 is maintained again, but a floating stick tied to our HUD with our dead zones is small to write.
- All devices produce the same two axes, clamped to ±1, so no device turns faster than another. In v1, keys plus mouse could stack to 1.6× (main.js:8767).
- Optional tilt steering. On iOS, `DeviceOrientationEvent.requestPermission()` must be called from a tap and needs HTTPS.
- Landscape: iOS supports neither `screen.orientation.lock()` nor the manifest `orientation` field, so the game shows a "rotate your phone" overlay. Android can lock orientation in fullscreen.
- Safe areas: `viewport-fit=cover` and `env(safe-area-inset-*)`.
- iPhone has no element fullscreen. The chrome-less view is the installed Home Screen app.

### 8.2 Adaptive quality

A controller watches frame time and moves between quality tiers with hysteresis. Each tier sets a pixel-count cap (sizing the canvas, as the three.js manual recommends), particle budgets, the number of asteroid instances drawn, and effects. Low Power Mode on iOS halves `requestAnimationFrame` to 30 fps; the fixed-step sim is unaffected. Target frame rate on real phones is UNVERIFIED until Phase 3 device tests.

### 8.3 PWA

`vite-plugin-pwa` precaches the app shell. Updates use `registerType: 'prompt'` and are applied between lives, never mid-match. Install on iOS is through the Share menu only. Android Chrome installs from the manifest.

### 8.4 Device testing over the LAN

`vite-plugin-mkcert` makes a locally trusted certificate that includes the Mac's LAN address. The game socket goes through Vite's proxy, so page and socket share one HTTPS origin. On the iPhone you install the mkcert root certificate once and switch on full trust for it. An untrusted self-signed certificate is not enough: reports say iOS rejects `wss://` to it even after the page warning is accepted.

## 9. Mac app

**Decision (D7): Electron 45.** Pointer Lock is not a factor: v1 does not use it (it steers from pointer position), and v2 keeps that.

| Criterion | Electron 45.3.2 | Tauri 2.12 | Installed PWA |
|---|---|---|---|
| Engine | Chromium 156, same as the desktop Chrome we test most | System WKWebView | Whichever browser installed it |
| Automated test | Playwright launches and drives it, same runner as the rest | Needs a second stack (WebdriverIO with an embedded driver plugin) | None beyond the browser tests |
| Frame pacing | Follows the display in Chromium generally. Electron at 120 Hz specifically is unconfirmed | WKWebView prefers about 60 fps by default; WebKit bug 294338 is open; Tauri closed its issue as not planned | As the browser |
| Size | 80–100 MB zipped | A few MB | 0 |
| Service worker | Not needed | Not possible on `tauri://` | Yes |
| Demos wallet extension | Not checked; the brief assumes no | Browser extensions are documented as unsupported on macOS | Plausibly, in a Chrome-installed PWA (unconfirmed) |
| Toolchain | Node only | Rust 1.90+ (1.95 is installed) | None |

Why Electron: the Mac app can be smoke-tested by the same Playwright suite, it behaves like the Chrome build we already measure, and it avoids WKWebView's unresolved 60 fps question. The price is size.

Update path: the server rejects clients whose protocol version or constants differ ([5.8](#58-resilience)), so a Mac app with a bundled client would stop working after any such change. Phase 4 therefore loads the client from the game server's HTTPS origin by default, and uses the bundled copy only for local development.

The web build is an installable PWA regardless, so "Install app" in Chrome and "Add to Dock" in Safari work at no cost. Distribution outside this Mac would need an Apple Developer ID and notarisation ($99 a year); that is out of scope unless you ask.

## 10. Mobile payments (direction only; decided in Phase 5)

The Demos wallet is a desktop browser extension. I found no mobile wallet, WalletConnect or deep-link flow in the public docs or the SDK 4.0.21 typings (unconfirmed that none exists).

Direction to propose in Phase 5, before building:

1. **Free rooms on phones and the Mac app** from the start. No pot.
2. **Pay on desktop, play anywhere.** The account is the wallet address. Entries are bought on desktop with the extension. A phone links to the account by scanning a one-time code shown on the desktop session. Payouts go to the wallet address, so the phone never signs anything.
3. If Demos ships a mobile signing flow, adopt it.

SDK notes for Phase 5: `@kynesyslabs/demosdk` is at 4.0.21, ESM. Its `D402Server.verify(txHash)` typings warn that without a `payer`, a transaction hash "is a bearer token" anyone can replay. v1 has exactly that hole.

## What is still unconfirmed

| Item | Resolved in |
|---|---|
| ~~WebGL and `requestAnimationFrame` in four headless contexts~~ | **Resolved in Phase 1.** Both work. Chromium needs `--use-angle=metal` (60 frames a second; 6 in software without it). WebKit runs at 100. Numbers in `PLAN.md` |
| Bit-identical simulation across engines and CPUs | **Half resolved in Phase 1.** V8 and JavaScriptCore agree on this ARM64 Mac. x86 is not measured: run `npm test` on the server's architecture before deploying; the pinned hash test fails if it differs |
| ~~Desktop Firefox: headless WebGL, and the game itself~~ | **Resolved in Phase 2.** Firefox 159 headless: WebGL2 works, 60 frames a second, connects, flies, sees a second player, zero corrections. One smoke run, not the full suite |
| Whether the ReadPixels warning appears in a GPU-backed browser | Phase 3 |
| Electron `requestAnimationFrame` rate on a 120 Hz display | Phase 4, on your Mac |
| iOS suspension timing; iOS WebGL context loss on backgrounding | Phase 3, on your iPhone |
| Service worker behaviour with the mkcert certificate on iOS | Phase 3, on your iPhone |
| Colyseus: per-correction events, headless `Predict`, projectile rewind | Only if D1 goes the other way |
| JavaScriptCore's `Math.sin` implementation | Not needed: the sim does not call it |
| The content of the Valve networking pages and the two GDC talks | Titles and URLs verified; content not re-read this session, so they are not cited as evidence |

## Sources

Checked 2026-11-13. Items marked ◆ I fetched directly; the rest were fetched by research passes whose reports I reviewed.

**Versions**
- ◆ npm registry `latest` for `three`, `vite`, `typescript`, `vitest`, `@playwright/test`, `vite-plugin-pwa`, `vite-plugin-mkcert`, `ws`, `eslint`, `typescript-eslint`, `tsx`, `electron`, `@tauri-apps/cli`, `colyseus`, `@colyseus/sdk`, `@kynesyslabs/demosdk`: `https://registry.npmjs.org/<package>/latest`
- TypeScript 7.0 announcement: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- typescript-eslint and TS 7: https://github.com/typescript-eslint/typescript-eslint/issues/12518
- Vite 8 migration: https://github.com/vitejs/vite/blob/v8.3.8/docs/guide/migration.md
- Vitest 5: https://github.com/vitest-dev/vitest/releases/tag/v5.0.0

**Renderer**
- three.js manual, WebGPURenderer: https://github.com/mrdoob/three.js/blob/r187/manual/pages/webgpurenderer.html
- three.js `llms.txt`: https://github.com/mrdoob/three.js/blob/r187/docs/llms.txt
- three.js r187 builds: https://cdn.jsdelivr.net/npm/three@0.187.0/build/
- WebGPURenderer performance: https://github.com/mrdoob/three.js/issues/33821, https://github.com/mrdoob/three.js/issues/30560, https://discourse.threejs.org/t/91904
- ReadPixels reports: https://github.com/mrdoob/three.js/issues/27339, https://discourse.threejs.org/t/75621
- three.js responsive manual: https://github.com/mrdoob/three.js/blob/r187/manual/pages/responsive.html
- ◆ WebGPU support, caniuse data file: https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/webgpu.json
- WebGPU implementation status: https://github.com/gpuweb/gpuweb/wiki/Implementation-Status

**Netcode**
- ◆ Colyseus netcode docs: https://docs.colyseus.io/netcode, https://docs.colyseus.io/netcode/client-prediction, https://docs.colyseus.io/netcode/determinism, https://docs.colyseus.io/netcode/lag-compensation
- Colyseus roadmap, transports, room API: https://docs.colyseus.io/roadmap, https://docs.colyseus.io/server/transport/webtransport, https://docs.colyseus.io/room
- Colyseus 0.18 release: https://github.com/colyseus/colyseus/releases/tag/0.18
- Gambetta, Fast-Paced Multiplayer: https://www.gabrielgambetta.com/client-server-game-architecture.html, https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html, https://www.gabrielgambetta.com/entity-interpolation.html, https://www.gabrielgambetta.com/lag-compensation.html
- Fiedler: https://gafferongames.com/post/fix_your_timestep/, https://gafferongames.com/post/snapshot_interpolation/, https://gafferongames.com/post/udp_vs_tcp/, https://gafferongames.com/post/floating_point_determinism/
- ECMAScript, Math functions: https://tc39.es/ecma262/multipage/numbers-and-dates.html
- `ws` Nagle and deflate defaults: https://github.com/websockets/ws/blob/8.23.0/lib/websocket.js#L269, https://github.com/websockets/ws/blob/8.23.0/lib/websocket-server.js#L79

**Transport and background behaviour**
- ◆ WebTransport support, caniuse data file: https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/webtransport.json
- Safari 26.4: https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- `@fails-components/webtransport` README: https://github.com/fails-components/webtransport/blob/master/main/readme.md
- Node QUIC docs: https://github.com/nodejs/node/blob/v24.x/doc/api/quic.md
- Railway networking: https://docs.railway.com/networking/public-networking/specs-and-limits
- Fly.io UDP: https://docs.fly.io/networking/udp-and-tcp
- WebKit WebSocket-after-resume bugs: https://bugs.webkit.org/show_bug.cgi?id=308073, https://bugs.webkit.org/show_bug.cgi?id=228296
- Chrome timer throttling: https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- Page Lifecycle: https://developer.chrome.com/docs/web-platform/page-lifecycle-api

**Testing**
- Playwright browsers and devices: https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/browsers.json, https://playwright.dev/docs/emulation, https://playwright.dev/docs/browsers
- Playwright Chromium switches: https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/chromium/chromiumSwitches.ts
- Playwright WebSocket routing: https://playwright.dev/docs/api/class-websocketroute
- ◆ Playwright Electron: https://playwright.dev/docs/api/class-electron
- ◆ Tauri WebDriver on macOS: https://v2.tauri.app/develop/tests/webdriver/

**Platforms**
- MDN browser-compat-data: https://github.com/mdn/browser-compat-data
- Tauri: https://v2.tauri.app/start/prerequisites/, https://github.com/tauri-apps/tauri/issues/13978, https://github.com/tauri-apps/tauri/issues/13031
- WKWebView 120 Hz: https://bugs.webkit.org/show_bug.cgi?id=294338
- Electron: https://releases.electronjs.org/releases.json, https://www.electronjs.org/docs/latest/why-electron, https://www.electronjs.org/docs/latest/tutorial/code-signing
- Safari web apps: https://webkit.org/blog/14445/webkit-features-in-safari-17-0/, https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- iOS motion permission: https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent/requestPermission_static
- Safe areas: https://webkit.org/blog/7929/designing-websites-for-iphone-x/
- Pointer capture and `touch-action`: https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture, https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action
- Install criteria: https://web.dev/articles/install-criteria
- vite-plugin-pwa: https://github.com/vite-pwa/vite-plugin-pwa/releases/tag/v2.0.0
- mkcert on mobile: https://github.com/FiloSottile/mkcert#mobile-devices, https://support.apple.com/en-us/102390
- iOS `wss://` with untrusted certificates: https://cockpit-project.org/running/safari, https://developer.apple.com/forums/thread/792842
- WebKit storage policy: https://webkit.org/blog/14403/updates-to-storage-policy/

**Demos**
- SDK package and typings: https://registry.npmjs.org/@kynesyslabs/demosdk
- Wallet provider docs: https://github.com/kynesyslabs/documentation-mintlify

---

## Appendix A: v1 tuning constants and what v2 changes

Values are read from `main.js`. A ✓ follows each individual value I re-checked by line number myself; the flight, spawn, planet, camera and ship-model rows were all re-read while porting them in Phase 1, and each constant in `src/shared/constants.ts` carries its line. The rest come from a research pass that read lines 1–90, 236–483, 541–660 and 3790–10230 in full and grep-swept the remainder (wallet, payment and overlay code, which is Phase 5 territory) for writes to gameplay state.

### A.1 Ported unchanged

| Constant | v1 value | Line |
|---|---|---|
| Start speed / target speed | 20 / 20 ✓ | 4471 |
| Min speed (S key floor) | 5 ✓ | 4473 |
| Max speed, normal / Fenix | 60 ✓ / 80 ✓ | 4474, 8700 |
| Boost multiplier | × 3.08 ✓ (184.8 normal, 246.4 Fenix) | 8702 |
| Boost duration | 3 to 6 s, random ✓ | 9332 |
| Throttle rate | ± 22 u/s² ✓ on target speed | 8713 |
| Speed follow | `min(1, 6·dt)` ✓, or `10·dt` ✓ while boosting | 8725 |
| Yaw rate / pitch rate | 2.0 / 1.35 rad/s ✓ | 4476 |
| Pitch clamp | ± (π/2 − 0.05) ✓ | 8772 |
| Bank (roll) | target `clamp(−yaw × 0.9, ±0.7)` ✓, follow `min(1, 8·dt)` ✓ | 8786 |
| Forward vector | `(sin yaw · cos pitch, −sin pitch, cos yaw · cos pitch)` ✓ (from the YXZ Euler at 8801) | 8800 |
| Y clamp | ± 500 ✓ | 8808 |
| Camera offset | `(0, 3.7, −10.8)`, rigid, rotated with the ship including roll ✓ | 4498 |
| Camera look target | ship + forward × 20 ✓ | 8875 |
| FOV | 70 ✓ + `clamp((speed − 14) × 0.7 + kick, 0, 28)` ✓, kick 10 ✓ while boosting, follow `min(1, 6·dt)` ✓ | 333, 8726 |
| Camera shake | linear decay 6.0 per second; y axis × 0.6; trigger amounts per the v1 table (0.08 to 1.2) | 8865 |
| Planet | origin ✓, radius 1200 ✓, lethal inside 1220 ✓ | 4524, 9623 |
| Belt | inner 3600 ✓, outer 5200 ✓; 2000 ring asteroids ✓ | 4606, 4873 |
| Ring asteroid size / orbit | scale 2 to 9, collision radius scale × 0.95; orbit 0.012 to 0.042 rad/s ✓ | 4840, 4862 |
| Spawn | random belt angle, radius 3600 to 5200, y ± 50 ✓; level, facing +Z, speed 20 ✓ | 4608, 8615 |
| HP / shield | 100 / 0 to 100 | 4314 |
| Bullet | 230 u/s ✓, 3.0 s ✓, radius 0.25 ✓, muzzle 1.8 ahead ✓ | 351, 6019, 6048 |
| Fenix beam | 300 u/s ✓, range 772.8 ✓, radius 0.45 | 353 |
| PvP damage | 15 bullet, 30 Fenix | 9872 |
| Hit radii | 2.0 ship vs bullets; 1.8 ship vs asteroids ✓; 2.2 pickups ✓ | 9811, 4494 |
| Asteroid crash | HP 45 to 75 ✓, shield 22 to 44 ✓, halved for Fenix; 0.6 s crash immunity ✓ | 8496, 8509 |
| Near-miss spark | within asteroid radius + 3.2; 1.2 s cooldown per asteroid | 8946 |
| Respawn invulnerability | 1.3 s (from v1's server) | server:3102 |
| Orb radii | shield 1.2, pink 1.6, Fenix 1.7, Zaphire 2.4, wormhole 1.8, boost 1.2 | 5109–5697 |
| Orb effects | shield +25 (max 100); boost 3–6 s; Fenix transform; Zaphire opens store | 9099, 9332 |
| Scoring | orb base 110 × type (shield 5, pink 10, boost 5, Zaphire 1); asteroid 110, ring 160; × 2 in belt; × 2 with multiplier orb; PvP hit +500; belt income 1 or 2 points/s | 4623–4655, 9852 |
| Store | HP 1500, shield 1000, Fenix 2000 points | 8011–8032 |
| Exhaust | rate `50 + speed × 4` per second; life 0.5 to 0.75 s | 9685, 5975 |
| Renderer look | ACES tone mapping ✓, exposure 1.45 ✓, clear colour 0x030a1a ✓, pixel ratio capped at 1.75 ✓ | 283 |

### A.2 Changed, and why

| What | v1 | v2 | Why |
|---|---|---|---|
| Time step | Frame `dt`, capped at 0.033 s. Slow motion below 30 fps | Fixed 1/60 s | Required for a shared deterministic sim |
| Fire cooldown | 0.11 s, reset without carry-over (7 frames at 60 fps) | 7 ticks (0.1167 s) | Same rate as v1 at 60 fps, and no longer depends on frame rate |
| Fenix beam life | 2.576 s | 155 ticks (2.583 s) | Whole ticks; range becomes 775 |
| Bullet collision | Point test per frame | Swept segment per tick | No tunnelling. Grazing hits now land |
| Turn input | Keys plus mouse could reach 1.6× the key rate; hold-drag mouse reached 0.6× | One axis clamped to ±1 for all devices | Fair across devices, and v1's server already clamped to ±1 (server:2778) |
| Mouse smoothing | 0.15 per frame | Time-based, same response at 60 fps | Frame-rate independent |
| Bank from mouse | Extra `mouseX × 0.5` term | Derived from the yaw axis only | One axis for every device |
| Remote ship smoothing | 2% per frame toward latest sample | Snapshot interpolation | The brief |
| Dev turbo, teleport | Accepted from any client | Dev and test builds only | Cheats |
| Per-wormhole cube cameras | 120 to 220 render targets | Shader | Startup cost |
| Renderer `logarithmicDepthBuffer` | On | Decided in Phase 3 after measuring | It costs a depth write per fragment; the PvP map may not need it |
| Asteroid field outside the ring | 800 "far" + 200 "near" around the origin; all the near ones and about 18% of the far ones spawn inside the planet (derived) | Only those outside the planet; exact count set in Phase 3 | The hidden ones are invisible cost |
| Destroyed asteroids | Never respawn | Respawn after a delay, value set in Phase 3 | Rooms run indefinitely |
| Orb counts | Seeded above the caps by a double loop, then topped up around the ship, off the ring | Fixed counts at v1's caps (shield 160, pink 120, Fenix 120, Zaphire 120, wormhole 120, boost 120, miner 300, hunter 300), server-owned, on the ring | v1's counts are accidents of two bugs |
| Exhaust and impact particles | Pooled meshes never reset opacity, so most are invisible; none spawn at 144 fps at cruise | Working pool, time-based spawn | v1 bugs |
| Planet contact | Skipped during the 0.6 s after an asteroid crash (main.js:8493) | Always lethal inside 1220 | The exemption only delayed the death by up to 0.6 s |
| Boost length | A random 3 to 6 s counted down by frame time | A whole number of ticks | Fixed step |
| Heading angle | Grows without limit | Kept in (−π, π] | Keeps the deterministic `sin`/`cos` in their accurate range; invisible in play |
| FOV follow | 6·dt of the gap per frame | `1 − e^(−6·dt)` of the gap | Same response at 60 fps, and the same at any other frame rate |
| Saucer orientation | `group.rotation.x = π/2` is set at build (main.js:4278) and then overwritten every frame by the flight code (main.js:8835), so it has no effect | Not set | Ported the effective behaviour: disc flat, dome up |
| Lights | A point light on the camera and one on the planet | Ambient and sun only, for now | Light units changed between v1's three.js and r187; Phase 3 matches the look |
| Spawn protection | 1.3 s after a respawn only (server:3102) | 1.3 s after every spawn, the first included | One rule; a new arrival is as exposed as a respawned one |
| Bullet on the tick it is fired | Starts at the muzzle, 1.8 units ahead | Also tested along the 1.8 units from the ship's centre to the muzzle | A target touching the shooter's nose would otherwise be skipped |
| Bullets and the dead | A bullet keeps flying after its owner dies | Same, but removed when its owner leaves the room | The server needs the owner's view delay to place it |
| Hits on a ship you cannot be seeing | n/a (client decided) | No hit unless the shooter was looking at the same life of the target, alive and past its spawn protection | Follows from lag compensation |
| Remote ship size | 1.5× (main.js:6836) | 1.5×, plus a red dot at any distance | Kept; the dot stands in for the minimap until Phase 3 |
| Decisions D8–D12 | See [section 1](#1-decisions-that-need-your-answer) | | |

### A.3 v1 behaviours that look accidental

These shape what "feels the same" means. Derived from code; none was run.

- **Shield absorbs nothing.** A crash reduces shield and HP together (main.js:8498-8501). PvP bullets reduce HP only. (D8)
- **Up dives.** `forward.y = −sin(pitch)` and Up adds pitch. A comment at 8737 says "nose up"; the H key assumes the opposite sign. (D10)
- **Wormholes always eject.** In the connected world every wormhole is on the ring, so no partner is ever 12,000 units away and the fallback fires. (D9)
- **M-mode mouse and touch steering throw** a ReferenceError (`gameStarted`, main.js:6502, 6527). The working mouse control is hold-and-position.
- **The pointer steers backwards.** With the pointer held, `mouseYaw = mouseX × 0.6` (main.js:8762) and positive yaw is a left turn, so a pointer right of centre turns the ship left; `mousePitch = −mouseY × 0.6` lifts the nose when the pointer is below centre. It reads as dragging the view. The newer M-mode control steered toward the pointer, but it is the one that throws. v2 keeps the working behaviour for now. (D12)
- **Remote ships and bots are drawn at 1.5× scale** (main.js:6836) while the hit radius stays 2.0. Phase 3 decides whether to keep the larger drawing or add target markers.
- **Any bullet, including other players', scores asteroid kills for the local player** and can trigger the local Fenix transform, store and boost (main.js:9028-9076, 9208).

## Appendix B: v1 trust boundary

What v1's server accepts from clients that affects score, kills, survival or money. Read from `server/index.js`; I re-checked ✓ items by line.

| # | Client-controlled value | Effect | Line |
|---|---|---|---|
| 1 | `player-hit.targetId`, `damage` ✓ | Decides who dies, who gets the kill, and who is recorded as killer for the 22% share. A player can target itself | 2508 |
| 2 | `input.p`, `input.q` ✓ | Position and rotation, unvalidated | 2438 |
| 3 | `input.demoTeleport`, `turbo` | Teleport with 5 s immunity, and 500 u/s, for any player | 2446, 2788 |
| 4 | `hello.demoMode` | Free entry to the paid room with the ability to deal damage | 2237 |
| 5 | Socket close | A disconnect by the longest survivor creates a 66% payout for them | 2687 |
| 6 | Environmental death, own HP, pickups | Client-only. A client can decline to die to asteroids or the planet | client |
| 7 | `/blockchain/submit` stats | All leaderboard numbers. Beating the record triggers a treasury payout ✓ | 1711, 1947 |
| 8 | `/admin/clear-leaderboard` ✓ | No authentication. Resets the record | 438 |
| 9 | `/pay/verify`, `/bomb/verify` `txHash` | No used-hash record. Replayable for 30 minutes, each time adding to the pot or issuing a token | 954, 1076 |
| 10 | `/pvp/submit-score`, `/pvp/forfeit-payout` `playerAddress` | No signature. Anyone can trigger or forfeit anyone's payout; concurrent claims can both pay | 1327, 1474 |

Also relevant to Phase 5:

- **The pot is a counter, not money.** The client sends one transfer of `serverShare || 2` DEM to the server wallet (main.js:1570-1578 ✓), and `/pay/verify` checks for exactly `SERVER_SHARE` = 2 DEM (server:1227 ✓). The "1 DEM to pot" is `pvpState.pot += PVP_CONFIG.POT_SHARE` (server:1249 ✓). Payouts come from a separate treasury wallet.
- **Doc and code disagree.** `PVP_MULTIPLAYER.md` and `PVP_CONFIG.ENTRY_FEE` say the entry fee is 3 DEM; the transfer the client sends and the server verifies is 2.
- **Rows 7 and 8 together** let anyone reset the record and then claim the treasury payout with a self-reported score, if this code is what is deployed. I did not test the live service. This is outside the rebuild and v1 was not touched.

What the economy needs from the game, for Phase 5: who joined (verified wallet or none, paid or not, join time), each death (unique ID, victim, killer or none, cause, survival time, victim's kills), who the longest-surviving paid player is at that moment, and a server-produced run summary for leaderboards. The v1 split to preserve is 66% survivor, 22% killer, 12% stays, in whole DEM with `Math.floor`; on-chain amounts are OS units (1 DEM = 1e9 OS).
