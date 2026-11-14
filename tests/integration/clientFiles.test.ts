import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startServer } from '../../src/server/server.ts';
import type { RunningServer } from '../../src/server/server.ts';

// In production one server gives out the page and runs the game socket, so
// that both share an address.
let dir = '';
let server: RunningServer;
let base = '';

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'orbit-client-'));
  await mkdir(path.join(dir, 'client', 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'client', 'index.html'), '<!doctype html><title>game</title>');
  await writeFile(path.join(dir, 'client', 'sw.js'), 'self.x = 1;');
  await writeFile(path.join(dir, 'client', 'assets', 'index-abc123.js'), 'console.log(1);');
  await writeFile(path.join(dir, 'secret.txt'), 'outside the client folder');
  server = await startServer({ port: 0, clientDir: path.join(dir, 'client') });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

it('serves the page at / and checks it on every load', async () => {
  const response = await fetch(`${base}/`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/html/);
  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(await response.text()).toContain('<title>game</title>');
});

it('the service worker is never cached, so an update reaches the player', async () => {
  const response = await fetch(`${base}/sw.js`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/javascript/);
  expect(response.headers.get('cache-control')).toBe('no-cache');
});

it('hashed assets are cached for good', async () => {
  const response = await fetch(`${base}/assets/index-abc123.js`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('immutable');
});

/** Sends the path exactly as written: fetch would tidy away the "..". */
function rawStatus(target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port: server.port, path: target }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on('error', reject);
  });
}

it('nothing outside the client folder, and no unknown files', async () => {
  for (const target of [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/../../secret.txt',
    '/missing.js',
  ]) {
    expect(await rawStatus(target), target).toBe(404);
  }
});

it('/health still answers', async () => {
  const health = (await (await fetch(`${base}/health`)).json()) as { ok: boolean };
  expect(health.ok).toBe(true);
});
