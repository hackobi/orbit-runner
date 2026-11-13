import { defineConfig, devices } from '@playwright/test';

// Ports are fixed and different from the dev defaults, so the suite can run
// while a dev server is open.
const CLIENT_PORT = 5273;
const SERVER_PORT = 8797;

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
      use: {
        ...devices['Desktop Chrome'],
        // Headless Chromium renders WebGL in software unless told to use
        // Metal: 6 fps against a steady 60 (scripts/spike-headless-webgl.ts).
        launchOptions: { args: ['--use-angle=metal'] },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: 'node src/server/main.ts',
      url: `http://127.0.0.1:${SERVER_PORT}/health`,
      env: { ORBIT_SERVER_PORT: String(SERVER_PORT), ORBIT_TEST_HOOKS: '1' },
      reuseExistingServer: false,
    },
    {
      command: 'npx vite --host 127.0.0.1',
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
