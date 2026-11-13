import { startServer } from './server.ts';

const port = Number(process.env.ORBIT_SERVER_PORT ?? 8787);
// Bind to all interfaces only when asked: phones on the LAN reach the game
// through the Vite proxy, not this port.
const host = process.env.ORBIT_SERVER_HOST ?? '127.0.0.1';

// Test hooks are for the automated tests. Never set this on a public server.
const testHooks = process.env.ORBIT_TEST_HOOKS === '1';

const server = await startServer({ port, host, testHooks });
console.log(`orbit-runner server listening on http://${host}:${server.port} (game socket at /ws)`);
if (testHooks) console.log('test hooks are ON: /debug endpoints are open');

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
