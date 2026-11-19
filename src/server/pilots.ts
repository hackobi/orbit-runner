// Where pilots' progress is kept between visits. It lives in memory, and in a
// file as well when the server is given a directory that survives restarts.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MISSIONS } from '../shared/progress.ts';
import type { Progress } from '../shared/progress.ts';

/** What the room needs from a store. The key is the pilot's key in hex. */
export interface PilotStore {
  load(key: string): Progress | undefined;
  save(key: string, progress: Progress): void;
}

const whole = (value: unknown, max: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : null;

/** A record read from disk, or null if it is not one. */
function progressFrom(value: unknown): Progress | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const xp = whole(record.xp, 0xffffffff);
  const missionIndex = whole(record.missionIndex, MISSIONS.length - 1);
  const missionProgress = whole(record.missionProgress, 65535);
  const missionsDone = whole(record.missionsDone, 65535);
  if (xp === null || missionIndex === null || missionProgress === null || missionsDone === null) {
    return null;
  }
  return { xp, missionIndex, missionProgress, missionsDone };
}

/** The most pilots remembered. The longest unseen is forgotten first. */
const MAX_PILOTS = 50_000;
const WRITE_EVERY_MS = 5000;

export class MemoryPilotStore implements PilotStore {
  protected readonly pilots = new Map<string, Progress>();

  load(key: string): Progress | undefined {
    const found = this.pilots.get(key);
    return found ? { ...found } : undefined;
  }

  save(key: string, progress: Progress): void {
    // Two tabs share one key. Experience never goes down, so the further on wins.
    const known = this.pilots.get(key);
    if (known && known.xp > progress.xp) return;
    this.pilots.delete(key);
    this.pilots.set(key, { ...progress });
    if (this.pilots.size > MAX_PILOTS) {
      const oldest = this.pilots.keys().next();
      if (!oldest.done) this.pilots.delete(oldest.value);
    }
  }
}

/** The same, written to `pilots.json` in a directory at most every few seconds. */
export class FilePilotStore extends MemoryPilotStore {
  private readonly file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(directory: string) {
    super();
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'pilots.json');
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    // A file that cannot be read as pilots stops the server: starting empty
    // would overwrite everyone's progress at the first save.
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`${this.file} does not hold pilots`);
    }
    for (const [key, value] of Object.entries(parsed)) {
      const progress = progressFrom(value);
      if (!progress || !/^[0-9a-f]{32}$/.test(key)) {
        throw new Error(`${this.file} has a record that is not a pilot: ${key}`);
      }
      this.pilots.set(key, progress);
    }
  }

  override save(key: string, progress: Progress): void {
    super.save(key, progress);
    this.timer ??= setTimeout(() => {
      this.flush();
    }, WRITE_EVERY_MS);
  }

  /** Writes now. The server calls this as it shuts down. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Written beside the file and moved over it, so a crash leaves the old one whole.
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.pilots)));
    renameSync(temporary, this.file);
  }
}
