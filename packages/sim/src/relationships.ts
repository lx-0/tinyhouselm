import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SimTime } from '@tina/shared';
import { simDay } from './plan.js';

export const RELATIONSHIP_FILE = 'state.json';
export const RELATIONSHIP_TMP_SUFFIX = '.tmp';
/**
 * Bumped to 2 to add the `nudges` field (TINA-275). Older v1 payloads without
 * `nudges` load fine — missing = empty queue — so boot after deploy is
 * seamless; only the version field itself gates the load, and the old writer
 * was never around to stamp v2, so we accept both on read.
 */
export const RELATIONSHIP_RECORD_VERSION = 2;

/**
 * Weekly arc label for a pair. Derived deterministically from the 7-sim-day
 * window counters at rollover time — no LLM on the hot path (TINA-207).
 */
export type ArcLabel = 'new' | 'warming' | 'cooling' | 'estranged' | 'steady';

export interface PairState {
  /** Canonical ordering: a < b (string-compare). */
  a: string;
  b: string;
  /** Running affinity, clamped to [-1, +1]. */
  affinity: number;
  /** Sim-time of the most recent close for this pair. */
  lastInteractionSim: SimTime;
  /** Cumulative count of closed conversations between these two. */
  sharedConversationCount: number;
  /** Current arc label — the thing the returner sees on the share page. */
  arcLabel: ArcLabel;
  /** Sim-day the current 7-day window began. */
  windowStartDay: number;
  /** Conversations closed inside the current window. Resets on rollover. */
  windowConversationCount: number;
  /** Sum of affinity deltas applied this window. Resets on rollover. */
  windowAffinityDelta: number;
}

/**
 * Viewer-picked bias queued against a single pair (TINA-275). One-shot: the
 * next named×named close between that exact pair consumes it, applies the
 * bounded delta to affinity, and removes the entry. Stored alongside pair
 * state and persisted on the same atomic write path.
 */
export type NudgeDirection = 'spark' | 'tension' | 'reconcile';

export const NUDGE_DELTAS: Record<NudgeDirection, number> = {
  spark: 0.25,
  tension: -0.25,
  reconcile: 0.15,
};

export interface PairNudge {
  /** Canonical ordering: a < b (string-compare). */
  a: string;
  b: string;
  direction: NudgeDirection;
  queuedAtSim: SimTime;
}

/**
 * Apply a queued nudge to a pair's current affinity. spark/reconcile floor
 * at 0 first — they "cap the pair's current affinity into the positive band"
 * per the v0.5 spec, so firing reconcile on an estranged pair actually
 * lifts them. tension simply subtracts. Final value is clamped to [-1, +1].
 */
export function applyNudge(affinity: number, direction: NudgeDirection): number {
  const delta = NUDGE_DELTAS[direction];
  if (direction === 'tension') return clamp(affinity + delta, -1, 1);
  return clamp(Math.max(0, affinity) + delta, -1, 1);
}

export type RelationshipLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

const noopLog: RelationshipLogger = () => {};

export interface RelationshipStoreOptions {
  /** Disk directory. Undefined = memory-only (tests). */
  dir?: string;
  /**
   * LRU cap on tracked pairs. Default 200 — comfortable headroom over the
   * 10-pair named×named set this v0.5 arc feature cares about.
   */
  maxPairs?: number;
  log?: RelationshipLogger;
  writer?: (path: string, body: string) => Promise<void>;
  reader?: (path: string) => Promise<string | null>;
}

interface PersistedShape {
  version: number;
  pairs: PairState[];
  /** Pending viewer nudges (TINA-275). Absent on v1 payloads. */
  nudges?: PairNudge[];
}

const DEFAULT_MAX_PAIRS = 200;

async function defaultReader(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function defaultWriter(path: string, body: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/')) || '.';
  await mkdir(dir, { recursive: true });
  const tmp = `${path}${RELATIONSHIP_TMP_SUFFIX}`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Deterministic affinity delta for one closed conversation between a pair.
 * Short chats barely register; chats over ~6 turns cap at +0.12. Repeat
 * visits in quick succession nudge slightly higher. No LLM call.
 */
export function computeAffinityDelta(input: {
  turnCount: number;
  sharedConversationCount: number;
  simTimeSinceLastInteraction: number | null;
}): number {
  const turns = Math.max(0, input.turnCount);
  const base = Math.min(0.12, turns * 0.02);
  const isRepeat =
    input.sharedConversationCount >= 3 &&
    input.simTimeSinceLastInteraction !== null &&
    input.simTimeSinceLastInteraction >= 0 &&
    input.simTimeSinceLastInteraction <= 86400;
  const repeatBonus = isRepeat ? 0.02 : 0;
  return base + repeatBonus;
}

/**
 * Deterministic arc-label derivation from a window's counters. Only ever
 * returns a post-rollover label — `new` is assigned lazily on pair creation
 * and is not reachable here. After the first rollover a pair always has a
 * real steady/warming/cooling/estranged label, even if only one conversation
 * has ever taken place (likely → cooling).
 */
export function deriveArcLabel(state: PairState): ArcLabel {
  if (state.affinity <= -0.3) return 'estranged';
  if (state.windowConversationCount === 0 || state.windowAffinityDelta < -0.05) {
    return 'cooling';
  }
  if (state.windowAffinityDelta >= 0.1 && state.windowConversationCount >= 1) {
    return 'warming';
  }
  return 'steady';
}

export interface RecordCloseInput {
  a: string;
  b: string;
  simTime: SimTime;
  turnCount: number;
}

/**
 * In-memory map of per-pair relationship state with disk persistence.
 *
 * - `recordClose` ingests one conversation-close event, updates the pair's
 *   affinity + window counters, and schedules a fire-and-forget write. New
 *   pairs are created lazily on first close.
 * - `rolloverDay` runs once per sim-day-change tick and collapses every
 *   pair's 7-day window into a fresh arc label, resetting the counters.
 * - `getPair` returns the current state for a pair (or null if never seen).
 *   Never creates on read.
 *
 * Persistence is fire-and-forget, same pattern as `MomentStore`. The sim
 * tick loop must never block on disk I/O (see memory note: sim tick network
 * I/O rule).
 */
export class RelationshipStore {
  private readonly dir: string | undefined;
  private readonly max: number;
  private readonly log: RelationshipLogger;
  private readonly writer: (path: string, body: string) => Promise<void>;
  private readonly reader: (path: string) => Promise<string | null>;
  private readonly pairs = new Map<string, PairState>();
  private readonly nudges = new Map<string, PairNudge>();
  private inFlight: Promise<void> | null = null;
  private dirty = false;

  constructor(opts: RelationshipStoreOptions = {}) {
    this.dir = opts.dir;
    this.max = Math.max(1, Math.floor(opts.maxPairs ?? DEFAULT_MAX_PAIRS));
    this.log = opts.log ?? noopLog;
    this.writer = opts.writer ?? defaultWriter;
    this.reader = opts.reader ?? defaultReader;
  }

  async load(): Promise<void> {
    if (!this.dir) return;
    const path = join(this.dir, RELATIONSHIP_FILE);
    let raw: string | null;
    try {
      raw = await this.reader(path);
    } catch (err) {
      this.log('warn', 'relationships.read.error', {
        path,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.log('warn', 'relationships.parse.error', {
        path,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const shape = parsed as Partial<PersistedShape>;
    // v1 predates the nudge queue (TINA-275). We accept it and treat nudges
    // as empty — lets prod boot after deploy without manually discarding the
    // existing relationships file.
    if (shape.version !== RELATIONSHIP_RECORD_VERSION && shape.version !== 1) {
      this.log('warn', 'relationships.version.mismatch', {
        path,
        found: shape.version ?? null,
        expected: RELATIONSHIP_RECORD_VERSION,
      });
      return;
    }
    const arr = Array.isArray(shape.pairs) ? shape.pairs : [];
    for (const p of arr) {
      if (!p || typeof p.a !== 'string' || typeof p.b !== 'string') continue;
      const key = pairKey(p.a, p.b);
      // Normalize ordering to canonical in case the on-disk row was written
      // with an older schema that didn't enforce it.
      const canonA = p.a < p.b ? p.a : p.b;
      const canonB = p.a < p.b ? p.b : p.a;
      this.pairs.set(key, { ...p, a: canonA, b: canonB });
    }
    const nArr = Array.isArray(shape.nudges) ? shape.nudges : [];
    for (const n of nArr) {
      if (!n || typeof n.a !== 'string' || typeof n.b !== 'string') continue;
      if (n.direction !== 'spark' && n.direction !== 'tension' && n.direction !== 'reconcile') {
        continue;
      }
      const canonA = n.a < n.b ? n.a : n.b;
      const canonB = n.a < n.b ? n.b : n.a;
      this.nudges.set(pairKey(n.a, n.b), {
        a: canonA,
        b: canonB,
        direction: n.direction,
        queuedAtSim: Number(n.queuedAtSim) || 0,
      });
    }
    this.log('info', 'relationships.loaded', {
      path,
      count: this.pairs.size,
      nudges: this.nudges.size,
    });
  }

  count(): number {
    return this.pairs.size;
  }

  list(): PairState[] {
    return [...this.pairs.values()];
  }

  getPair(a: string, b: string): PairState | null {
    if (a === b) return null;
    return this.pairs.get(pairKey(a, b)) ?? null;
  }

  /**
   * Number of pending viewer nudges (TINA-275). Bounded in practice by the
   * named roster (one nudge per pair max), but surfaced so tests can assert
   * and admin can log.
   */
  nudgeCount(): number {
    return this.nudges.size;
  }

  listNudges(): PairNudge[] {
    return [...this.nudges.values()];
  }

  peekNudge(a: string, b: string): PairNudge | null {
    if (a === b) return null;
    return this.nudges.get(pairKey(a, b)) ?? null;
  }

  /**
   * Queue a one-shot nudge against a pair. Replaces any existing queued nudge
   * for the same pair — per spec, at most one queued nudge per pair
   * (no cumulative stacking).
   */
  queueNudge(input: {
    a: string;
    b: string;
    direction: NudgeDirection;
    simTime: SimTime;
  }): PairNudge {
    if (input.a === input.b) throw new Error('queueNudge: pair ids must differ');
    const canonA = input.a < input.b ? input.a : input.b;
    const canonB = input.a < input.b ? input.b : input.a;
    const nudge: PairNudge = {
      a: canonA,
      b: canonB,
      direction: input.direction,
      queuedAtSim: input.simTime,
    };
    this.nudges.set(pairKey(input.a, input.b), nudge);
    this.scheduleFlush();
    return nudge;
  }

  /**
   * If a nudge is queued for this pair, apply its bounded delta to the pair's
   * current affinity (+ window counters so the next arc rollover sees it),
   * remove it from the queue, and return the consumed entry. Returns null
   * when no nudge was queued or the pair has no recorded state yet (pair is
   * created lazily by recordClose, so the caller should invoke this AFTER
   * recordClose).
   */
  consumeNudgeOnClose(a: string, b: string): PairNudge | null {
    if (a === b) return null;
    const key = pairKey(a, b);
    const nudge = this.nudges.get(key);
    if (!nudge) return null;
    const state = this.pairs.get(key);
    if (!state) {
      // recordClose should have created the pair; if we got here without
      // one, leave the nudge queued and skip rather than fabricating state.
      return null;
    }
    const before = state.affinity;
    const after = applyNudge(before, nudge.direction);
    const delta = after - before;
    state.affinity = after;
    state.windowAffinityDelta += delta;
    this.nudges.delete(key);
    this.scheduleFlush();
    return nudge;
  }

  /**
   * Aggregate affinity weight per zone from one agent's view of others. Used
   * by Runtime to seed `Perception.zoneAffinityHints`. Callers pass their
   * own id + a map of `otherId -> currentZone`. Only pairs we already track
   * contribute — unknown pairs are treated as 0 (no bias).
   */
  zoneAffinityFor(selfId: string, othersByZone: Map<string, string>): Map<string, number> {
    const out = new Map<string, number>();
    if (this.pairs.size === 0) return out;
    for (const [otherId, zone] of othersByZone) {
      if (!zone || otherId === selfId) continue;
      const state = this.pairs.get(pairKey(selfId, otherId));
      if (!state) continue;
      out.set(zone, (out.get(zone) ?? 0) + state.affinity);
    }
    return out;
  }

  /**
   * Record a closed conversation between two agents. Creates the pair lazily
   * on first seen, updates affinity + counters, and schedules a write.
   * Returns the updated state.
   */
  recordClose(input: RecordCloseInput): PairState {
    if (input.a === input.b) {
      throw new Error('recordClose: pair ids must differ');
    }
    const key = pairKey(input.a, input.b);
    const canonA = input.a < input.b ? input.a : input.b;
    const canonB = input.a < input.b ? input.b : input.a;
    const currentDay = simDay(input.simTime);
    const existing = this.pairs.get(key);

    const delta = computeAffinityDelta({
      turnCount: input.turnCount,
      sharedConversationCount: existing?.sharedConversationCount ?? 0,
      simTimeSinceLastInteraction: existing ? input.simTime - existing.lastInteractionSim : null,
    });

    let state: PairState;
    if (!existing) {
      state = {
        a: canonA,
        b: canonB,
        affinity: clamp(delta, -1, 1),
        lastInteractionSim: input.simTime,
        sharedConversationCount: 1,
        arcLabel: 'new',
        windowStartDay: currentDay,
        windowConversationCount: 1,
        windowAffinityDelta: delta,
      };
    } else {
      state = {
        ...existing,
        affinity: clamp(existing.affinity + delta, -1, 1),
        lastInteractionSim: input.simTime,
        sharedConversationCount: existing.sharedConversationCount + 1,
        windowConversationCount: existing.windowConversationCount + 1,
        windowAffinityDelta: existing.windowAffinityDelta + delta,
      };
    }
    this.pairs.set(key, state);
    this.evictIfOver();
    this.scheduleFlush();
    return state;
  }

  /**
   * For every pair whose 7-sim-day window has elapsed at `currentSimTime`,
   * derive a fresh arc label from the window's counters and reset the
   * window. Returns the number of pairs that rolled over.
   *
   * Safe to call every tick — pairs inside their window are left alone.
   */
  rolloverDay(currentSimTime: SimTime): number {
    const today = simDay(currentSimTime);
    let changed = 0;
    for (const state of this.pairs.values()) {
      if (today - state.windowStartDay < 7) continue;
      const label = deriveArcLabel(state);
      state.arcLabel = label;
      state.windowStartDay = today;
      state.windowConversationCount = 0;
      state.windowAffinityDelta = 0;
      changed += 1;
    }
    if (changed > 0) this.scheduleFlush();
    return changed;
  }

  async flush(): Promise<void> {
    // scheduleFlush may chain a follow-on write in its finally when we
    // became dirty during the in-flight write. Drain until both `inFlight`
    // clears and `dirty` is false so callers (tests, shutdown) see every
    // pending change on disk.
    while (this.inFlight || this.dirty) {
      if (this.inFlight) {
        try {
          await this.inFlight;
        } catch {
          /* already logged */
        }
      } else {
        await this.write();
      }
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (!this.dir) return;
    if (this.inFlight) return;
    this.inFlight = this.write().finally(() => {
      this.inFlight = null;
      if (this.dirty) this.scheduleFlush();
    });
    this.inFlight.catch(() => {});
  }

  private async write(): Promise<void> {
    if (!this.dir) {
      this.dirty = false;
      return;
    }
    this.dirty = false;
    const snapshot: PersistedShape = {
      version: RELATIONSHIP_RECORD_VERSION,
      pairs: [...this.pairs.values()],
      nudges: [...this.nudges.values()],
    };
    const path = join(this.dir, RELATIONSHIP_FILE);
    const body = `${JSON.stringify(snapshot)}\n`;
    try {
      await this.writer(path, body);
    } catch (err) {
      this.dirty = true;
      this.log('error', 'relationships.write.error', {
        path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private evictIfOver(): void {
    if (this.pairs.size <= this.max) return;
    // Evict the least-recently-interacted pair first. Stable: same tie
    // breaks by insertion order via Map iteration.
    const sorted = [...this.pairs.entries()].sort(
      (x, y) => x[1].lastInteractionSim - y[1].lastInteractionSim,
    );
    const over = this.pairs.size - this.max;
    for (let i = 0; i < over; i++) {
      const entry = sorted[i];
      if (!entry) break;
      this.pairs.delete(entry[0]);
      // Drop any queued nudge for the same pair so the queue can't grow
      // orphaned entries that no recordClose will ever consume.
      this.nudges.delete(entry[0]);
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
