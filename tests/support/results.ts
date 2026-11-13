// Where measured numbers go. Tests write what they measured to
// docs/results/<name>.json, and scripts/results.ts turns those files into the
// tables in docs/PLAN.md, judging each against tests/thresholds.ts. Nothing
// in the plan's results section is typed by hand.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../docs/results');

export function writeResult(name: string, data: unknown): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const body = { measuredAt: new Date().toISOString(), data };
  writeFileSync(join(RESULTS_DIR, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
}

/** Reads a result back. The caller says what shape it expects. */
export function readResult(name: string): { measuredAt: string; data: unknown } {
  return JSON.parse(readFileSync(join(RESULTS_DIR, `${name}.json`), 'utf8')) as {
    measuredAt: string;
    data: unknown;
  };
}
