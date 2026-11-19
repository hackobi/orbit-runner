import { FilePilotStore, MemoryPilotStore } from './pilots.ts';
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

// Raiders and the Warlord fly unless switched off. The automated tests
// measure players against each other, so they run without.
const npcs = process.env.ORBIT_NPCS ? process.env.ORBIT_NPCS === '1' : !testHooks;

// Pilots' progress is written to this directory, which must survive a
// restart to be of use (on Railway, a volume). Without it, progress is kept
// in memory and a restart or a deploy forgets it.
const dataDir = process.env.ORBIT_DATA_DIR;
const pilots = dataDir ? new FilePilotStore(dataDir) : new MemoryPilotStore();

const server = await startServer({
  port,
  host,
  testHooks,
  npcs,
  pilots,
  ...(clientDir ? { clientDir } : {}),
});
console.log(`orbit-runner server listening on http://${host}:${server.port} (game socket at /ws)`);
if (clientDir) console.log(`serving the built client from ${clientDir}`);
if (testHooks) console.log('test hooks are ON: /debug endpoints are open');
console.log(npcs ? 'raiders and the Warlord are flying' : 'no server-flown ships');
console.log(
  dataDir
    ? `pilot progress is kept in ${dataDir}`
    : 'pilot progress is kept in memory only: set ORBIT_DATA_DIR to keep it across restarts',
);

const shutdown = (): void => {
  void server.close().then(() => {
    if (pilots instanceof FilePilotStore) pilots.flush();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
