import { defineConfig, devices } from '@playwright/test';

// Ports are fixed and different from the dev defaults, so the suite can run
// while a dev server is open.
export const CLIENT_PORT = 5273;
export const SERVER_PORT = 8797;
export const PROXY_PORT = 8798;

/**
 * Headless Chromium renders WebGL in software unless told to use Metal:
 * 6 frames a second against a steady 60 (scripts/spike-headless-webgl.ts).
 */
export const CHROMIUM_ARGS = ['--use-angle=metal'];

const SINGLE_CLIENT = /(determinism|flight|fort|gamepad|hud|skins|stunts)\.spec\.ts/;
// Chromium only: it is Chrome's verdict on installing that is being asked for.
const CHROMIUM_ONLY = /(determinism|flight|fort|gamepad|hud|pwa|skins|stunts)\.spec\.ts/;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 120_000,
  use: { baseURL: `http://127.0.0.1:${CLIENT_PORT}` },
  projects: [
    {
      name: 'chromium',
      testMatch: CHROMIUM_ONLY,
      use: { ...devices['Desktop Chrome'], launchOptions: { args: CHROMIUM_ARGS } },
    },
    { name: 'webkit', testMatch: SINGLE_CLIENT, use: { ...devices['Desktop Safari'] } },
    // These specs open several browsers of their own, of both engines, in one room.
    { name: 'multiplayer', testMatch: /(multiplayer|resilience)\.spec\.ts/ },
    // The touch controls, on a phone's screen size with touch switched on.
    // The fingers are real touch events sent through Chromium's own
    // protocol; WebKit has no equivalent, so its touch handling is not covered.
    {
      name: 'touch',
      testMatch: /touch\.spec\.ts/,
      use: { ...devices['Pixel 7 landscape'], launchOptions: { args: CHROMIUM_ARGS } },
    },
    // The Mac app, started by Electron in a real window. It needs a Mac.
    ...(process.platform === 'darwin' ? [{ name: 'macapp', testMatch: /macapp\.spec\.ts/ }] : []),
    // Firefox is a target browser but outside the brief's full suite: the
    // determinism check and one smoke run.
    {
      name: 'firefox',
      testMatch: /(determinism|smoke)\.spec\.ts/,
      use: { ...devices['Desktop Firefox'] },
    },
  ],
  webServer: [
    {
      command: 'node src/server/main.ts',
      url: `http://127.0.0.1:${SERVER_PORT}/health`,
      env: { ORBIT_SERVER_PORT: String(SERVER_PORT), ORBIT_TEST_HOOKS: '1' },
      reuseExistingServer: false,
    },
    {
      // The tests run against the minified production build, with the debug
      // hook compiled in.
      command:
        'npx vite build --outDir dist-e2e --logLevel warn && npx vite preview --outDir dist-e2e --host 127.0.0.1',
      url: `http://127.0.0.1:${CLIENT_PORT}`,
      env: {
        ORBIT_CLIENT_PORT: String(CLIENT_PORT),
        ORBIT_SERVER_PORT: String(SERVER_PORT),
        VITE_TEST_HOOKS: '1',
      },
      reuseExistingServer: false,
    },
  ],
});
