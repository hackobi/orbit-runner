import { startServer } from './server.ts';

// A host such as Railway says which port to use in PORT.
const port = Number(process.env.ORBIT_SERVER_PORT ?? process.env.PORT ?? 8790);
// Bind to all interfaces only when asked: phones on the LAN reach the game
// through the Vite proxy, not this port.
const host = process.env.ORBIT_SERVER_HOST ?? '127.0.0.1';
// A built client to serve from this server (`npm run build` makes dist/). In
// development Vite serves the client instead.
const clientDir = process.env.ORBIT_CLIENT_DIR;

// Test hooks are for the automated tests. Never set this on a public server.
const testHooks = process.env.ORBIT_TEST_HOOKS === '1';

const server = await startServer({ port, host, testHooks, ...(clientDir ? { clientDir } : {}) });
console.log(`orbit-runner server listening on http://${host}:${server.port} (game socket at /ws)`);
if (clientDir) console.log(`serving the built client from ${clientDir}`);
if (testHooks) console.log('test hooks are ON: /debug endpoints are open');

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
