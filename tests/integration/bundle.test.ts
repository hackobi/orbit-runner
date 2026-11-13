import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const outDirs: string[] = [];

function build(testHooks: boolean): string {
  const outDir = mkdtempSync(join(tmpdir(), 'orbit-build-'));
  outDirs.push(outDir);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VITE_TEST_HOOKS;
  if (testHooks) env.VITE_TEST_HOOKS = '1';
  execFileSync(
    'npx',
    ['vite', 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'],
    {
      env,
      stdio: 'pipe',
    },
  );
  const assets = join(outDir, 'assets');
  return readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(assets, name), 'utf8'))
    .join('\n');
}

afterAll(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
});

describe('the debug hook', () => {
  it('is absent from the production bundle', () => {
    const bundle = build(false);
    expect(bundle.length).toBeGreaterThan(100_000);
    expect(bundle).not.toContain('__orbit');
    expect(bundle).not.toContain('__ORBIT_TEST_HOOKS__');
  });

  it('is present when the build asks for it, so the check above means something', () => {
    expect(build(true)).toContain('__orbit');
  });
});
