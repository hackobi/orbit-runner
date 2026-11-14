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

export default defineConfig({
  plugins: [pwa],
  // The debug hook is compiled in only when VITE_TEST_HOOKS=1. A literal
  // false lets the bundler delete the hook and everything it imports.
  define: {
    __ORBIT_TEST_HOOKS__: JSON.stringify(process.env.VITE_TEST_HOOKS === '1'),
  },
  server: { port: clientPort, strictPort: true, proxy },
  // `vite preview` serves the production build the same way; the end-to-end
  // tests use it.
  preview: { port: clientPort, strictPort: true, proxy },
  build: { target: 'es2022' },
});
