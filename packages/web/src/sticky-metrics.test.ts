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
