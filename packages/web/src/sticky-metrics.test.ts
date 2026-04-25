import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  STICKY_METRICS_FILE,
  StickyMetrics,
  buildVisitorSetCookie,
  dayKeyUtc,
  generateVisitorId,
  parseVisitorCookie,
} from './sticky-metrics.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function clockAt(iso: string): () => number {
  const fixed = Date.parse(iso);
  return () => fixed;
}

function clockFromRef(ref: { ms: number }): () => number {
  return () => ref.ms;
}

describe('dayKeyUtc', () => {
  test('formats in UTC', () => {
    expect(dayKeyUtc(Date.parse('2026-04-23T23:59:00Z'))).toBe('2026-04-23');
    expect(dayKeyUtc(Date.parse('2026-04-24T00:00:00Z'))).toBe('2026-04-24');
  });
});

describe('StickyMetrics.recordShare', () => {
  test('bumps today bucket', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-23T10:00:00Z') });
    m.recordShare();
    m.recordShare();
    const r = m.rollup(7);
    expect(r.at(-1)).toEqual({
      date: '2026-04-23',
      sharesCreated: 2,
      momentUniqueVisits: 0,
      returningVisits24h: 0,
      returningVisits7d: 0,
      nudgesApplied: 0,
      groupMomentsCreated: 0,
      affordanceUses: 0,
      characterProfileViews: 0,
      momentsIndexViews: 0,
      momentOgRenders: 0,
    });
    expect(r[0]!.date).toBe('2026-04-17');
  });
});

describe('StickyMetrics.recordMomentVisit', () => {
  test('dedupes by visitor id per-day', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-23T10:00:00Z') });
    m.recordMomentVisit('alice');
    m.recordMomentVisit('alice');
    m.recordMomentVisit('bob');
    const today = m.rollup(7).at(-1)!;
    expect(today.momentUniqueVisits).toBe(2);
  });

  test('caps the dedup set and counts overflow as extras', () => {
    const m = new StickyMetrics({
      now: clockAt('2026-04-23T10:00:00Z'),
      maxMomentVisitorsPerDay: 2,
    });
    m.recordMomentVisit('a');
    m.recordMomentVisit('b');
    // Beyond the cap: counter bumps, dedup set stays capped.
    m.recordMomentVisit('c');
    m.recordMomentVisit('d');
    expect(m.rollup(7).at(-1)!.momentUniqueVisits).toBe(4);
  });
});

describe('StickyMetrics return detection', () => {
  test('first visit is not a return', () => {
    const ref = { ms: Date.parse('2026-04-23T10:00:00Z') };
    const m = new StickyMetrics({ now: clockFromRef(ref) });
    m.recordRootVisit('alice');
    const today = m.rollup(7).at(-1)!;
    expect(today.returningVisits24h).toBe(0);
    expect(today.returningVisits7d).toBe(0);
  });

  test('same-day repeat does not count as return', () => {
    const ref = { ms: Date.parse('2026-04-23T10:00:00Z') };
    const m = new StickyMetrics({ now: clockFromRef(ref) });
    m.recordRootVisit('alice');
    ref.ms += 2 * 60 * 60 * 1000; // +2h same UTC day
    m.recordRootVisit('alice');
    expect(m.rollup(7).at(-1)!.returningVisits24h).toBe(0);
  });

  test('next-day return within 24h counts in both 24h and 7d', () => {
    const ref = { ms: Date.parse('2026-04-22T23:30:00Z') };
    const m = new StickyMetrics({ now: clockFromRef(ref) });
    m.recordRootVisit('alice');
    // 1h later, new UTC day, still within 24h of first visit.
    ref.ms += 1 * 60 * 60 * 1000;
    m.recordRootVisit('alice');
    const today = m.rollup(7).at(-1)!;
    expect(today.date).toBe('2026-04-23');
    expect(today.returningVisits24h).toBe(1);
    expect(today.returningVisits7d).toBe(1);
  });

  test('return after 3 days counts in 7d only', () => {
    const ref = { ms: Date.parse('2026-04-20T10:00:00Z') };
    const m = new StickyMetrics({ now: clockFromRef(ref) });
    m.recordRootVisit('alice');
    ref.ms += 3 * DAY_MS;
    m.recordRootVisit('alice');
    const today = m.rollup(7).at(-1)!;
    expect(today.returningVisits24h).toBe(0);
    expect(today.returningVisits7d).toBe(1);
  });

  test('return after 8 days counts in neither', () => {
    const ref = { ms: Date.parse('2026-04-15T10:00:00Z') };
    const m = new StickyMetrics({ now: clockFromRef(ref), retentionDays: 30 });
    m.recordRootVisit('alice');
    ref.ms += 8 * DAY_MS;
    m.recordRootVisit('alice');
    const today = m.rollup(7).at(-1)!;
    expect(today.returningVisits24h).toBe(0);
    expect(today.returningVisits7d).toBe(0);
  });

  test('same visitor counted at most once per return-day', () => {
    const ref = { ms: Date.parse('2026-04-22T10:00:00Z') };
    const m = new StickyMetrics({ now: clockFromRef(ref) });
    m.recordRootVisit('alice');
    ref.ms += 1 * DAY_MS; // next-day morning
    m.recordRootVisit('alice');
    m.recordMomentVisit('alice'); // second hit same day — no double count
    m.recordRootVisit('alice');
    expect(m.rollup(7).at(-1)!.returningVisits24h).toBe(1);
  });

  test('distinct visitors aggregate', () => {
    const ref = { ms: Date.parse('2026-04-22T10:00:00Z') };
    const m = new StickyMetrics({ now: clockFromRef(ref) });
    m.recordRootVisit('alice');
    m.recordRootVisit('bob');
    m.recordMomentVisit('carol');
    ref.ms += 1 * DAY_MS;
    m.recordRootVisit('alice');
    m.recordMomentVisit('bob');
    m.recordRootVisit('carol');
    const today = m.rollup(7).at(-1)!;
    expect(today.returningVisits24h).toBe(3);
    expect(today.returningVisits7d).toBe(3);
    expect(today.momentUniqueVisits).toBe(1); // only bob hit /moment today
  });
});

describe('StickyMetrics.rollup', () => {
  test('returns 7 days zero-filled, newest last', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-23T10:00:00Z') });
    m.recordShare();
    const r = m.rollup(7);
    expect(r.length).toBe(7);
    expect(r[0]!.date).toBe('2026-04-17');
    expect(r[6]!.date).toBe('2026-04-23');
    expect(r[6]!.sharesCreated).toBe(1);
    expect(r[0]!.sharesCreated).toBe(0);
  });
});

describe('StickyMetrics.recordNudge (TINA-275)', () => {
  test('bumps today bucket and appears in rollup', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-23T10:00:00Z') });
    m.recordNudge();
    m.recordNudge();
    m.recordNudge();
    expect(m.rollup(7).at(-1)!.nudgesApplied).toBe(3);
    expect(m.rollup(7).at(0)!.nudgesApplied).toBe(0);
  });

  test('persists across a load-write-load cycle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-nudge-'));
    const ref = { ms: Date.parse('2026-04-23T10:00:00Z') };
    const m1 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m1.load();
    m1.recordNudge();
    m1.recordNudge();
    await m1.flush();

    const m2 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m2.load();
    expect(m2.rollup(7).at(-1)!.nudgesApplied).toBe(2);
  });

  test('pre-TINA-275 persisted shape (no nudgesApplied field) loads as 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-legacy-'));
    const legacy = {
      version: 1,
      days: [
        {
          date: '2026-04-23',
          shares: 7,
          momentVisitors: ['a'],
          momentExtraVisits: 0,
          returns24h: 0,
          returns7d: 0,
        },
      ],
      visitors: [],
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, STICKY_METRICS_FILE), `${JSON.stringify(legacy)}\n`, 'utf8');
    const m = new StickyMetrics({ dir, now: clockAt('2026-04-23T10:00:00Z') });
    await m.load();
    const today = m.rollup(7).at(-1)!;
    expect(today.sharesCreated).toBe(7);
    expect(today.nudgesApplied).toBe(0);
  });
});

describe('StickyMetrics.recordGroupMoment (TINA-345)', () => {
  test('bumps today bucket and appears in rollup', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-24T10:00:00Z') });
    m.recordGroupMoment();
    m.recordGroupMoment();
    expect(m.rollup(7).at(-1)!.groupMomentsCreated).toBe(2);
    expect(m.rollup(7).at(0)!.groupMomentsCreated).toBe(0);
  });

  test('persists across a load-write-load cycle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-grp-'));
    const ref = { ms: Date.parse('2026-04-24T10:00:00Z') };
    const m1 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m1.load();
    m1.recordGroupMoment();
    m1.recordGroupMoment();
    m1.recordGroupMoment();
    await m1.flush();

    const m2 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m2.load();
    expect(m2.rollup(7).at(-1)!.groupMomentsCreated).toBe(3);
  });

  test('pre-TINA-345 persisted shape (no groupMomentsCreated field) loads as 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-legacy-grp-'));
    const legacy = {
      version: 1,
      days: [
        {
          date: '2026-04-24',
          shares: 2,
          momentVisitors: [],
          momentExtraVisits: 0,
          returns24h: 0,
          returns7d: 0,
          nudgesApplied: 1,
        },
      ],
      visitors: [],
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, STICKY_METRICS_FILE), `${JSON.stringify(legacy)}\n`, 'utf8');
    const m = new StickyMetrics({ dir, now: clockAt('2026-04-24T10:00:00Z') });
    await m.load();
    const today = m.rollup(7).at(-1)!;
    expect(today.sharesCreated).toBe(2);
    expect(today.nudgesApplied).toBe(1);
    expect(today.groupMomentsCreated).toBe(0);
  });
});

describe('StickyMetrics.recordAffordanceUse (TINA-416)', () => {
  test('bumps today bucket and rolls forward', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-24T10:00:00Z') });
    m.recordAffordanceUse();
    m.recordAffordanceUse();
    m.recordAffordanceUse();
    expect(m.rollup(7).at(-1)!.affordanceUses).toBe(3);
    expect(m.rollup(7).at(0)!.affordanceUses).toBe(0);
  });

  test('persists across a load-write-load cycle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-aff-'));
    const ref = { ms: Date.parse('2026-04-24T10:00:00Z') };
    const m1 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m1.load();
    m1.recordAffordanceUse();
    m1.recordAffordanceUse();
    await m1.flush();

    const m2 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m2.load();
    expect(m2.rollup(7).at(-1)!.affordanceUses).toBe(2);
  });

  test('pre-TINA-416 persisted shape (no affordanceUses field) loads as 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-legacy-aff-'));
    const legacy = {
      version: 1,
      days: [
        {
          date: '2026-04-24',
          shares: 2,
          momentVisitors: [],
          momentExtraVisits: 0,
          returns24h: 0,
          returns7d: 0,
          nudgesApplied: 0,
          groupMomentsCreated: 1,
        },
      ],
      visitors: [],
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, STICKY_METRICS_FILE), `${JSON.stringify(legacy)}\n`, 'utf8');
    const m = new StickyMetrics({ dir, now: clockAt('2026-04-24T10:00:00Z') });
    await m.load();
    const today = m.rollup(7).at(-1)!;
    expect(today.sharesCreated).toBe(2);
    expect(today.groupMomentsCreated).toBe(1);
    expect(today.affordanceUses).toBe(0);
  });
});

describe('StickyMetrics.recordCharacterProfileView (TINA-482)', () => {
  test('aggregates per-name dedup into one rollup counter', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-25T10:00:00Z') });
    m.recordCharacterProfileView('mei-tanaka', 'alice');
    m.recordCharacterProfileView('mei-tanaka', 'alice'); // dedup — same visitor, same name
    m.recordCharacterProfileView('mei-tanaka', 'bob');
    m.recordCharacterProfileView('hiro-abe', 'alice'); // alice on a different page counts
    expect(m.rollup(7).at(-1)!.characterProfileViews).toBe(3);
  });

  test('per-IP per-name dedup is case-insensitive on the name', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-25T10:00:00Z') });
    m.recordCharacterProfileView('Mei-Tanaka', 'alice');
    m.recordCharacterProfileView('mei-tanaka', 'alice'); // same dedup bucket
    m.recordCharacterProfileView('MEI-TANAKA', 'alice');
    expect(m.rollup(7).at(-1)!.characterProfileViews).toBe(1);
  });

  test('caps the per-name dedup set and floors overflow', () => {
    const m = new StickyMetrics({
      now: clockAt('2026-04-25T10:00:00Z'),
      maxMomentVisitorsPerDay: 2,
    });
    m.recordCharacterProfileView('mei-tanaka', 'a');
    m.recordCharacterProfileView('mei-tanaka', 'b');
    m.recordCharacterProfileView('mei-tanaka', 'c'); // floors
    m.recordCharacterProfileView('mei-tanaka', 'd');
    expect(m.rollup(7).at(-1)!.characterProfileViews).toBe(4);
  });

  test('persists across a load-write-load cycle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-char-'));
    const ref = { ms: Date.parse('2026-04-25T10:00:00Z') };
    const m1 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m1.load();
    m1.recordCharacterProfileView('mei-tanaka', 'alice');
    m1.recordCharacterProfileView('mei-tanaka', 'bob');
    m1.recordCharacterProfileView('hiro-abe', 'alice');
    await m1.flush();

    const m2 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m2.load();
    expect(m2.rollup(7).at(-1)!.characterProfileViews).toBe(3);
    // Re-asserting the same (name, visitor) tuple after reload still dedupes.
    m2.recordCharacterProfileView('mei-tanaka', 'alice');
    expect(m2.rollup(7).at(-1)!.characterProfileViews).toBe(3);
  });

  test('pre-TINA-482 persisted shape (no characterProfileVisitors) loads as 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-legacy-char-'));
    const legacy = {
      version: 1,
      days: [
        {
          date: '2026-04-25',
          shares: 1,
          momentVisitors: [],
          momentExtraVisits: 0,
          returns24h: 0,
          returns7d: 0,
          nudgesApplied: 0,
          groupMomentsCreated: 0,
          affordanceUses: 5,
        },
      ],
      visitors: [],
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, STICKY_METRICS_FILE), `${JSON.stringify(legacy)}\n`, 'utf8');
    const m = new StickyMetrics({ dir, now: clockAt('2026-04-25T10:00:00Z') });
    await m.load();
    const today = m.rollup(7).at(-1)!;
    expect(today.affordanceUses).toBe(5);
    expect(today.characterProfileViews).toBe(0);
  });
});

describe('StickyMetrics.recordMomentsIndexView (TINA-544)', () => {
  test('aggregates per-filter-key dedup into one rollup counter', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-25T10:00:00Z') });
    m.recordMomentsIndexView('', 'alice');
    m.recordMomentsIndexView('', 'alice'); // dedup — same visitor + same key
    m.recordMomentsIndexView('', 'bob');
    m.recordMomentsIndexView('character=mei', 'alice'); // different filter, alice counts
    m.recordMomentsIndexView('character=mei', 'alice'); // dedup again
    expect(m.rollup(7).at(-1)!.momentsIndexViews).toBe(3);
  });

  test('unfiltered and filtered keys dedupe independently', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-25T10:00:00Z') });
    m.recordMomentsIndexView('', 'alice');
    m.recordMomentsIndexView('zone=cafe', 'alice');
    m.recordMomentsIndexView('zone=park', 'alice');
    expect(m.rollup(7).at(-1)!.momentsIndexViews).toBe(3);
  });

  test('caps the per-key dedup set and floors overflow', () => {
    const m = new StickyMetrics({
      now: clockAt('2026-04-25T10:00:00Z'),
      maxMomentVisitorsPerDay: 2,
    });
    m.recordMomentsIndexView('', 'a');
    m.recordMomentsIndexView('', 'b');
    m.recordMomentsIndexView('', 'c'); // floors
    m.recordMomentsIndexView('', 'd');
    expect(m.rollup(7).at(-1)!.momentsIndexViews).toBe(4);
  });

  test('persists across a load-write-load cycle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-mi-'));
    const ref = { ms: Date.parse('2026-04-25T10:00:00Z') };
    const m1 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m1.load();
    m1.recordMomentsIndexView('', 'alice');
    m1.recordMomentsIndexView('character=mei', 'alice');
    m1.recordMomentsIndexView('character=mei', 'bob');
    await m1.flush();

    const m2 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m2.load();
    expect(m2.rollup(7).at(-1)!.momentsIndexViews).toBe(3);
    // Re-asserting the same (key, visitor) tuple after reload still dedupes.
    m2.recordMomentsIndexView('character=mei', 'alice');
    expect(m2.rollup(7).at(-1)!.momentsIndexViews).toBe(3);
  });

  test('pre-TINA-544 persisted shape (no momentsIndexVisitors) loads as 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-legacy-mi-'));
    const legacy = {
      version: 1,
      days: [
        {
          date: '2026-04-25',
          shares: 1,
          momentVisitors: [],
          momentExtraVisits: 0,
          returns24h: 0,
          returns7d: 0,
          nudgesApplied: 0,
          groupMomentsCreated: 0,
          affordanceUses: 5,
          characterProfileVisitors: [{ name: 'mei-tanaka', visitors: ['alice'] }],
          characterProfileExtraViews: 0,
        },
      ],
      visitors: [],
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, STICKY_METRICS_FILE), `${JSON.stringify(legacy)}\n`, 'utf8');
    const m = new StickyMetrics({ dir, now: clockAt('2026-04-25T10:00:00Z') });
    await m.load();
    const today = m.rollup(7).at(-1)!;
    expect(today.characterProfileViews).toBe(1);
    expect(today.momentsIndexViews).toBe(0);
  });
});

describe('StickyMetrics.recordMomentOgRender (TINA-616)', () => {
  test('aggregates per-moment dedup into one rollup counter', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-25T10:00:00Z') });
    m.recordMomentOgRender('mom1', 'twitterbot');
    m.recordMomentOgRender('mom1', 'twitterbot'); // dedup
    m.recordMomentOgRender('mom1', 'slackbot');
    m.recordMomentOgRender('mom2', 'twitterbot'); // different moment, twitterbot counts
    expect(m.rollup(7).at(-1)!.momentOgRenders).toBe(3);
  });

  test('different moments dedupe independently', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-25T10:00:00Z') });
    m.recordMomentOgRender('mom1', 'alice');
    m.recordMomentOgRender('mom2', 'alice');
    m.recordMomentOgRender('mom3', 'alice');
    expect(m.rollup(7).at(-1)!.momentOgRenders).toBe(3);
  });

  test('caps the per-moment dedup set and floors overflow', () => {
    const m = new StickyMetrics({
      now: clockAt('2026-04-25T10:00:00Z'),
      maxMomentVisitorsPerDay: 2,
    });
    m.recordMomentOgRender('mom1', 'a');
    m.recordMomentOgRender('mom1', 'b');
    m.recordMomentOgRender('mom1', 'c'); // floors
    m.recordMomentOgRender('mom1', 'd'); // floors
    expect(m.rollup(7).at(-1)!.momentOgRenders).toBe(4);
  });

  test('ignores empty moment id or visitor id', () => {
    const m = new StickyMetrics({ now: clockAt('2026-04-25T10:00:00Z') });
    m.recordMomentOgRender('', 'alice');
    m.recordMomentOgRender('mom1', '');
    expect(m.rollup(7).at(-1)!.momentOgRenders).toBe(0);
  });

  test('persists across a load-write-load cycle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-og-'));
    const ref = { ms: Date.parse('2026-04-25T10:00:00Z') };
    const m1 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m1.load();
    m1.recordMomentOgRender('mom1', 'twitterbot');
    m1.recordMomentOgRender('mom2', 'slackbot');
    await m1.flush();

    const m2 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m2.load();
    expect(m2.rollup(7).at(-1)!.momentOgRenders).toBe(2);
    // Re-asserting the same tuple after reload still dedupes.
    m2.recordMomentOgRender('mom1', 'twitterbot');
    expect(m2.rollup(7).at(-1)!.momentOgRenders).toBe(2);
  });

  test('pre-TINA-616 persisted shape (no momentOgVisitors) loads as 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-legacy-og-'));
    const legacy = {
      version: 1,
      days: [
        {
          date: '2026-04-25',
          shares: 0,
          momentVisitors: [],
          momentExtraVisits: 0,
          returns24h: 0,
          returns7d: 0,
          nudgesApplied: 0,
          groupMomentsCreated: 0,
          affordanceUses: 0,
          characterProfileVisitors: [],
          characterProfileExtraViews: 0,
          momentsIndexVisitors: [],
          momentsIndexExtraViews: 0,
        },
      ],
      visitors: [],
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, STICKY_METRICS_FILE), `${JSON.stringify(legacy)}\n`, 'utf8');
    const m = new StickyMetrics({ dir, now: clockAt('2026-04-25T10:00:00Z') });
    await m.load();
    const today = m.rollup(7).at(-1)!;
    expect(today.momentOgRenders).toBe(0);
  });
});

describe('StickyMetrics persistence', () => {
  test('survives load-write-load cycle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sticky-test-'));
    const ref = { ms: Date.parse('2026-04-22T10:00:00Z') };

    const m1 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m1.load();
    m1.recordShare();
    m1.recordMomentVisit('alice');
    ref.ms += 1 * DAY_MS;
    m1.recordRootVisit('alice');
    await m1.flush();

    const raw = await readFile(join(dir, STICKY_METRICS_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);

    const m2 = new StickyMetrics({ dir, now: clockFromRef(ref) });
    await m2.load();
    const today = m2.rollup(7).at(-1)!;
    expect(today.date).toBe('2026-04-23');
    expect(today.returningVisits24h).toBe(1);
    expect(m2.rollup(7).find((d) => d.date === '2026-04-22')!.sharesCreated).toBe(1);
    expect(m2.rollup(7).find((d) => d.date === '2026-04-22')!.momentUniqueVisits).toBe(1);
  });

  test('prunes days and visitors outside the retention window', async () => {
    const ref = { ms: Date.parse('2026-04-01T10:00:00Z') };
    const m = new StickyMetrics({ now: clockFromRef(ref), retentionDays: 3 });
    m.recordShare(); // seeds the 2026-04-01 bucket
    m.recordRootVisit('alice');
    expect(m.dayCount()).toBe(1);
    expect(m.visitorCount()).toBe(1);
    ref.ms += 5 * DAY_MS; // jump to 2026-04-06, 5 days past retention
    m.recordShare();
    // Old day pruned; only today remains. Alice's lastSeen is 5 days stale
    // under retention=3, so she's evicted too.
    expect(m.dayCount()).toBe(1);
    expect(m.visitorCount()).toBe(0);
  });
});

describe('visitor cookie helpers', () => {
  test('parseVisitorCookie extracts tvid', () => {
    expect(parseVisitorCookie('tvid=abcDEF1234567890')).toBe('abcDEF1234567890');
    expect(parseVisitorCookie('foo=bar; tvid=abcDEF1234567890; baz=1')).toBe('abcDEF1234567890');
  });

  test('parseVisitorCookie rejects malformed values', () => {
    expect(parseVisitorCookie('tvid=')).toBeNull();
    expect(parseVisitorCookie('tvid=short')).toBeNull();
    expect(parseVisitorCookie('tvid=bad value!!')).toBeNull();
    expect(parseVisitorCookie(undefined)).toBeNull();
    expect(parseVisitorCookie('')).toBeNull();
  });

  test('generateVisitorId is 16 url-safe chars', () => {
    const id = generateVisitorId(() => 0.5);
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(id.length).toBe(16);
  });

  test('buildVisitorSetCookie uses 1y max-age and strict flags', () => {
    const s = buildVisitorSetCookie('abcDEF1234567890');
    expect(s).toContain('tvid=abcDEF1234567890');
    expect(s).toContain(`Max-Age=${60 * 60 * 24 * 365}`);
    expect(s).toContain('HttpOnly');
    expect(s).toContain('SameSite=Lax');
    expect(s).toContain('Path=/');
  });
});
