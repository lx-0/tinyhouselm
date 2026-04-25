import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STICKY_METRICS_FILE = 'sticky-metrics.json';
export const STICKY_METRICS_TMP_SUFFIX = '.tmp';
export const STICKY_METRICS_VERSION = 1;

/**
 * Share-loop return-rate instrumentation (TINA-145).
 *
 * Tracks six counters with a 7-day daily rollup behind `/admin`:
 *   1. shares_created       — `/admin` Share clicks (one per successful mint).
 *   2. moment_unique_visits — unique visitors landing on `/moment/:id`,
 *                             deduped per-day by the `tvid` visitor cookie.
 *   3. returning_visits_24h — visitors whose first return-day happened
 *                             within 24h of their first-ever visit.
 *   4. returning_visits_7d  — same, within 7d. 24h ⊆ 7d by construction.
 *   5. nudges_applied       — viewer `/admin` nudges that actually got
 *                             consumed by a named×named close (TINA-275).
 *                             Counts the signal, not the submission, so
 *                             queued-but-never-consumed nudges are invisible.
 *   6. group_moments_created — 3+ named co-presence events detected by the
 *                             runtime and minted into the moment store
 *                             (TINA-345). One bump per fire, deduped per
 *                             (zone, participant-set) per sim-day upstream.
 *
 * Constraints (see TINA-145):
 *   - Counter bumps are synchronous; persistence is fire-and-forget
 *     (same lane as MomentStore, see sim_tick_network_io rule).
 *   - No raw IP storage — visitor identity is a random `tvid` cookie.
 *   - 7-day rollover: days older than the retention window get pruned.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_RETENTION_DAYS = 8; // 7 for the panel + today in-flight.
const DEFAULT_MAX_VISITORS = 50_000;
const DEFAULT_MAX_MOMENT_VISITORS_PER_DAY = 10_000;

export type StickyMetricsLogger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, unknown>,
) => void;

const noopLog: StickyMetricsLogger = () => {};

export interface StickyMetricsOptions {
  /**
   * Disk directory for the persisted metrics JSON. When undefined the store
   * runs in memory only (unit tests + dev).
   */
  dir?: string;
  /** How many days of rollup to retain. Default 8. */
  retentionDays?: number;
  /** Hard cap on the visitor table before eviction. Default 50,000. */
  maxVisitors?: number;
  /**
   * Per-day cap on moment-visitor-set cardinality. Past the cap we stop
   * adding to the set (the counter is floored at the cap). Default 10,000.
   */
  maxMomentVisitorsPerDay?: number;
  log?: StickyMetricsLogger;
  /** Wall-clock source (ms since epoch) — swappable in tests. */
  now?: () => number;
  /** Swap the writer for tests. */
  writer?: (path: string, body: string) => Promise<void>;
  /** Swap the reader for tests. */
  reader?: (path: string) => Promise<string | null>;
}

interface DayState {
  date: string;
  shares: number;
  momentVisitors: Set<string>;
  /** Counter floor once momentVisitors hits the cap — preserves tick accuracy. */
  momentExtraVisits: number;
  returns24h: number;
  returns7d: number;
  /** Viewer nudges consumed by a close this day (TINA-275). */
  nudgesApplied: number;
  /** 3+ named co-presence moments minted this day (TINA-345). */
  groupMomentsCreated: number;
  /** Affordance-object uses bumped this day (TINA-416). */
  affordanceUses: number;
  /**
   * Per-character-profile dedup sets (TINA-482). Keyed by lowercased
   * character id; each set holds visitor ids that already counted toward the
   * aggregate `characterProfileViews` counter for this day.
   */
  characterProfileVisitors: Map<string, Set<string>>;
  /** Floor counter once a per-name dedup set hits its cap. */
  characterProfileExtraViews: number;
  /**
   * Per-filter-key dedup sets for the /moments index page (TINA-544). Keyed
   * by the canonical filter string (e.g., `character=mei&variant=group`);
   * each set holds visitor ids that already counted toward the aggregate
   * `momentsIndexViews` counter for this day. The unfiltered index is keyed
   * as the empty string `''`.
   */
  momentsIndexVisitors: Map<string, Set<string>>;
  /** Floor counter once a per-filter-key dedup set hits its cap. */
  momentsIndexExtraViews: number;
  /**
   * Per-moment dedup sets for the OG image route (TINA-616). Keyed by
   * moment id; each set holds visitor ids (or raw IPs for crawler bots
   * that don't carry the cookie) that already counted toward the
   * aggregate `momentOgRenders` counter for this day. Past the per-id
   * cap the dedup set stops growing and the floor counter climbs.
   */
  momentOgVisitors: Map<string, Set<string>>;
  /** Floor counter once a per-moment dedup set hits its cap. */
  momentOgExtraRenders: number;
  /**
   * Per-digest-date dedup sets for `/digest/:date` page hits (TINA-684).
   * Keyed by canonical digest date (e.g. `sd-12`); each set holds visitor
   * ids (or raw IPs) that already counted toward `digestViews` this day.
   */
  digestVisitors: Map<string, Set<string>>;
  /** Floor counter once a per-date dedup set hits its cap. */
  digestExtraViews: number;
  /**
   * Per-digest-date dedup sets for `/digest/:date/og.png` renders (TINA-684).
   * Same shape as `momentOgVisitors` — most fetches are social-media
   * crawlers without the `tvid` cookie, so the caller passes IP fallback.
   */
  digestOgVisitors: Map<string, Set<string>>;
  /** Floor counter once a per-date dedup set hits its cap. */
  digestOgExtraRenders: number;
}

interface VisitorState {
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  /** Most recent day (UTC) on which this visitor was counted as a returner. */
  lastCountedReturnDay: string | null;
}

interface PersistedDay {
  date: string;
  shares: number;
  momentVisitors: string[];
  momentExtraVisits: number;
  returns24h: number;
  returns7d: number;
  /** Absent on payloads written before TINA-275; treated as 0 on load. */
  nudgesApplied?: number;
  /** Absent on payloads written before TINA-345; treated as 0 on load. */
  groupMomentsCreated?: number;
  /** Absent on payloads written before TINA-416; treated as 0 on load. */
  affordanceUses?: number;
  /** Absent on payloads written before TINA-482; loaded as empty + 0. */
  characterProfileVisitors?: Array<{ name: string; visitors: string[] }>;
  characterProfileExtraViews?: number;
  /** Absent on payloads written before TINA-544; loaded as empty + 0. */
  momentsIndexVisitors?: Array<{ key: string; visitors: string[] }>;
  momentsIndexExtraViews?: number;
  /** Absent on payloads written before TINA-616; loaded as empty + 0. */
  momentOgVisitors?: Array<{ id: string; visitors: string[] }>;
  momentOgExtraRenders?: number;
  /** Absent on payloads written before TINA-684; loaded as empty + 0. */
  digestVisitors?: Array<{ date: string; visitors: string[] }>;
  digestExtraViews?: number;
  /** Absent on payloads written before TINA-684; loaded as empty + 0. */
  digestOgVisitors?: Array<{ date: string; visitors: string[] }>;
  digestOgExtraRenders?: number;
}

interface PersistedVisitor {
  id: string;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  lastCountedReturnDay: string | null;
}

interface PersistedShape {
  version: number;
  days: PersistedDay[];
  visitors: PersistedVisitor[];
}

export interface DailyRollup {
  date: string;
  sharesCreated: number;
  momentUniqueVisits: number;
  returningVisits24h: number;
  returningVisits7d: number;
  nudgesApplied: number;
  groupMomentsCreated: number;
  /** Affordance-object uses bumped this day (TINA-416). */
  affordanceUses: number;
  /**
   * Per-character-profile views this day (TINA-482), deduped per (name,
   * visitor). Visiting two different /character pages from one IP counts
   * twice; visiting the same page twice counts once.
   */
  characterProfileViews: number;
  /**
   * `/moments` index views this day (TINA-544), deduped per (filter-key,
   * visitor). The unfiltered index and each distinct filter combination
   * count as separate buckets — refreshing the same view twice counts once.
   */
  momentsIndexViews: number;
  /**
   * `/moment/:id/og.png` renders this day (TINA-616), deduped per (moment,
   * IP-or-visitor). Mostly bumped by social-media crawlers — Twitterbot,
   * Slackbot, Discord, iMessage — but also counts genuine link previews.
   */
  momentOgRenders: number;
  /**
   * `/digest/:date` page hits this day (TINA-684), deduped per
   * (canonical-date, IP-or-visitor). The `today`/`yesterday` aliases
   * resolve to the canonical `sd-N` key before dedup so two clicks on
   * "today" only count once even across the alias resolution.
   */
  digestViews: number;
  /**
   * `/digest/:date/og.png` renders this day (TINA-684), same dedup shape
   * as `momentOgRenders`.
   */
  digestOgRenders: number;
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
  const tmp = `${path}${STICKY_METRICS_TMP_SUFFIX}`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Format a ms timestamp as a UTC YYYY-MM-DD day bucket. */
export function dayKeyUtc(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysUtc(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map((s) => Number.parseInt(s, 10));
  const ms = Date.UTC(y!, (m ?? 1) - 1, d!) + deltaDays * DAY_MS;
  return dayKeyUtc(ms);
}

export class StickyMetrics {
  private readonly dir: string | undefined;
  private readonly retentionDays: number;
  private readonly maxVisitors: number;
  private readonly maxMomentVisitorsPerDay: number;
  private readonly log: StickyMetricsLogger;
  private readonly now: () => number;
  private readonly writer: (path: string, body: string) => Promise<void>;
  private readonly reader: (path: string) => Promise<string | null>;

  private readonly days = new Map<string, DayState>();
  private readonly visitors = new Map<string, VisitorState>();

  private inFlight: Promise<void> | null = null;
  private dirty = false;

  constructor(opts: StickyMetricsOptions = {}) {
    this.dir = opts.dir;
    this.retentionDays = Math.max(1, Math.floor(opts.retentionDays ?? DEFAULT_RETENTION_DAYS));
    this.maxVisitors = Math.max(1, Math.floor(opts.maxVisitors ?? DEFAULT_MAX_VISITORS));
    this.maxMomentVisitorsPerDay = Math.max(
      1,
      Math.floor(opts.maxMomentVisitorsPerDay ?? DEFAULT_MAX_MOMENT_VISITORS_PER_DAY),
    );
    this.log = opts.log ?? noopLog;
    this.now = opts.now ?? (() => Date.now());
    this.writer = opts.writer ?? defaultWriter;
    this.reader = opts.reader ?? defaultReader;
  }

  /** Load state from disk. Safe to call on boot; no-op if dir is unset. */
  async load(): Promise<void> {
    if (!this.dir) return;
    const path = join(this.dir, STICKY_METRICS_FILE);
    let raw: string | null;
    try {
      raw = await this.reader(path);
    } catch (err) {
      this.log('warn', 'sticky.read.error', {
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
      this.log('warn', 'sticky.parse.error', {
        path,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const shape = parsed as Partial<PersistedShape>;
    if (shape.version !== STICKY_METRICS_VERSION) {
      this.log('warn', 'sticky.version.mismatch', {
        path,
        found: shape.version ?? null,
        expected: STICKY_METRICS_VERSION,
      });
      return;
    }
    for (const d of shape.days ?? []) {
      if (!d || typeof d.date !== 'string') continue;
      const charVisitors = new Map<string, Set<string>>();
      if (Array.isArray(d.characterProfileVisitors)) {
        for (const row of d.characterProfileVisitors) {
          if (!row || typeof row.name !== 'string') continue;
          const set = new Set<string>(Array.isArray(row.visitors) ? row.visitors : []);
          charVisitors.set(row.name, set);
        }
      }
      const momentsIndexVisitors = new Map<string, Set<string>>();
      if (Array.isArray(d.momentsIndexVisitors)) {
        for (const row of d.momentsIndexVisitors) {
          if (!row || typeof row.key !== 'string') continue;
          const set = new Set<string>(Array.isArray(row.visitors) ? row.visitors : []);
          momentsIndexVisitors.set(row.key, set);
        }
      }
      const momentOgVisitors = new Map<string, Set<string>>();
      if (Array.isArray(d.momentOgVisitors)) {
        for (const row of d.momentOgVisitors) {
          if (!row || typeof row.id !== 'string') continue;
          const set = new Set<string>(Array.isArray(row.visitors) ? row.visitors : []);
          momentOgVisitors.set(row.id, set);
        }
      }
      const digestVisitors = new Map<string, Set<string>>();
      if (Array.isArray(d.digestVisitors)) {
        for (const row of d.digestVisitors) {
          if (!row || typeof row.date !== 'string') continue;
          const set = new Set<string>(Array.isArray(row.visitors) ? row.visitors : []);
          digestVisitors.set(row.date, set);
        }
      }
      const digestOgVisitors = new Map<string, Set<string>>();
      if (Array.isArray(d.digestOgVisitors)) {
        for (const row of d.digestOgVisitors) {
          if (!row || typeof row.date !== 'string') continue;
          const set = new Set<string>(Array.isArray(row.visitors) ? row.visitors : []);
          digestOgVisitors.set(row.date, set);
        }
      }
      this.days.set(d.date, {
        date: d.date,
        shares: Number(d.shares) || 0,
        momentVisitors: new Set(Array.isArray(d.momentVisitors) ? d.momentVisitors : []),
        momentExtraVisits: Number(d.momentExtraVisits) || 0,
        returns24h: Number(d.returns24h) || 0,
        returns7d: Number(d.returns7d) || 0,
        nudgesApplied: Number(d.nudgesApplied) || 0,
        groupMomentsCreated: Number(d.groupMomentsCreated) || 0,
        affordanceUses: Number(d.affordanceUses) || 0,
        characterProfileVisitors: charVisitors,
        characterProfileExtraViews: Number(d.characterProfileExtraViews) || 0,
        momentsIndexVisitors,
        momentsIndexExtraViews: Number(d.momentsIndexExtraViews) || 0,
        momentOgVisitors,
        momentOgExtraRenders: Number(d.momentOgExtraRenders) || 0,
        digestVisitors,
        digestExtraViews: Number(d.digestExtraViews) || 0,
        digestOgVisitors,
        digestOgExtraRenders: Number(d.digestOgExtraRenders) || 0,
      });
    }
    for (const v of shape.visitors ?? []) {
      if (!v || typeof v.id !== 'string') continue;
      this.visitors.set(v.id, {
        firstSeenAtMs: Number(v.firstSeenAtMs) || 0,
        lastSeenAtMs: Number(v.lastSeenAtMs) || 0,
        lastCountedReturnDay:
          typeof v.lastCountedReturnDay === 'string' ? v.lastCountedReturnDay : null,
      });
    }
    this.pruneOld(dayKeyUtc(this.now()));
    this.log('info', 'sticky.loaded', {
      path,
      days: this.days.size,
      visitors: this.visitors.size,
    });
  }

  /** Number of retained days. */
  dayCount(): number {
    return this.days.size;
  }

  /** Number of retained visitors. */
  visitorCount(): number {
    return this.visitors.size;
  }

  /** Record a successful share mint. */
  recordShare(): void {
    const day = this.day(dayKeyUtc(this.now()));
    day.shares += 1;
    this.scheduleFlush();
  }

  /**
   * Record a viewer nudge that was actually consumed by a named×named close
   * (TINA-275). The counter intentionally tracks application, not queueing —
   * a nudge that never gets consumed (pair never closes before LRU eviction,
   * or the queued nudge is replaced) stays invisible.
   */
  recordNudge(): void {
    const day = this.day(dayKeyUtc(this.now()));
    day.nudgesApplied += 1;
    this.scheduleFlush();
  }

  /**
   * Record a minted group co-presence moment (TINA-345). Counts the fire at
   * the moment it reaches the moment store — upstream dedup already caps this
   * to one per (zone, participant-set) per sim-day.
   */
  recordGroupMoment(): void {
    const day = this.day(dayKeyUtc(this.now()));
    day.groupMomentsCreated += 1;
    this.scheduleFlush();
  }

  /**
   * Record a named character using a typed affordance object (TINA-416). The
   * runtime already dedupes rapid-fire uses per (agent, object) via its own
   * cooldown, so every call here is a real distinct "use" worth surfacing.
   */
  recordAffordanceUse(): void {
    const day = this.day(dayKeyUtc(this.now()));
    day.affordanceUses += 1;
    this.scheduleFlush();
  }

  /**
   * Record a hit on `/character/:name` (TINA-482). Deduped per (name,
   * visitor) per UTC day. Past the per-name cap the dedup set stops growing
   * but the floor counter still climbs so the rollup stays directionally
   * correct under sustained traffic.
   */
  recordCharacterProfileView(name: string, visitorId: string): void {
    if (!name) return;
    const key = name.toLowerCase();
    const day = this.day(dayKeyUtc(this.now()));
    let set = day.characterProfileVisitors.get(key);
    if (!set) {
      set = new Set<string>();
      day.characterProfileVisitors.set(key, set);
    }
    if (set.has(visitorId)) return;
    if (set.size < this.maxMomentVisitorsPerDay) {
      set.add(visitorId);
    } else {
      day.characterProfileExtraViews += 1;
    }
    this.scheduleFlush();
  }

  /**
   * Record a hit on `/digest/:date` (TINA-684). Deduped per
   * (canonical-date, visitor-or-IP) per UTC day. Pass the canonical key
   * (`sd-N`) — never the raw `today`/`yesterday` aliases — so dedup is
   * correct across alias resolution. Past the per-date cap the dedup set
   * stops growing and the floor counter climbs.
   */
  recordDigestView(canonicalDate: string, visitorOrIp: string): void {
    if (!canonicalDate || !visitorOrIp) return;
    const day = this.day(dayKeyUtc(this.now()));
    let set = day.digestVisitors.get(canonicalDate);
    if (!set) {
      set = new Set<string>();
      day.digestVisitors.set(canonicalDate, set);
    }
    if (set.has(visitorOrIp)) return;
    if (set.size < this.maxMomentVisitorsPerDay) {
      set.add(visitorOrIp);
    } else {
      day.digestExtraViews += 1;
    }
    this.scheduleFlush();
  }

  /**
   * Record a render of `/digest/:date/og.png` (TINA-684). Same dedup shape
   * as `recordMomentOgRender` — keyed on canonical sim-day + visitor/IP.
   */
  recordDigestOgRender(canonicalDate: string, visitorOrIp: string): void {
    if (!canonicalDate || !visitorOrIp) return;
    const day = this.day(dayKeyUtc(this.now()));
    let set = day.digestOgVisitors.get(canonicalDate);
    if (!set) {
      set = new Set<string>();
      day.digestOgVisitors.set(canonicalDate, set);
    }
    if (set.has(visitorOrIp)) return;
    if (set.size < this.maxMomentVisitorsPerDay) {
      set.add(visitorOrIp);
    } else {
      day.digestOgExtraRenders += 1;
    }
    this.scheduleFlush();
  }

  /**
   * Record a render of `/moment/:id/og.png` (TINA-616). Deduped per
   * (moment, visitor-or-IP) per UTC day. Most fetches are social-media
   * crawlers that don't carry our `tvid` cookie, so the caller passes a
   * stable identifier (visitor cookie when available, raw IP otherwise).
   * Past the per-id cap the dedup set stops growing and the floor counter
   * climbs, mirroring `recordCharacterProfileView`.
   */
  recordMomentOgRender(momentId: string, visitorOrIp: string): void {
    if (!momentId || !visitorOrIp) return;
    const day = this.day(dayKeyUtc(this.now()));
    let set = day.momentOgVisitors.get(momentId);
    if (!set) {
      set = new Set<string>();
      day.momentOgVisitors.set(momentId, set);
    }
    if (set.has(visitorOrIp)) return;
    if (set.size < this.maxMomentVisitorsPerDay) {
      set.add(visitorOrIp);
    } else {
      day.momentOgExtraRenders += 1;
    }
    this.scheduleFlush();
  }

  /**
   * Record a hit on `/moments` (TINA-544). Deduped per (filter-key,
   * visitor) per UTC day. The unfiltered index uses the empty string as
   * its key so it dedupes independently of any filtered combination. Past
   * the per-key cap the dedup set stops growing and the floor counter
   * climbs instead, mirroring `recordCharacterProfileView`.
   */
  recordMomentsIndexView(filterKey: string, visitorId: string): void {
    const day = this.day(dayKeyUtc(this.now()));
    let set = day.momentsIndexVisitors.get(filterKey);
    if (!set) {
      set = new Set<string>();
      day.momentsIndexVisitors.set(filterKey, set);
    }
    if (set.has(visitorId)) return;
    if (set.size < this.maxMomentVisitorsPerDay) {
      set.add(visitorId);
    } else {
      day.momentsIndexExtraViews += 1;
    }
    this.scheduleFlush();
  }

  /**
   * Record a visit to `/moment/:id`. Dedupes by visitor per-day up to the
   * configured cap; past the cap the counter still climbs so the 7-day
   * rollup stays directionally correct.
   */
  recordMomentVisit(visitorId: string): void {
    const nowMs = this.now();
    const today = dayKeyUtc(nowMs);
    this.markVisit(visitorId, nowMs, today);
    const day = this.day(today);
    if (day.momentVisitors.has(visitorId)) return;
    if (day.momentVisitors.size < this.maxMomentVisitorsPerDay) {
      day.momentVisitors.add(visitorId);
    } else {
      day.momentExtraVisits += 1;
    }
    this.scheduleFlush();
  }

  /**
   * Record a visit to the root (or any trackable page). Only used to
   * advance the visitor's lastSeenAt and count returns — the root page has
   * no per-day unique counter of its own in v0.5.
   */
  recordRootVisit(visitorId: string): void {
    const nowMs = this.now();
    const today = dayKeyUtc(nowMs);
    this.markVisit(visitorId, nowMs, today);
    this.scheduleFlush();
  }

  /** Returns a zero-filled 7-day rollup, newest date last. */
  rollup(days = 7): DailyRollup[] {
    const nowMs = this.now();
    const today = dayKeyUtc(nowMs);
    const out: DailyRollup[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = addDaysUtc(today, -i);
      const d = this.days.get(date);
      let charViews = d?.characterProfileExtraViews ?? 0;
      if (d) {
        for (const set of d.characterProfileVisitors.values()) charViews += set.size;
      }
      let momentsIndexViews = d?.momentsIndexExtraViews ?? 0;
      if (d) {
        for (const set of d.momentsIndexVisitors.values()) momentsIndexViews += set.size;
      }
      let momentOgRenders = d?.momentOgExtraRenders ?? 0;
      if (d) {
        for (const set of d.momentOgVisitors.values()) momentOgRenders += set.size;
      }
      let digestViews = d?.digestExtraViews ?? 0;
      if (d) {
        for (const set of d.digestVisitors.values()) digestViews += set.size;
      }
      let digestOgRenders = d?.digestOgExtraRenders ?? 0;
      if (d) {
        for (const set of d.digestOgVisitors.values()) digestOgRenders += set.size;
      }
      out.push({
        date,
        sharesCreated: d?.shares ?? 0,
        momentUniqueVisits: d ? d.momentVisitors.size + d.momentExtraVisits : 0,
        returningVisits24h: d?.returns24h ?? 0,
        returningVisits7d: d?.returns7d ?? 0,
        nudgesApplied: d?.nudgesApplied ?? 0,
        groupMomentsCreated: d?.groupMomentsCreated ?? 0,
        affordanceUses: d?.affordanceUses ?? 0,
        characterProfileViews: charViews,
        momentsIndexViews,
        momentOgRenders,
        digestViews,
        digestOgRenders,
      });
    }
    return out;
  }

  /** Force a synchronous flush. Useful on shutdown. */
  async flush(): Promise<void> {
    // Drain the fire-and-forget chain: each completed write may have
    // retriggered another via the scheduleFlush finally-hook, so loop
    // until we observe an idle, non-dirty state.
    while (this.inFlight || this.dirty) {
      if (this.inFlight) {
        try {
          await this.inFlight;
        } catch {
          /* already logged */
        }
        continue;
      }
      await this.write();
    }
  }

  private day(date: string): DayState {
    let d = this.days.get(date);
    if (!d) {
      d = {
        date,
        shares: 0,
        momentVisitors: new Set(),
        momentExtraVisits: 0,
        returns24h: 0,
        returns7d: 0,
        nudgesApplied: 0,
        groupMomentsCreated: 0,
        affordanceUses: 0,
        characterProfileVisitors: new Map(),
        characterProfileExtraViews: 0,
        momentsIndexVisitors: new Map(),
        momentsIndexExtraViews: 0,
        momentOgVisitors: new Map(),
        momentOgExtraRenders: 0,
        digestVisitors: new Map(),
        digestExtraViews: 0,
        digestOgVisitors: new Map(),
        digestOgExtraRenders: 0,
      };
      this.days.set(date, d);
      this.pruneOld(date);
    }
    return d;
  }

  private markVisit(visitorId: string, nowMs: number, today: string): void {
    const existing = this.visitors.get(visitorId);
    if (!existing) {
      this.visitors.set(visitorId, {
        firstSeenAtMs: nowMs,
        lastSeenAtMs: nowMs,
        lastCountedReturnDay: null,
      });
      this.evictVisitorsIfOver();
      return;
    }
    const firstDay = dayKeyUtc(existing.firstSeenAtMs);
    // A "return" is the first visit on a later UTC day than the first-ever
    // visit, counted at most once per calendar day per visitor.
    const isNewDayForVisitor = today !== existing.lastCountedReturnDay;
    const isAfterFirstDay = today > firstDay;
    if (isNewDayForVisitor && isAfterFirstDay) {
      const day = this.day(today);
      const deltaMs = nowMs - existing.firstSeenAtMs;
      if (deltaMs <= 7 * DAY_MS) day.returns7d += 1;
      if (deltaMs <= DAY_MS) day.returns24h += 1;
      existing.lastCountedReturnDay = today;
    }
    existing.lastSeenAtMs = nowMs;
  }

  private pruneOld(today: string): void {
    const cutoff = addDaysUtc(today, -(this.retentionDays - 1));
    for (const date of [...this.days.keys()]) {
      if (date < cutoff) this.days.delete(date);
    }
    for (const [id, v] of this.visitors) {
      const lastDay = dayKeyUtc(v.lastSeenAtMs);
      if (lastDay < cutoff) this.visitors.delete(id);
    }
  }

  private evictVisitorsIfOver(): void {
    if (this.visitors.size <= this.maxVisitors) return;
    const victims: string[] = [];
    const iter = this.visitors.keys();
    const over = this.visitors.size - this.maxVisitors;
    // Oldest-by-insertion wins eviction — matches MomentStore semantics.
    for (let i = 0; i < over; i++) {
      const next = iter.next();
      if (next.done) break;
      victims.push(next.value);
    }
    for (const id of victims) this.visitors.delete(id);
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (!this.dir) return;
    if (this.inFlight) return;
    // Fire-and-forget — counter bumps must never block a request.
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
      version: STICKY_METRICS_VERSION,
      days: [...this.days.values()].map((d) => ({
        date: d.date,
        shares: d.shares,
        momentVisitors: [...d.momentVisitors],
        momentExtraVisits: d.momentExtraVisits,
        returns24h: d.returns24h,
        returns7d: d.returns7d,
        nudgesApplied: d.nudgesApplied,
        groupMomentsCreated: d.groupMomentsCreated,
        affordanceUses: d.affordanceUses,
        characterProfileVisitors: [...d.characterProfileVisitors.entries()].map(([name, set]) => ({
          name,
          visitors: [...set],
        })),
        characterProfileExtraViews: d.characterProfileExtraViews,
        momentsIndexVisitors: [...d.momentsIndexVisitors.entries()].map(([key, set]) => ({
          key,
          visitors: [...set],
        })),
        momentsIndexExtraViews: d.momentsIndexExtraViews,
        momentOgVisitors: [...d.momentOgVisitors.entries()].map(([id, set]) => ({
          id,
          visitors: [...set],
        })),
        momentOgExtraRenders: d.momentOgExtraRenders,
        digestVisitors: [...d.digestVisitors.entries()].map(([date, set]) => ({
          date,
          visitors: [...set],
        })),
        digestExtraViews: d.digestExtraViews,
        digestOgVisitors: [...d.digestOgVisitors.entries()].map(([date, set]) => ({
          date,
          visitors: [...set],
        })),
        digestOgExtraRenders: d.digestOgExtraRenders,
      })),
      visitors: [...this.visitors.entries()].map(([id, v]) => ({
        id,
        firstSeenAtMs: v.firstSeenAtMs,
        lastSeenAtMs: v.lastSeenAtMs,
        lastCountedReturnDay: v.lastCountedReturnDay,
      })),
    };
    const path = join(this.dir, STICKY_METRICS_FILE);
    const body = `${JSON.stringify(snapshot)}\n`;
    try {
      await this.writer(path, body);
    } catch (err) {
      this.dirty = true;
      this.log('error', 'sticky.write.error', {
        path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const VISITOR_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 16-char url-safe visitor id (~95 bits — collision-resistant per visitor). */
export function generateVisitorId(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += VISITOR_ID_ALPHABET[Math.floor(rand() * VISITOR_ID_ALPHABET.length)]!;
  }
  return out;
}

const COOKIE_NAME = 'tvid';
const COOKIE_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Parse the `tvid` visitor cookie from a raw cookie header. */
export function parseVisitorCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const raw of cookieHeader.split(';')) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const name = raw.slice(0, eq).trim();
    if (name !== COOKIE_NAME) continue;
    const value = raw.slice(eq + 1).trim();
    return COOKIE_RE.test(value) ? value : null;
  }
  return null;
}

/** Build a `Set-Cookie` header that stamps a 1-year `tvid`. */
export function buildVisitorSetCookie(id: string): string {
  const maxAge = 60 * 60 * 24 * 365; // 1 year
  return `${COOKIE_NAME}=${id}; Max-Age=${maxAge}; Path=/; SameSite=Lax; HttpOnly`;
}
