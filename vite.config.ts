import { defineConfig } from 'vite';

const clientPort = Number(process.env.ORBIT_CLIENT_PORT ?? 5173);
const serverPort = Number(process.env.ORBIT_SERVER_PORT ?? 8787);

export default defineConfig({
  // The debug hook is compiled in only when VITE_TEST_HOOKS=1. A literal
  // false lets the bundler delete the hook and everything it imports.
  define: {
    __ORBIT_TEST_HOOKS__: JSON.stringify(process.env.VITE_TEST_HOOKS === '1'),
  },
  server: {
    port: clientPort,
    strictPort: true,
    // Page and game socket share one origin, so one certificate covers both.
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
    },
  },
  build: { target: 'es2022' },
});
