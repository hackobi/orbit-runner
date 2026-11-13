import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

// The server has no build step: Node runs the TypeScript sources directly.
// This fails if anything in the server or the shared code stops being
// runnable that way (an enum, a path alias, a missing .ts extension).
it('plain `node src/server/main.ts` boots and answers /health', async () => {
  const port = 8900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ['src/server/main.ts'], {
    env: { ...process.env, ORBIT_SERVER_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  try {
    let health: { ok?: boolean; tickRate?: number } = {};
    for (let attempt = 0; attempt < 50 && !health.ok; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as typeof health;
      } catch {
        // Not listening yet.
      }
    }
    expect(health, output).toMatchObject({ ok: true, tickRate: 60 });
    expect(output).not.toMatch(/ExperimentalWarning|Error/);
  } finally {
    child.kill();
  }
});
