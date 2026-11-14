import { expect, test } from '@playwright/test';
import type { DebugHook } from '../../src/client/debugHook.ts';
import { SERVER_PORT } from '../../playwright.config.ts';
import { waitForEmptyRoom } from './support.ts';

declare global {
  interface Window {
    __orbit?: DebugHook;
  }
}

// The installable app: the conditions Chrome sets for installing a page,
// checked one by one, and the page opening with no network.

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  orientation: string;
  icons: { src: string; sizes: string; purpose?: string }[];
}

test('the page meets the conditions for installing: manifest, icons, secure page, service worker', async ({
  page,
  context,
}) => {
  await waitForEmptyRoom();
  await page.goto('/');
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  // The service worker takes over the page.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

  // The browser found the manifest and could read all of it. (Its verdict
  // on installing is not asked here: a headless browser answers "no
  // objections" for any page, even one with no manifest, as the second half
  // shows. `npm run console-check` asks it in a real window.)
  const cdp = await context.newCDPSession(page);
  const found = await cdp.send('Page.getAppManifest');
  expect(found.url).toContain('manifest.webmanifest');
  expect(found.errors).toEqual([]);
  const bare = await context.newPage();
  await bare.goto(`http://127.0.0.1:${SERVER_PORT}/health`);
  const none = await (await context.newCDPSession(bare)).send('Page.getAppManifest');
  expect(none.url).toBe('');
  await bare.close();
  // Chrome's documented conditions, one by one: a secure page, a working
  // service worker, and (below) a name, a start address, a display mode and
  // icons of 192 and 512.
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.ready).active !== null),
  ).toBe(true);

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const response = await page.request.get(href ?? '');
  expect(response.ok()).toBe(true);
  const manifest = (await response.json()) as Manifest;
  expect(manifest).toMatchObject({
    name: 'Orbit Runner',
    short_name: 'Orbit Runner',
    start_url: '/',
    display: 'fullscreen',
    orientation: 'landscape',
  });
  const sizes = manifest.icons.map(
    (icon) => `${icon.sizes}${icon.purpose ? ` ${icon.purpose}` : ''}`,
  );
  expect(sizes).toEqual(['192x192', '512x512', '512x512 maskable']);
  for (const icon of manifest.icons) {
    const image = await page.request.get(`/${icon.src}`);
    expect(image.ok(), icon.src).toBe(true);
    expect(image.headers()['content-type']).toBe('image/png');
  }
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    '/icons/apple-touch-icon.png',
  );
});

test('with no network the page still opens, and says it is trying to connect', async ({
  page,
  context,
}) => {
  await waitForEmptyRoom();
  await page.goto('/');
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  // The worker has stored the page and its scripts by now.
  await page.waitForFunction(async () => (await caches.keys()).length > 0);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#game')).toBeVisible();
  await expect(page.locator('#status')).toContainText(/Connecting|Reconnecting|Connection lost/);
  await context.setOffline(false);
  // And when the network is back, so is the game.
  await page.waitForFunction(() => window.__orbit?.status().status === 'playing', null, {
    timeout: 20_000,
  });
});
