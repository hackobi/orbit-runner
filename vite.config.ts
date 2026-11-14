import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const clientPort = Number(process.env.ORBIT_CLIENT_PORT ?? 5173);
const serverPort = Number(process.env.ORBIT_SERVER_PORT ?? 8787);

// Page and game socket share one origin, so one certificate covers both.
const proxy = {
  '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
};

// The installable app: a manifest, and a service worker that keeps the page
// and its scripts so the game opens without the network (it still needs the
// network to play). A new version waits until the page says to load it, which
// the client does between lives.
const pwa = VitePWA({
  registerType: 'prompt',
  includeAssets: ['icons/apple-touch-icon.png', 'icons/icon.svg'],
  manifest: {
    name: 'Orbit Runner',
    short_name: 'Orbit Runner',
    description: 'Fly a saucer through an asteroid belt and fight other players.',
    lang: 'en',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    display_override: ['fullscreen', 'standalone'],
    // Android locks an installed app to this. iOS ignores it, so the page
    // asks for the phone to be turned instead.
    orientation: 'landscape',
    theme_color: '#030a1a',
    background_color: '#030a1a',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      {
        src: 'icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
    navigateFallback: '/index.html',
    // The game socket and the server's own pages are never answered from the cache.
    navigateFallbackDenylist: [/^\/ws/, /^\/health/, /^\/debug/],
  },
});

// `npm run dev:lan` serves the dev build over HTTPS to other devices on the
// local network, so a phone can load it (docs/DEVICE-TESTING.md). The first
// run downloads mkcert, makes a certificate authority in .cert/ and adds it
// to this Mac's keychain, which macOS asks permission for. Nothing here runs
// unless ORBIT_LAN=1.
const lan = process.env.ORBIT_LAN === '1';

export default defineConfig(async () => ({
  plugins: [
    pwa,
    ...(lan ? [(await import('vite-plugin-mkcert')).default({ savePath: '.cert' })] : []),
  ],
  // The debug hook is compiled in only when VITE_TEST_HOOKS=1. A literal
  // false lets the bundler delete the hook and everything it imports.
  define: {
    __ORBIT_TEST_HOOKS__: JSON.stringify(process.env.VITE_TEST_HOOKS === '1'),
  },
  server: { port: clientPort, strictPort: true, proxy, host: lan },
  // `vite preview` serves the production build the same way; the end-to-end
  // tests use it.
  // By hand it gets a port of its own: its service worker would otherwise
  // go on answering for the dev server at the same address.
  preview: {
    port: process.env.ORBIT_CLIENT_PORT ? clientPort : 4173,
    strictPort: true,
    proxy,
    host: lan,
  },
  build: { target: 'es2022' },
}));
