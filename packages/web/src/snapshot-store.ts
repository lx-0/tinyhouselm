import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORLD_STATE_SNAPSHOT_VERSION, type WorldStateSnapshot } from '@tina/shared';
import type { Runtime } from '@tina/sim';

export const SNAPSHOT_FILE = 'world.json';
export const SNAPSHOT_TMP_SUFFIX = '.tmp';

export type SnapshotLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

const noopLog: SnapshotLogger = () => {};

export async function readSnapshot(
  dir: string,
  log: SnapshotLogger = noopLog,
): Promise<WorldStateSnapshot | null> {
  const path = join(dir, SNAPSHOT_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log('warn', 'snapshot.read.error', {
      path,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log('warn', 'snapshot.parse.error', {
      path,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    log('warn', 'snapshot.shape.error', { path, reason: 'not an object' });
    return null;
  }
  const snap = parsed as Partial<WorldStateSnapshot>;
  if (snap.version !== WORLD_STATE_SNAPSHOT_VERSION) {
    log('warn', 'snapshot.version.mismatch', {
      path,
      found: snap.version ?? null,
      expected: WORLD_STATE_SNAPSHOT_VERSION,
    });
    return null;
  }
  return snap as WorldStateSnapshot;
}

export async function writeSnapshot(dir: string, snap: WorldStateSnapshot): Promise<void> {
  await mkdir(dir, { recursive: true });
  const final = join(dir, SNAPSHOT_FILE);
  const tmp = `${final}${SNAPSHOT_TMP_SUFFIX}`;
  const body = `${JSON.stringify(snap)}\n`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, final);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export interface SnapshotSchedulerOptions {
  dir: string;
  runtime: Runtime;
  /**
   * Save every N ticks. Use 0 to disable the periodic cadence. Manual
   * force-save still works regardless.
   */
  everyTicks: number;
  log?: SnapshotLogger;
  /** Swap out the actual writer for tests. */
  writer?: (dir: string, snap: WorldStateSnapshot) => Promise<void>;
  /** Inject a wall-clock source for tests. */
  now?: () => number;
}

export interface SnapshotStatus {
  enabled: boolean;
  everyTicks: number;
  dir: string;
  lastSavedAt: string | null;
  lastTickIndex: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  inFlight: boolean;
  saves: number;
  failures: number;
}

export interface SnapshotScheduler {
  /** Status snapshot for /admin display. */
  status(): SnapshotStatus;
  /**
   * Tell the scheduler a tick has just finished. Fires a save when the tick
   * index is a multiple of `everyTicks`. Fire-and-forget — never awaits.
   */
  notifyTick(): void;
  /**
   * Force an immediate save. Awaits any in-flight save first so the caller
   * can rely on a durable snapshot being on disk before (for example) the
   * process exits.
   */
  forceSave(): Promise<void>;
  /** Stop the scheduler. Does not cancel an in-flight save. */
  dispose(): void;
}

export function scheduleSnapshots(opts: SnapshotSchedulerOptions): SnapshotScheduler {
  const log = opts.log ?? noopLog;
  const write = opts.writer ?? writeSnapshot;
  const now = opts.now ?? (() => Date.now());
  const everyTicks = Math.max(0, Math.floor(opts.everyTicks));
  let lastSavedAt: string | null = null;
  let lastTickIndex: number | null = null;
  let lastDurationMs: number | null = null;
  let lastError: string | null = null;
  let saves = 0;
  let failures = 0;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  function runSave(reason: 'periodic' | 'manual'): Promise<void> {
    const snap = opts.runtime.toStateSnapshot();
    const startedAt = now();
    const tickAt = snap.tickIndex;
    const promise = (async () => {
      try {
        await write(opts.dir, snap);
        lastSavedAt = new Date().toISOString();
        lastTickIndex = tickAt;
        lastDurationMs = now() - startedAt;
        lastError = null;
        saves += 1;
        log('info', 'snapshot.write', {
          reason,
          tickIndex: tickAt,
          simTime: snap.clock.simTime,
          durationMs: lastDurationMs,
          dir: opts.dir,
        });
      } catch (err) {
        failures += 1;
        lastError = err instanceof Error ? err.message : String(err);
        lastDurationMs = now() - startedAt;
        log('error', 'snapshot.write.error', {
          reason,
          tickIndex: tickAt,
          message: lastError,
        });
      } finally {
        inFlight = null;
      }
    })();
    inFlight = promise;
    return promise;
  }

  return {
    status(): SnapshotStatus {
      return {
        enabled: everyTicks > 0,
        everyTicks,
        dir: opts.dir,
        lastSavedAt,
        lastTickIndex,
        lastDurationMs,
        lastError,
        inFlight: inFlight !== null,
        saves,
        failures,
      };
    },
    notifyTick(): void {
      if (disposed) return;
      if (everyTicks <= 0) return;
      if (inFlight) return;
      const tick = opts.runtime.tickIndex;
      if (tick <= 0 || tick % everyTicks !== 0) return;
      void runSave('periodic');
    },
    async forceSave(): Promise<void> {
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          /* already logged */
        }
      }
      await runSave('manual');
    },
    dispose(): void {
      disposed = true;
    },
  };
}
