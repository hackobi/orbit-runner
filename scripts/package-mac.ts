// Builds the Mac app:
//   node scripts/package-mac.ts
// It builds the client, packs a copy of it into the app together with the
// app's own files, signs the result ad hoc so that this Mac will run it,
// and then starts it once to see that it opens and connects. The app lands
// in release/. Handing it to another Mac would need an
// Apple Developer ID and notarisation, which this does not do.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { _electron } from '@playwright/test';
import { startServer } from '../src/server/server.ts';
import { writeResult } from '../tests/support/results.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'app');
const packedClient = join(app, 'client');

const run = (command: string, args: string[]): void => {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
};

// The production client, with no test hook in it, and the app's icon.
run('npx', ['vite', 'build', '--logLevel', 'error']);
run('node', ['scripts/make-icons.ts']);
rmSync(packedClient, { recursive: true, force: true });
cpSync(join(root, 'dist'), packedClient, { recursive: true });

const electron = JSON.parse(
  readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'),
) as { version: string };

const [appPath] = await packager({
  dir: app,
  out: join(root, 'release'),
  overwrite: true,
  platform: 'darwin',
  arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  electronVersion: electron.version,
  name: 'Orbit Runner',
  appBundleId: 'local.orbit-runner',
  appCategoryType: 'public.app-category.games',
  icon: join(app, 'icon.icns'),
  // Nothing is fetched from the network to build the app's contents.
  prune: false,
});
if (!appPath) throw new Error('the packager produced nothing');
const bundle = join(appPath, 'Orbit Runner.app');

// An Apple-silicon Mac refuses to run code with no signature at all. An
// ad hoc signature names no developer; it only seals the bundle.
run('codesign', ['--force', '--deep', '--sign', '-', bundle]);
run('codesign', ['--verify', '--deep', '--strict', bundle]);

// Start the app that was just built, against a game server started here,
// and see that it opens its window, connects and shows the game. This is
// the production client, so there is no debug hook: the page itself is read.
const server = await startServer({ port: 0 });
const profile = mkdtempSync(join(tmpdir(), 'orbit-runner-app-'));
const started = await _electron.launch({
  executablePath: join(bundle, 'Contents/MacOS/Orbit Runner'),
  env: {
    ...(process.env as Record<string, string>),
    ORBIT_SERVER_URL: `ws://127.0.0.1:${server.port}/ws`,
    ORBIT_USER_DATA: profile,
  },
});
const page = await started.firstWindow();
const problems: string[] = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
});
await page.waitForSelector('#hull:not(:empty)', { timeout: 20_000 });
await page.keyboard.down('KeyW');
await page.waitForTimeout(3000);
await page.keyboard.up('KeyW');
const seen = {
  url: page.url(),
  hull: await page.locator('#hull').textContent(),
  speed: await page.locator('#speed').textContent(),
  status: await page.locator('#status').textContent(),
  players: server.room.playerCount,
  packaged: await started.evaluate(({ app: electronApp }) => electronApp.isPackaged),
  name: await started.evaluate(({ app: electronApp }) => electronApp.getName()),
  debugHook: await page.evaluate(() => '__orbit' in window),
  consoleProblems: problems,
};
await started.close();
await server.close();
rmSync(profile, { recursive: true, force: true });

const sizeMB = Number(execFileSync('du', ['-sm', bundle]).toString().split('\t')[0]);
writeResult('macapp-packaged', { bundle: bundle.slice(root.length + 1), sizeMB, ...seen });
console.log(JSON.stringify({ sizeMB, ...seen }, null, 2));
const ok =
  seen.url === 'app://game/index.html' &&
  seen.hull === 'Hull 100' &&
  seen.status === '' &&
  seen.players === 1 &&
  seen.packaged &&
  !seen.debugHook &&
  problems.length === 0;
if (!ok) {
  console.error('\nThe packaged app did not start as expected.');
  process.exit(1);
}
console.log(`\nBuilt, signed (ad hoc) and started: ${bundle}`);
process.exit(0);
