import { type MomentRecord, deriveWorldClock } from '@tina/shared';
import { RelationshipStore } from '@tina/sim';
import { describe, expect, test } from 'vitest';
import { buildRelatedMoments } from './moment-routes.js';
import { arcStrengthScore, assignRailVariant, isRailVariant } from './rail-experiment.js';

function mkRecord(opts: {
  id: string;
  simTime: number;
  participants: Array<{ id: string; named: boolean }>;
  zone?: string | null;
}): MomentRecord {
  return {
    version: 1,
    id: opts.id,
    sessionId: `s-${opts.id}`,
    variant: 'conversation',
    headline: `headline ${opts.id}`,
    simTime: opts.simTime,
    clock: deriveWorldClock(opts.simTime, 30),
    capturedAt: '2026-04-27T00:00:00Z',
    zone: opts.zone ?? null,
    participants: opts.participants.map((p) => ({
      id: p.id,
      name: p.id.toUpperCase(),
      named: p.named,
      color: null,
    })),
    transcript: [],
    openedAt: opts.simTime,
    closedAt: opts.simTime,
    closeReason: 'idle',
    reflection: null,
  };
}

describe('assignRailVariant (TINA-1020)', () => {
  test('returns freshest when the experiment is off', () => {
    expect(assignRailVariant('any-visitor', false)).toBe('freshest');
    expect(assignRailVariant('203.0.113.7', false)).toBe('freshest');
  });

  test('is deterministic per visitor key', () => {
    const a = assignRailVariant('visitor-abc', true);
    const b = assignRailVariant('visitor-abc', true);
    expect(a).toBe(b);
  });

  test('splits visitors across both variants', () => {
    const counts = { freshest: 0, arc_strength: 0 };
    for (let i = 0; i < 1000; i++) {
      const v = assignRailVariant(`visitor-${i}`, true);
      counts[v] += 1;
    }
    // FNV-1a is well-distributed; each side should clear ~40% of 1000.
    expect(counts.freshest).toBeGreaterThan(400);
    expect(counts.arc_strength).toBeGreaterThan(400);
    expect(counts.freshest + counts.arc_strength).toBe(1000);
  });

  test('empty visitor key falls back to freshest', () => {
    expect(assignRailVariant('', true)).toBe('freshest');
  });
});

describe('isRailVariant (TINA-1020)', () => {
  test('accepts the closed set, rejects everything else', () => {
    expect(isRailVariant('freshest')).toBe(true);
    expect(isRailVariant('arc_strength')).toBe(true);
    expect(isRailVariant('FRESHEST')).toBe(false);
    expect(isRailVariant('control')).toBe(false);
    expect(isRailVariant(null)).toBe(false);
    expect(isRailVariant(undefined)).toBe(false);
    expect(isRailVariant(42)).toBe(false);
  });
});

describe('arcStrengthScore (TINA-1020)', () => {
  test('returns 0 when relationships is null', () => {
    const src = mkRecord({
      id: 'src',
      simTime: 100,
      participants: [{ id: 'mei', named: true }],
    });
    const cand = mkRecord({
      id: 'c1',
      simTime: 100,
      participants: [{ id: 'hiro', named: true }],
    });
    expect(arcStrengthScore(src, cand, null)).toBe(0);
  });

  test('sums pairwise affinity across named-only participants', () => {
    const rels = new RelationshipStore();
    rels.recordClose({ a: 'mei', b: 'hiro', simTime: 1, turnCount: 6 });
    rels.recordClose({ a: 'mei', b: 'hiro', simTime: 2, turnCount: 6 });
    rels.recordClose({ a: 'mei', b: 'kenji', simTime: 3, turnCount: 6 });
    const src = mkRecord({
      id: 'src',
      simTime: 100,
      participants: [
        { id: 'mei', named: true },
        { id: 'fill', named: false }, // procedural is ignored
      ],
    });
    const cand = mkRecord({
      id: 'c1',
      simTime: 100,
      participants: [
        { id: 'hiro', named: true },
        { id: 'kenji', named: true },
      ],
    });
    const score = arcStrengthScore(src, cand, rels);
    const meiHiro = rels.getPair('mei', 'hiro')!.affinity;
    const meiKenji = rels.getPair('mei', 'kenji')!.affinity;
    expect(score).toBeCloseTo(meiHiro + meiKenji, 6);
  });

  test('skips self-pairs (same id on both sides)', () => {
    const rels = new RelationshipStore();
    rels.recordClose({ a: 'mei', b: 'hiro', simTime: 1, turnCount: 6 });
    const src = mkRecord({
      id: 'src',
      simTime: 100,
      participants: [{ id: 'mei', named: true }],
    });
    const cand = mkRecord({
      id: 'c1',
      simTime: 100,
      participants: [
        { id: 'mei', named: true },
        { id: 'hiro', named: true },
      ],
    });
    // Only mei↔hiro contributes; mei↔mei is skipped.
    const score = arcStrengthScore(src, cand, rels);
    expect(score).toBeCloseTo(rels.getPair('mei', 'hiro')!.affinity, 6);
  });
});

describe('buildRelatedMoments arc_strength variant (TINA-1020)', () => {
  test('within tier 2, the arc_strength variant ranks highest-affinity first', () => {
    const rels = new RelationshipStore();
    // Build a clear affinity gap: mei↔kenji has many positive closes; mei↔ava
    // has none (no close ever recorded), so its score is 0.
    for (let i = 1; i <= 10; i++) {
      rels.recordClose({ a: 'mei', b: 'kenji', simTime: i, turnCount: 6 });
    }
    const source = mkRecord({
      id: 'src',
      simTime: 100,
      participants: [{ id: 'mei', named: true }],
    });
    // Both candidates land in tier 2 (share Mei). Ava is FRESHER than Kenji,
    // so freshest would put Ava first; arc_strength should put Kenji first.
    const ava = mkRecord({
      id: 'ava-cand',
      simTime: 90,
      participants: [
        { id: 'mei', named: true },
        { id: 'ava', named: true },
      ],
    });
    const kenji = mkRecord({
      id: 'kenji-cand',
      simTime: 50,
      participants: [
        { id: 'mei', named: true },
        { id: 'kenji', named: true },
      ],
    });

    const fresh = buildRelatedMoments(source, [source, ava, kenji], 6, 'freshest', rels);
    expect(fresh.map((m) => m.id)).toEqual(['ava-cand', 'kenji-cand']);

    const arc = buildRelatedMoments(source, [source, ava, kenji], 6, 'arc_strength', rels);
    expect(arc.map((m) => m.id)).toEqual(['kenji-cand', 'ava-cand']);
  });

  test('arc_strength does not cross tier boundaries', () => {
    const rels = new RelationshipStore();
    // Strong cross-pair affinity that would *only* matter inside tier 2.
    for (let i = 1; i <= 20; i++) {
      rels.recordClose({ a: 'kenji', b: 'ava', simTime: i, turnCount: 6 });
    }
    const source = mkRecord({
      id: 'src',
      simTime: 100,
      participants: [
        { id: 'mei', named: true },
        { id: 'hiro', named: true },
      ],
      zone: 'cafe',
    });
    // Tier 1: shares both named participants; no recorded affinity with kenji/ava.
    const t1 = mkRecord({
      id: 't1',
      simTime: 50,
      participants: [
        { id: 'mei', named: true },
        { id: 'hiro', named: true },
      ],
    });
    // Tier 2: shares only mei, but pulls in kenji + ava (irrelevant — score
    // sums *source × candidate*, not candidate × candidate).
    const t2 = mkRecord({
      id: 't2',
      simTime: 90,
      participants: [
        { id: 'mei', named: true },
        { id: 'kenji', named: true },
        { id: 'ava', named: true },
      ],
    });
    const out = buildRelatedMoments(source, [source, t2, t1], 6, 'arc_strength', rels);
    // t1 must come first because it sits in a higher tier.
    expect(out.map((m) => m.id)).toEqual(['t1', 't2']);
  });

  test('arc_strength with null relationships collapses to freshest order', () => {
    const source = mkRecord({
      id: 'src',
      simTime: 100,
      participants: [{ id: 'mei', named: true }],
    });
    const a = mkRecord({
      id: 'aaa',
      simTime: 50,
      participants: [{ id: 'mei', named: true }],
    });
    const c = mkRecord({
      id: 'ccc',
      simTime: 90,
      participants: [{ id: 'mei', named: true }],
    });
    const out = buildRelatedMoments(source, [source, a, c], 6, 'arc_strength', null);
    expect(out.map((m) => m.id)).toEqual(['ccc', 'aaa']);
  });
});
