// Orbit Runner for the Mac: one window that shows the game.
//
// Where the game comes from is set in config.json, next to this file:
//
// - gameUrl: the HTTPS address the game is served from. The normal case once
//   the game is deployed. The page and its socket come from the server, so
//   the app can never be out of step with the server's version of the rules.
// - If gameUrl is empty, the copy of the client packed into the app is
//   shown instead, and its socket goes to serverUrl. This is for
//   development on one machine: a packed client stops being welcome as soon
//   as the server's rules change.
//
// ORBIT_GAME_URL and ORBIT_SERVER_URL override the file; ORBIT_CLIENT_DIR
// points at a different built client; ORBIT_USER_DATA is where the browser
// engine keeps its profile. The tests use all four, the last so that a test
// run leaves nothing in the user's Library and starts from nothing.

import { BrowserWindow, app, net, protocol, session } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, 'config.json'), 'utf8'));
const gameUrl = process.env.ORBIT_GAME_URL ?? config.gameUrl ?? '';
const serverUrl = process.env.ORBIT_SERVER_URL ?? config.serverUrl ?? '';
const clientDir = path.resolve(process.env.ORBIT_CLIENT_DIR ?? path.join(here, 'client'));

if (process.env.ORBIT_USER_DATA) app.setPath('userData', process.env.ORBIT_USER_DATA);

// The packed client is served from app://game/, which the browser engine
// treats like an https origin: module scripts, fetch and storage all work.
const PACKED_ORIGIN = 'app://game';
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const socketOrigin = serverUrl ? new URL(serverUrl).origin : '';
const CONTENT_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // The game sets element styles from script, which this does not restrict;
  // three.js adds a style element of its own.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${socketOrigin}`,
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/** The one origin the window may show. Anything else is refused. */
const allowedOrigin = gameUrl ? new URL(gameUrl).origin : PACKED_ORIGIN;

function servePackedClient() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const wanted = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.join(clientDir, wanted);
    // Nothing outside the client's own folder.
    if (url.host !== 'game' || path.relative(clientDir, file).startsWith('..')) {
      return new Response('not found', { status: 404 });
    }
    let response;
    try {
      response = await net.fetch(pathToFileURL(file).toString());
    } catch {
      // No such file.
      return new Response('not found', { status: 404 });
    }
    // The page may load only its own files and talk only to its game server.
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CONTENT_POLICY);
    return new Response(response.body, { status: response.status, headers });
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    title: 'Orbit Runner',
    backgroundColor: '#030a1a',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      // The page is a web page and gets a web page's powers, no more.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Tells the page which socket to use when it is the packed copy.
      additionalArguments: gameUrl ? [] : [`--orbit-server-url=${serverUrl}`],
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== allowedOrigin) event.preventDefault();
  });
  void window.loadURL(gameUrl || `${PACKED_ORIGIN}/index.html`);
  return window;
}

// No top-level await here: a test runner that starts the app holds back
// "ready" until this file has finished loading, and would wait for ever.
void app.whenReady().then(() => {
  // The game asks for nothing a browser would prompt for; say no to anything that does.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, decide) => {
    decide(false);
  });
  if (!gameUrl) servePackedClient();
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
// It is a game with one window: closing the window quits.
app.on('window-all-closed', () => {
  app.quit();
});
