import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MOMENT_RECORD_VERSION,
  type MomentParticipant,
  type MomentRecord,
  type MomentReflection,
  type SimTime,
  type WorldClock,
  buildGroupMomentHeadline,
  buildMomentHeadline,
  deriveWorldClock,
} from '@tina/shared';
import type { ConversationTurn } from '@tina/shared';

export const MOMENT_FILE = 'moments.json';
export const MOMENT_TMP_SUFFIX = '.tmp';

export type MomentLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

const noopLog: MomentLogger = () => {};

export interface CapturedClose {
  sessionId: string;
  simTime: SimTime;
  openedAt: SimTime;
  participants: MomentParticipant[];
  transcript: ConversationTurn[];
  zone: string | null;
  closeReason: 'drifted' | 'idle' | 'aged';
}

/**
 * Group co-presence capture (TINA-345). No transcript — just the participants
 * who were standing together in the zone. The session id must be unique and
 * stable (the runtime mints `grp-<tick>-<seq>` ids).
 */
export interface CapturedGroup {
  sessionId: string;
  simTime: SimTime;
  participants: MomentParticipant[];
  zone: string | null;
}

export interface MomentStoreOptions {
  /**
   * Disk directory for the persisted moments JSON. When undefined the store
   * runs in memory only (used by unit tests / dev where disk is not wanted).
   */
  dir?: string;
  /** LRU cap. Default 500 — newest 500 kept, oldest evicted. */
  maxMoments?: number;
  /**
   * Window in sim-seconds within which a reflection fired on one of the
   * moment's participants is attached back to that moment. Default 300
   * (5 sim-minutes). Keeps late-arriving reflections inline with the
   * conversation that triggered them without cross-linking unrelated ones.
   */
  reflectionAttachWindowSim?: number;
  log?: MomentLogger;
  /** Wall-clock source (ISO string) — swappable in tests. */
  now?: () => string;
  /**
   * ID generator for new moments. Defaults to a short url-safe random id.
   * Swappable in tests for determinism.
   */
  idGenerator?: () => string;
  /** Swap the writer for tests. */
  writer?: (path: string, body: string) => Promise<void>;
  /** Swap the reader for tests. */
  reader?: (path: string) => Promise<string | null>;
}

interface PersistedShape {
  version: number;
  moments: MomentRecord[];
}

const DEFAULT_MAX_MOMENTS = 500;
const DEFAULT_REFLECTION_WINDOW_SIM = 300;

function defaultIdGenerator(): string {
  // 8-byte url-safe base62-ish id. Collision-space ~= 2^48 which is
  // comfortably above anything we'll hold under the LRU cap.
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  }
  return out;
}

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
  const tmp = `${path}${MOMENT_TMP_SUFFIX}`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * In-memory LRU of recent conversation moments with disk persistence.
 *
 * - `captureClose` ingests a conversation-close event, producing a stable
 *   moment id for that session. Calling it again with the same sessionId
 *   returns the existing id (create-or-retrieve semantics — this is what
 *   the /admin Share button relies on).
 * - `attachReflection` glues a reflection that landed shortly after a close
 *   onto the matching moment, so the `/moment/:id` page shows the "what the
 *   agent took away" line the spec asks for. Out-of-window reflections are
 *   ignored rather than attached to an unrelated moment.
 * - Persistence is fire-and-forget — the sim tick loop is never awaited (see
 *   the "tick loop network I/O rule"). Failures are logged but never thrown.
 */
export class MomentStore {
  private readonly dir: string | undefined;
  private readonly max: number;
  private readonly reflectionWindowSim: number;
  private readonly log: MomentLogger;
  private readonly now: () => string;
  private readonly idGenerator: () => string;
  private readonly writer: (path: string, body: string) => Promise<void>;
  private readonly reader: (path: string) => Promise<string | null>;
  private readonly byId = new Map<string, MomentRecord>();
  private readonly bySession = new Map<string, string>();
  private inFlight: Promise<void> | null = null;
  private dirty = false;

  constructor(opts: MomentStoreOptions = {}) {
    this.dir = opts.dir;
    this.max = Math.max(1, Math.floor(opts.maxMoments ?? DEFAULT_MAX_MOMENTS));
    this.reflectionWindowSim = Math.max(
      0,
      opts.reflectionAttachWindowSim ?? DEFAULT_REFLECTION_WINDOW_SIM,
    );
    this.log = opts.log ?? noopLog;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.idGenerator = opts.idGenerator ?? defaultIdGenerator;
    this.writer = opts.writer ?? defaultWriter;
    this.reader = opts.reader ?? defaultReader;
  }

  /** Load moments from disk. Safe to call on boot; no-op if dir is unset. */
  async load(): Promise<void> {
    if (!this.dir) return;
    const path = join(this.dir, MOMENT_FILE);
    let raw: string | null;
    try {
      raw = await this.reader(path);
    } catch (err) {
      this.log('warn', 'moments.read.error', {
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
      this.log('warn', 'moments.parse.error', {
        path,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const shape = parsed as Partial<PersistedShape>;
    if (shape.version !== MOMENT_RECORD_VERSION) {
      this.log('warn', 'moments.version.mismatch', {
        path,
        found: shape.version ?? null,
        expected: MOMENT_RECORD_VERSION,
      });
      return;
    }
    const arr = Array.isArray(shape.moments) ? shape.moments : [];
    // Keep insertion order (Map preserves it). Truncate if the on-disk file
    // exceeds the configured cap — likely someone lowered max on redeploy.
    const toLoad = arr.slice(Math.max(0, arr.length - this.max));
    for (const rec of toLoad) {
      if (!rec || rec.version !== MOMENT_RECORD_VERSION || !rec.id) continue;
      this.byId.set(rec.id, rec);
      this.bySession.set(rec.sessionId, rec.id);
    }
    this.log('info', 'moments.loaded', { path, count: this.byId.size });
  }

  count(): number {
    return this.byId.size;
  }

  list(): MomentRecord[] {
    return [...this.byId.values()];
  }

  get(id: string): MomentRecord | null {
    return this.byId.get(id) ?? null;
  }

  getBySession(sessionId: string): MomentRecord | null {
    const id = this.bySession.get(sessionId);
    if (!id) return null;
    return this.byId.get(id) ?? null;
  }

  /**
   * Capture a conversation-close event. Returns the moment id (stable per
   * sessionId). Writes to disk fire-and-forget.
   */
  captureClose(input: CapturedClose, clock: WorldClock): MomentRecord {
    const existingId = this.bySession.get(input.sessionId);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing) return existing;
    }

    const id = this.idGenerator();
    const headline = buildMomentHeadline({
      participants: input.participants,
      zone: input.zone,
      transcriptLength: input.transcript.length,
      clock: { hour: clock.hour, minute: clock.minute },
    });
    const record: MomentRecord = {
      version: MOMENT_RECORD_VERSION,
      id,
      sessionId: input.sessionId,
      variant: 'conversation',
      headline,
      simTime: input.simTime,
      clock,
      capturedAt: this.now(),
      zone: input.zone,
      participants: input.participants,
      transcript: input.transcript,
      openedAt: input.openedAt,
      closedAt: input.simTime,
      closeReason: input.closeReason,
      reflection: null,
    };

    this.byId.set(id, record);
    this.bySession.set(input.sessionId, id);
    this.evictIfOver();
    this.scheduleFlush();
    return record;
  }

  /**
   * Capture a group co-presence moment (TINA-345). Returns the moment id,
   * stable per sessionId (same create-or-retrieve semantics as `captureClose`).
   * Writes to disk fire-and-forget.
   */
  captureGroup(input: CapturedGroup, clock: WorldClock): MomentRecord {
    const existingId = this.bySession.get(input.sessionId);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing) return existing;
    }

    const id = this.idGenerator();
    const headline = buildGroupMomentHeadline({
      participants: input.participants,
      zone: input.zone,
      clock: { hour: clock.hour, minute: clock.minute },
    });
    const record: MomentRecord = {
      version: MOMENT_RECORD_VERSION,
      id,
      sessionId: input.sessionId,
      variant: 'group',
      headline,
      simTime: input.simTime,
      clock,
      capturedAt: this.now(),
      zone: input.zone,
      participants: input.participants,
      transcript: [],
      openedAt: input.simTime,
      closedAt: input.simTime,
      closeReason: 'group',
      reflection: null,
    };

    this.byId.set(id, record);
    this.bySession.set(input.sessionId, id);
    this.evictIfOver();
    this.scheduleFlush();
    return record;
  }

  /**
   * Attach a reflection to the most recent moment whose participants include
   * this agent, provided it fired inside the configured window. Returns the
   * moment id it attached to, or null.
   *
   * Group-variant moments (TINA-345) are intentionally excluded: the
   * reflection-within-window heuristic works for a 1:1 close where one
   * participant's reflection is directly about that conversation, but it
   * would misattribute co-presence moments that happen to sit next to an
   * unrelated reflection on a wider-context day.
   */
  attachReflection(input: MomentReflection): string | null {
    let best: MomentRecord | null = null;
    for (const rec of this.byId.values()) {
      if (rec.variant === 'group') continue;
      if (!rec.participants.some((p) => p.id === input.agentId)) continue;
      const dt = input.simTime - rec.closedAt;
      if (dt < 0 || dt > this.reflectionWindowSim) continue;
      if (rec.reflection) continue;
      if (!best || rec.closedAt > best.closedAt) best = rec;
    }
    if (!best) return null;
    best.reflection = input;
    this.scheduleFlush();
    return best.id;
  }

  /** Force a synchronous flush. Useful in tests and on shutdown. */
  async flush(): Promise<void> {
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* already logged */
      }
    }
    if (!this.dirty) return;
    await this.write();
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (!this.dir) return;
    if (this.inFlight) return;
    // Fire-and-forget — the sim tick must never block on disk I/O.
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
    // Snapshot the set of moments we're about to persist so late mutations
    // during this write re-mark dirty for the next flush.
    this.dirty = false;
    const snapshot: PersistedShape = {
      version: MOMENT_RECORD_VERSION,
      moments: [...this.byId.values()],
    };
    const path = join(this.dir, MOMENT_FILE);
    const body = `${JSON.stringify(snapshot)}\n`;
    try {
      await this.writer(path, body);
    } catch (err) {
      // Mark dirty so the next captureClose/attachReflection retries the write.
      this.dirty = true;
      this.log('error', 'moments.write.error', {
        path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private evictIfOver(): void {
    if (this.byId.size <= this.max) return;
    const victims: string[] = [];
    const iter = this.byId.keys();
    const over = this.byId.size - this.max;
    for (let i = 0; i < over; i++) {
      const next = iter.next();
      if (next.done) break;
      victims.push(next.value);
    }
    for (const id of victims) {
      const rec = this.byId.get(id);
      this.byId.delete(id);
      if (rec && this.bySession.get(rec.sessionId) === id) {
        this.bySession.delete(rec.sessionId);
      }
    }
  }
}

/**
 * Helper that mirrors the `deriveWorldClock` signature for callers that only
 * have simTime + speed. Kept here so `server.ts` doesn't need to import both.
 */
export function momentClock(simTime: SimTime, speed: number): WorldClock {
  return deriveWorldClock(simTime, speed);
}
