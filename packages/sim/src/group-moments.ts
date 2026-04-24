import type { SimTime } from '@tina/shared';

/**
 * Multi-character group co-presence tracker (TINA-345).
 *
 * The tick loop feeds us a per-zone roster of named agents every tick. We
 * hold each zone's current cohort (sorted participant ids) across ticks,
 * reset the counter whenever the set changes, and fire once the stable set
 * of ≥N named participants has been co-present for `minConsecutiveTicks`.
 *
 * Dedup is keyed on `(zone, sortedIds, simDay)` so the same group can fire
 * again on a later sim-day but not twice in the same day. The dedup map is
 * bounded (oldest-insertion wins eviction) so a pathological set of groups
 * can't leak memory.
 *
 * Design constraints (inherited from TINA-21 / TINA-29):
 *   - No network I/O, no disk I/O — everything is in-memory.
 *   - No LLM on the hot path — `observe` returns candidates deterministically.
 *   - Bounded memory: zone state + dedup map have explicit caps.
 */

const DEFAULT_MIN_PARTICIPANTS = 3;
const DEFAULT_MIN_CONSECUTIVE_TICKS = 3;
const DEFAULT_MAX_DEDUP_ENTRIES = 512;
const SECONDS_PER_DAY = 86_400;

export interface GroupMomentOptions {
  /** Minimum cohort size to qualify as a "group". Default 3. */
  minParticipants?: number;
  /**
   * The stable cohort must be co-present for at least this many consecutive
   * ticks before a moment fires. Default 3 — at TICK_MS=200 and SIM_SPEED=30
   * that's ~18 sim-seconds, enough to filter pure flyby overlap.
   */
  minConsecutiveTicks?: number;
  /** LRU cap on the per-day dedup map. Default 512. */
  maxDedupEntries?: number;
}

export interface GroupMomentCandidate {
  zone: string;
  /** Sorted participant ids (deterministic). */
  participantIds: string[];
  simTime: SimTime;
  /** `Math.floor(simTime / 86400)` at the time of the fire. */
  simDay: number;
}

export interface ObserveInput {
  tick: number;
  simTime: SimTime;
  /** Map of zone → named agent ids standing in that zone this tick. */
  byZone: Map<string, string[]>;
}

interface ZoneCohort {
  signature: string;
  /**
   * The exact sorted participant ids the signature was built from. We keep
   * this so we don't re-sort on every observe call.
   */
  participantIds: string[];
  firstTick: number;
  /** Whether we've already fired for this stable cohort on this sim-day. */
  firedToday: boolean;
  firedDay: number | null;
}

export class GroupMomentTracker {
  private readonly minParticipants: number;
  private readonly minConsecutiveTicks: number;
  private readonly maxDedupEntries: number;
  private readonly zones = new Map<string, ZoneCohort>();
  /** Dedup keys in insertion order; evict oldest when over cap. */
  private readonly dedup = new Map<string, true>();

  constructor(opts: GroupMomentOptions = {}) {
    this.minParticipants = Math.max(
      2,
      Math.floor(opts.minParticipants ?? DEFAULT_MIN_PARTICIPANTS),
    );
    this.minConsecutiveTicks = Math.max(
      1,
      Math.floor(opts.minConsecutiveTicks ?? DEFAULT_MIN_CONSECUTIVE_TICKS),
    );
    this.maxDedupEntries = Math.max(
      1,
      Math.floor(opts.maxDedupEntries ?? DEFAULT_MAX_DEDUP_ENTRIES),
    );
  }

  /**
   * Observe this tick's zone occupancy. Returns any groups that crossed the
   * consecutive-tick threshold this tick AND haven't been emitted for the
   * same (zone, set) earlier today. Call exactly once per tick.
   */
  observe(input: ObserveInput): GroupMomentCandidate[] {
    const fires: GroupMomentCandidate[] = [];
    const simDay = Math.floor(input.simTime / SECONDS_PER_DAY);

    // Clean cohorts for zones no longer populated enough to qualify.
    for (const zone of [...this.zones.keys()]) {
      const ids = input.byZone.get(zone) ?? [];
      if (ids.length < this.minParticipants) this.zones.delete(zone);
    }

    for (const [zone, rawIds] of input.byZone) {
      if (rawIds.length < this.minParticipants) continue;
      const sorted = [...rawIds].sort();
      const signature = sorted.join(',');
      let cohort = this.zones.get(zone);
      if (!cohort || cohort.signature !== signature) {
        // Cohort changed (or first time we saw one here) — reset the counter.
        cohort = {
          signature,
          participantIds: sorted,
          firstTick: input.tick,
          firedToday: false,
          firedDay: null,
        };
        this.zones.set(zone, cohort);
      }
      const consecutive = input.tick - cohort.firstTick + 1;
      if (consecutive < this.minConsecutiveTicks) continue;
      if (cohort.firedToday && cohort.firedDay === simDay) continue;
      const key = `${zone}::${signature}::day-${simDay}`;
      if (this.dedup.has(key)) {
        cohort.firedToday = true;
        cohort.firedDay = simDay;
        continue;
      }
      this.dedup.set(key, true);
      this.evictDedupIfOver();
      cohort.firedToday = true;
      cohort.firedDay = simDay;
      fires.push({
        zone,
        participantIds: [...sorted],
        simTime: input.simTime,
        simDay,
      });
    }

    return fires;
  }

  /** Active cohort signatures keyed by zone — observable for tests. */
  snapshot(): Array<{ zone: string; signature: string; firstTick: number }> {
    return [...this.zones.entries()].map(([zone, c]) => ({
      zone,
      signature: c.signature,
      firstTick: c.firstTick,
    }));
  }

  dedupSize(): number {
    return this.dedup.size;
  }

  private evictDedupIfOver(): void {
    if (this.dedup.size <= this.maxDedupEntries) return;
    const over = this.dedup.size - this.maxDedupEntries;
    const iter = this.dedup.keys();
    for (let i = 0; i < over; i++) {
      const next = iter.next();
      if (next.done) break;
      this.dedup.delete(next.value);
    }
  }
}
