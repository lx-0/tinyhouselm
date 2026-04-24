import { describe, expect, it } from 'vitest';
import { GroupMomentTracker } from './group-moments.js';

function zoneMap(entries: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(entries));
}

describe('GroupMomentTracker', () => {
  it('fires after minConsecutiveTicks with a stable ≥3 cohort', () => {
    const tracker = new GroupMomentTracker({ minConsecutiveTicks: 3 });
    for (let t = 0; t < 2; t++) {
      const fires = tracker.observe({
        tick: t,
        simTime: t * 1,
        byZone: zoneMap({ cafe: ['mei', 'hiro', 'ava'] }),
      });
      expect(fires).toEqual([]);
    }
    const fires = tracker.observe({
      tick: 2,
      simTime: 2,
      byZone: zoneMap({ cafe: ['mei', 'hiro', 'ava'] }),
    });
    expect(fires).toHaveLength(1);
    expect(fires[0]?.zone).toBe('cafe');
    expect(fires[0]?.participantIds).toEqual(['ava', 'hiro', 'mei']);
  });

  it('does not fire for cohorts smaller than minParticipants', () => {
    const tracker = new GroupMomentTracker({ minConsecutiveTicks: 1, minParticipants: 3 });
    const fires = tracker.observe({
      tick: 0,
      simTime: 0,
      byZone: zoneMap({ cafe: ['mei', 'hiro'] }),
    });
    expect(fires).toEqual([]);
  });

  it('resets the counter when the cohort changes', () => {
    const tracker = new GroupMomentTracker({ minConsecutiveTicks: 3 });
    // Two ticks with one set, then cohort changes.
    tracker.observe({ tick: 0, simTime: 0, byZone: zoneMap({ cafe: ['mei', 'hiro', 'ava'] }) });
    tracker.observe({ tick: 1, simTime: 1, byZone: zoneMap({ cafe: ['mei', 'hiro', 'ava'] }) });
    // Bruno swaps in for Ava → counter resets.
    const fires1 = tracker.observe({
      tick: 2,
      simTime: 2,
      byZone: zoneMap({ cafe: ['mei', 'hiro', 'bruno'] }),
    });
    expect(fires1).toEqual([]);
    // Need another 2 ticks of the new cohort before it fires.
    tracker.observe({ tick: 3, simTime: 3, byZone: zoneMap({ cafe: ['mei', 'hiro', 'bruno'] }) });
    const fires2 = tracker.observe({
      tick: 4,
      simTime: 4,
      byZone: zoneMap({ cafe: ['mei', 'hiro', 'bruno'] }),
    });
    expect(fires2).toHaveLength(1);
    expect(fires2[0]?.participantIds).toEqual(['bruno', 'hiro', 'mei']);
  });

  it('dedupes the same (zone, set) within a sim-day', () => {
    const tracker = new GroupMomentTracker({ minConsecutiveTicks: 2 });
    tracker.observe({ tick: 0, simTime: 100, byZone: zoneMap({ cafe: ['a', 'b', 'c'] }) });
    const first = tracker.observe({
      tick: 1,
      simTime: 200,
      byZone: zoneMap({ cafe: ['a', 'b', 'c'] }),
    });
    expect(first).toHaveLength(1);
    // Same cohort still present a tick later — must not re-fire.
    const again = tracker.observe({
      tick: 2,
      simTime: 300,
      byZone: zoneMap({ cafe: ['a', 'b', 'c'] }),
    });
    expect(again).toEqual([]);
  });

  it('re-fires across sim-day boundary when the cohort persists', () => {
    const tracker = new GroupMomentTracker({ minConsecutiveTicks: 2 });
    // Day 0
    tracker.observe({ tick: 0, simTime: 0, byZone: zoneMap({ park: ['a', 'b', 'c'] }) });
    const d0 = tracker.observe({
      tick: 1,
      simTime: 60,
      byZone: zoneMap({ park: ['a', 'b', 'c'] }),
    });
    expect(d0).toHaveLength(1);
    // Day 1 (86_400 sim-seconds later) — same stable cohort, new day → fires.
    // Cohort must still be stable for minConsecutiveTicks, which it is.
    const d1 = tracker.observe({
      tick: 2,
      simTime: 86_401,
      byZone: zoneMap({ park: ['a', 'b', 'c'] }),
    });
    expect(d1).toHaveLength(1);
    expect(d1[0]?.simDay).toBe(1);
  });

  it('clears cohort state when the zone empties', () => {
    const tracker = new GroupMomentTracker({ minConsecutiveTicks: 2 });
    tracker.observe({ tick: 0, simTime: 0, byZone: zoneMap({ cafe: ['a', 'b', 'c'] }) });
    tracker.observe({ tick: 1, simTime: 1, byZone: zoneMap({}) });
    expect(tracker.snapshot()).toEqual([]);
  });

  it('fires independently for multiple zones on the same tick', () => {
    const tracker = new GroupMomentTracker({ minConsecutiveTicks: 2 });
    tracker.observe({
      tick: 0,
      simTime: 0,
      byZone: zoneMap({ cafe: ['a', 'b', 'c'], park: ['d', 'e', 'f'] }),
    });
    const fires = tracker.observe({
      tick: 1,
      simTime: 1,
      byZone: zoneMap({ cafe: ['a', 'b', 'c'], park: ['d', 'e', 'f'] }),
    });
    expect(fires).toHaveLength(2);
    const zones = fires.map((f) => f.zone).sort();
    expect(zones).toEqual(['cafe', 'park']);
  });

  it('evicts oldest dedup entries past the cap', () => {
    const tracker = new GroupMomentTracker({
      minConsecutiveTicks: 1,
      maxDedupEntries: 2,
    });
    // Fire 3 distinct cohorts on 3 ticks.
    for (let i = 0; i < 3; i++) {
      tracker.observe({
        tick: i,
        simTime: i,
        byZone: zoneMap({ [`z${i}`]: ['a', 'b', 'c'] }),
      });
    }
    expect(tracker.dedupSize()).toBe(2);
  });

  it('treats unordered inputs as the same cohort (sorts internally)', () => {
    const tracker = new GroupMomentTracker({ minConsecutiveTicks: 2 });
    tracker.observe({ tick: 0, simTime: 0, byZone: zoneMap({ cafe: ['mei', 'hiro', 'ava'] }) });
    const fires = tracker.observe({
      tick: 1,
      simTime: 1,
      // Same participants, different order — must not reset.
      byZone: zoneMap({ cafe: ['ava', 'mei', 'hiro'] }),
    });
    expect(fires).toHaveLength(1);
  });
});
