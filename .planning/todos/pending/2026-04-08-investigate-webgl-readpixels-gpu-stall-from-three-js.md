---
created: 2026-04-08T10:45:43.662Z
title: Investigate WebGL ReadPixels GPU stall from Three.js
area: general
files:
  - audit-report/report.json
  - audit-report/screenshot-desktop.png
  - audit-report/screenshot-mobile.png
  - audit-report/trace-desktop.zip
  - audit-report/trace-mobile.zip
  - scripts/audit.mjs
---

## Problem

Playwright audit of Orbit Runner (target `http://localhost:8787`, viewports desktop 1440x900 and mobile 390x844) came back clean except for one real finding:

**WebGL GPU stall — "GL Driver Message (OpenGL, Performance, High): GPU stall due to ReadPixels"** — repeated 4x on startup then suppressed.

ReadPixels is a synchronous GPU→CPU readback that stalls the render pipeline. Our `main.js` does not call `readPixels` / `getImageData` / `toDataURL` directly, so it is originating from inside Three.js. Most likely culprits:
- `WebGLRenderer.readRenderTargetPixels`
- Shadow map setup
- `.copyFramebufferToTexture`

Worth investigating because frame hitches on startup would hurt the multiplayer PvP experience (which is the current focus on `feature/multiplayer-pvp`). Harmless if no visible hitch is observed.

### Clean signals from the same audit (for reference)
- HTTP 200, all 12 requests succeeded, zero 4xx/5xx
- Zero JS errors, zero console errors, zero failed requests
- DOM intact: `#welcome-screen`, `.game-title`, `<canvas>`, Connect Wallet button present
- Fast load: desktop FCP 472ms / Load 632ms; mobile FCP 132ms / Load 230ms; 8.3 KB transfer

### Artifacts
Saved in `audit-report/`:
- `report.json` — full structured data
- `screenshot-{desktop,mobile}.png` — full-page captures
- `trace-{desktop,mobile}.zip` — open with `npx playwright show-trace trace-desktop.zip` for frame-by-frame timeline

Rerun the audit anytime with `node scripts/audit.mjs` (override target via `AUDIT_URL=...`).

## Solution

TBD — investigation steps:
1. Open `trace-desktop.zip` with `npx playwright show-trace` and locate the startup frames where the stall fires, to determine if it corresponds to a visible hitch.
2. Grep the Three.js usage in the codebase for `readRenderTargetPixels`, `copyFramebufferToTexture`, and shadow map configuration (`renderer.shadowMap.enabled`, `shadowMap.type`, `PCFSoftShadowMap`, etc.).
3. If shadow map init is the cause, consider pre-warming the shadow pass off-screen or switching to a cheaper shadow type.
4. If `copyFramebufferToTexture` is involved (common for post-processing / bloom / composer effects), see if the effect can be deferred past the first frame or replaced with a render target copy.
5. Re-run `node scripts/audit.mjs` after the fix to confirm the driver warning is gone.
