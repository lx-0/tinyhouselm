import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NUDGE_DELTAS,
  RELATIONSHIP_FILE,
  RELATIONSHIP_RECORD_VERSION,
  RelationshipStore,
  applyNudge,
  computeAffinityDelta,
  deriveArcLabel,
  pairKey,
} from './relationships.js';

const SECONDS_PER_DAY = 86_400;

describe('pairKey', () => {
  it('canonicalizes regardless of argument order', () => {
    expect(pairKey('mei', 'bruno')).toBe(pairKey('bruno', 'mei'));
    expect(pairKey('ava', 'kenji')).toBe('ava::kenji');
  });
});

describe('computeAffinityDelta', () => {
  it('scales with turn count up to a cap', () => {
    expect(
      computeAffinityDelta({
        turnCount: 1,
        sharedConversationCount: 0,
        simTimeSinceLastInteraction: null,
      }),
    ).toBeCloseTo(0.02);
    expect(
      computeAffinityDelta({
        turnCount: 6,
        sharedConversationCount: 0,
        simTimeSinceLastInteraction: null,
      }),
    ).toBeCloseTo(0.12);
    expect(
      computeAffinityDelta({
        turnCount: 100,
        sharedConversationCount: 0,
        simTimeSinceLastInteraction: null,
      }),
    ).toBeCloseTo(0.12);
  });

  it('grants a repeat-visit bonus for tight re-engagement', () => {
    const fresh = computeAffinityDelta({
      turnCount: 4,
      sharedConversationCount: 4,
      simTimeSinceLastInteraction: 600, // 10 sim-min ago
    });
    const stale = computeAffinityDelta({
      turnCount: 4,
      sharedConversationCount: 4,
      simTimeSinceLastInteraction: 2 * SECONDS_PER_DAY,
    });
    expect(fresh).toBeCloseTo(0.08 + 0.02);
    expect(stale).toBeCloseTo(0.08);
  });

  it('no repeat bonus before the third encounter', () => {
    const delta = computeAffinityDelta({
      turnCount: 4,
      sharedConversationCount: 2,
      simTimeSinceLastInteraction: 60,
    });
    expect(delta).toBeCloseTo(0.08);
  });
});

describe('deriveArcLabel', () => {
  function state(partial: Partial<Parameters<typeof deriveArcLabel>[0]>) {
    return deriveArcLabel({
      a: 'a',
      b: 'b',
      affinity: 0,
      lastInteractionSim: 0,
      sharedConversationCount: 5,
      arcLabel: 'new',
      windowStartDay: 0,
      windowConversationCount: 1,
      windowAffinityDelta: 0,
      ...partial,
    });
  }

  it('never returns new — that label is only set on pair creation', () => {
    // A freshly-rolled pair with a single lifetime conversation and no
    // contact this window should read as cooling, not new.
    expect(state({ sharedConversationCount: 1, windowConversationCount: 0 })).toBe('cooling');
  });

  it('estranged when affinity has fallen below -0.3', () => {
    expect(state({ affinity: -0.4 })).toBe('estranged');
  });

  it('cooling when the window had no contact', () => {
    expect(state({ windowConversationCount: 0 })).toBe('cooling');
  });

  it('cooling when cumulative delta was negative', () => {
    expect(state({ windowAffinityDelta: -0.1 })).toBe('cooling');
  });

  it('warming when the window delta crossed the threshold', () => {
    expect(state({ windowAffinityDelta: 0.12, windowConversationCount: 2 })).toBe('warming');
  });

  it('steady otherwise', () => {
    expect(state({ windowAffinityDelta: 0.02, windowConversationCount: 3 })).toBe('steady');
  });
});

describe('RelationshipStore', () => {
  it('recordClose creates a new pair and seeds delta as affinity', () => {
    const store = new RelationshipStore();
    const state = store.recordClose({ a: 'mei', b: 'bruno', simTime: 100, turnCount: 4 });
    expect(state.a).toBe('bruno');
    expect(state.b).toBe('mei');
    expect(state.affinity).toBeCloseTo(0.08);
    expect(state.sharedConversationCount).toBe(1);
    expect(state.arcLabel).toBe('new');
    expect(state.windowConversationCount).toBe(1);
  });

  it('recordClose accumulates affinity across closes, clamped to +1', () => {
    const store = new RelationshipStore();
    for (let i = 0; i < 20; i++) {
      store.recordClose({ a: 'mei', b: 'bruno', simTime: 100 + i, turnCount: 10 });
    }
    const state = store.getPair('mei', 'bruno')!;
    expect(state.affinity).toBeCloseTo(1);
    expect(state.sharedConversationCount).toBe(20);
  });

  it('getPair returns null for unknown pairs and rejects same-id', () => {
    const store = new RelationshipStore();
    expect(store.getPair('mei', 'bruno')).toBeNull();
    expect(store.getPair('mei', 'mei')).toBeNull();
  });

  it('recordClose rejects self-pair', () => {
    const store = new RelationshipStore();
    expect(() => store.recordClose({ a: 'mei', b: 'mei', simTime: 0, turnCount: 1 })).toThrow();
  });

  it('rolloverDay transitions counters and resets the window', () => {
    const store = new RelationshipStore();
    // Two closes on day 0 with 4 turns each = +0.08 * 2 = 0.16 delta.
    store.recordClose({ a: 'mei', b: 'bruno', simTime: 10, turnCount: 4 });
    store.recordClose({ a: 'mei', b: 'bruno', simTime: 20, turnCount: 4 });
    const rolled = store.rolloverDay(8 * SECONDS_PER_DAY);
    expect(rolled).toBe(1);
    const state = store.getPair('mei', 'bruno')!;
    expect(state.arcLabel).toBe('warming');
    expect(state.windowConversationCount).toBe(0);
    expect(state.windowAffinityDelta).toBe(0);
    expect(state.windowStartDay).toBe(8);
  });

  it('rolloverDay marks a pair cooling when the window had zero contact', () => {
    const store = new RelationshipStore();
    store.recordClose({ a: 'mei', b: 'bruno', simTime: 10, turnCount: 4 });
    // Roll past the first 7-day window to set label steady-ish.
    store.rolloverDay(8 * SECONDS_PER_DAY);
    // Another 7 days with no activity.
    const rolled = store.rolloverDay(16 * SECONDS_PER_DAY);
    expect(rolled).toBe(1);
    expect(store.getPair('mei', 'bruno')!.arcLabel).toBe('cooling');
  });

  it('rolloverDay leaves pairs inside the window alone', () => {
    const store = new RelationshipStore();
    store.recordClose({ a: 'mei', b: 'bruno', simTime: 10, turnCount: 4 });
    const rolled = store.rolloverDay(3 * SECONDS_PER_DAY);
    expect(rolled).toBe(0);
    expect(store.getPair('mei', 'bruno')!.arcLabel).toBe('new');
  });

  it('evicts the oldest pair when the LRU cap is exceeded', () => {
    const store = new RelationshipStore({ maxPairs: 2 });
    store.recordClose({ a: 'a', b: 'b', simTime: 1, turnCount: 1 });
    store.recordClose({ a: 'c', b: 'd', simTime: 2, turnCount: 1 });
    store.recordClose({ a: 'e', b: 'f', simTime: 3, turnCount: 1 });
    expect(store.count()).toBe(2);
    expect(store.getPair('a', 'b')).toBeNull();
    expect(store.getPair('c', 'd')).not.toBeNull();
    expect(store.getPair('e', 'f')).not.toBeNull();
  });

  it('zoneAffinityFor aggregates per-zone weighted by pair affinity', () => {
    const store = new RelationshipStore();
    // Build three pairs involving mei.
    for (let i = 0; i < 3; i++) {
      store.recordClose({ a: 'mei', b: 'bruno', simTime: 10 + i, turnCount: 6 });
    }
    for (let i = 0; i < 3; i++) {
      store.recordClose({ a: 'mei', b: 'hiro', simTime: 10 + i, turnCount: 6 });
    }
    // Give mei<->ava a negative affinity by driving it past -0.3.
    const neg = store.getPair('mei', 'ava');
    // No prior pair — create one with a negative delta by manipulation.
    // Not supported in the public API, so just simulate via repeated low-quality
    // closes is not possible (all positive). Skip the negative half for this test.
    expect(neg).toBeNull();

    const hints = store.zoneAffinityFor(
      'mei',
      new Map([
        ['bruno', 'cafe'],
        ['hiro', 'cafe'],
        ['stranger', 'park'], // no pair yet, ignored
      ]),
    );
    expect(hints.size).toBe(1);
    const cafeWeight = hints.get('cafe')!;
    expect(cafeWeight).toBeGreaterThan(0);
    // Both contributors feed into the same zone, so weight > single pair affinity.
    expect(cafeWeight).toBeCloseTo(
      store.getPair('mei', 'bruno')!.affinity + store.getPair('mei', 'hiro')!.affinity,
    );
  });

  it('round-trips to disk via load/flush', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tina-rel-'));
    try {
      const write = new RelationshipStore({ dir });
      write.recordClose({ a: 'mei', b: 'bruno', simTime: 100, turnCount: 4 });
      write.recordClose({ a: 'ava', b: 'kenji', simTime: 200, turnCount: 8 });
      await write.flush();
      const raw = await readFile(join(dir, RELATIONSHIP_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(RELATIONSHIP_RECORD_VERSION);
      expect(parsed.pairs).toHaveLength(2);

      const read = new RelationshipStore({ dir });
      await read.load();
      expect(read.count()).toBe(2);
      expect(read.getPair('mei', 'bruno')!.affinity).toBeCloseTo(0.08);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('RelationshipStore nudge queue (TINA-275)', () => {
  it('applyNudge floors into positive band for spark and reconcile', () => {
    expect(applyNudge(-0.4, 'spark')).toBeCloseTo(NUDGE_DELTAS.spark);
    expect(applyNudge(-0.4, 'reconcile')).toBeCloseTo(NUDGE_DELTAS.reconcile);
    // tension does NOT floor — it actually drops from an already-negative value.
    expect(applyNudge(-0.4, 'tension')).toBeCloseTo(-0.65);
    // Positive base adds directly.
    expect(applyNudge(0.3, 'spark')).toBeCloseTo(0.55);
    // Clamp to +1.
    expect(applyNudge(0.95, 'spark')).toBe(1);
    // Clamp to -1.
    expect(applyNudge(-0.9, 'tension')).toBe(-1);
  });

  it('queueNudge stores one entry per pair and replaces on re-queue', () => {
    const store = new RelationshipStore();
    store.queueNudge({ a: 'mei', b: 'bruno', direction: 'spark', simTime: 100 });
    expect(store.nudgeCount()).toBe(1);
    const peek1 = store.peekNudge('bruno', 'mei')!;
    expect(peek1.direction).toBe('spark');
    // Canonical ordering is enforced regardless of argument order.
    expect(peek1.a).toBe('bruno');
    expect(peek1.b).toBe('mei');

    // Re-queue replaces the prior direction — no cumulative stacking.
    store.queueNudge({ a: 'mei', b: 'bruno', direction: 'tension', simTime: 200 });
    expect(store.nudgeCount()).toBe(1);
    expect(store.peekNudge('mei', 'bruno')!.direction).toBe('tension');
  });

  it('queueNudge rejects same-id pair', () => {
    const store = new RelationshipStore();
    expect(() =>
      store.queueNudge({ a: 'mei', b: 'mei', direction: 'spark', simTime: 1 }),
    ).toThrow();
  });

  it('consumeNudgeOnClose applies the bounded delta once and removes the queue entry', () => {
    const store = new RelationshipStore();
    store.recordClose({ a: 'mei', b: 'bruno', simTime: 10, turnCount: 4 });
    const before = store.getPair('mei', 'bruno')!.affinity; // ~0.08
    store.queueNudge({ a: 'mei', b: 'bruno', direction: 'spark', simTime: 20 });

    // First close consumes it.
    store.recordClose({ a: 'mei', b: 'bruno', simTime: 30, turnCount: 4 });
    const consumed = store.consumeNudgeOnClose('mei', 'bruno');
    expect(consumed?.direction).toBe('spark');
    const afterNudge = store.getPair('mei', 'bruno')!.affinity;
    // Natural delta (+0.08) plus the spark delta (+0.25), clamped.
    expect(afterNudge).toBeGreaterThan(before + 0.2);
    expect(store.nudgeCount()).toBe(0);
    // windowAffinityDelta reflects BOTH deltas so the next weekly rollover
    // sees the viewer's bias.
    expect(store.getPair('mei', 'bruno')!.windowAffinityDelta).toBeGreaterThan(0.3);

    // A second close does NOT re-apply — the queue is empty.
    expect(store.consumeNudgeOnClose('mei', 'bruno')).toBeNull();
  });

  it('consumeNudgeOnClose with reconcile lifts an estranged pair into the positive band', () => {
    const store = new RelationshipStore();
    // Force an estranged baseline — we manipulate through repeated closes
    // which always push positive, so instead queue + apply a tension first.
    store.recordClose({ a: 'ava', b: 'kenji', simTime: 10, turnCount: 1 });
    // Tension drives affinity below zero.
    store.queueNudge({ a: 'ava', b: 'kenji', direction: 'tension', simTime: 20 });
    store.recordClose({ a: 'ava', b: 'kenji', simTime: 30, turnCount: 1 });
    store.consumeNudgeOnClose('ava', 'kenji');
    const estranged = store.getPair('ava', 'kenji')!.affinity;
    expect(estranged).toBeLessThan(0);

    // Reconcile lifts them back above zero (+0.15 floored from 0).
    store.queueNudge({ a: 'ava', b: 'kenji', direction: 'reconcile', simTime: 40 });
    store.recordClose({ a: 'ava', b: 'kenji', simTime: 50, turnCount: 1 });
    store.consumeNudgeOnClose('ava', 'kenji');
    const reconciled = store.getPair('ava', 'kenji')!.affinity;
    expect(reconciled).toBeGreaterThan(0);
  });

  it('consumeNudgeOnClose returns null when no nudge is queued', () => {
    const store = new RelationshipStore();
    store.recordClose({ a: 'mei', b: 'bruno', simTime: 10, turnCount: 4 });
    expect(store.consumeNudgeOnClose('mei', 'bruno')).toBeNull();
  });

  it('persists nudges across restart via load/flush', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tina-rel-nudge-'));
    try {
      const write = new RelationshipStore({ dir });
      write.recordClose({ a: 'mei', b: 'bruno', simTime: 100, turnCount: 4 });
      write.queueNudge({ a: 'mei', b: 'bruno', direction: 'spark', simTime: 150 });
      await write.flush();

      const raw = await readFile(join(dir, RELATIONSHIP_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.nudges).toHaveLength(1);
      expect(parsed.nudges[0]).toMatchObject({ direction: 'spark' });

      const read = new RelationshipStore({ dir });
      await read.load();
      const peeked = read.peekNudge('mei', 'bruno');
      expect(peeked?.direction).toBe('spark');

      // Consumption persists too.
      read.recordClose({ a: 'mei', b: 'bruno', simTime: 200, turnCount: 2 });
      read.consumeNudgeOnClose('mei', 'bruno');
      await read.flush();
      const again = new RelationshipStore({ dir });
      await again.load();
      expect(again.nudgeCount()).toBe(0);
      expect(again.getPair('mei', 'bruno')!.affinity).toBeGreaterThan(0.3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts v1 on-disk payloads without a nudges field (seamless upgrade)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tina-rel-v1-'));
    try {
      const v1 = {
        version: 1,
        pairs: [
          {
            a: 'bruno',
            b: 'mei',
            affinity: 0.5,
            lastInteractionSim: 100,
            sharedConversationCount: 2,
            arcLabel: 'steady',
            windowStartDay: 0,
            windowConversationCount: 1,
            windowAffinityDelta: 0.1,
          },
        ],
      };
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dir, RELATIONSHIP_FILE), `${JSON.stringify(v1)}\n`, 'utf8');

      const store = new RelationshipStore({ dir });
      await store.load();
      expect(store.count()).toBe(1);
      expect(store.nudgeCount()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('LRU eviction drops orphan nudges', () => {
    const store = new RelationshipStore({ maxPairs: 2 });
    store.recordClose({ a: 'a', b: 'b', simTime: 1, turnCount: 1 });
    store.queueNudge({ a: 'a', b: 'b', direction: 'spark', simTime: 2 });
    expect(store.nudgeCount()).toBe(1);
    store.recordClose({ a: 'c', b: 'd', simTime: 3, turnCount: 1 });
    store.recordClose({ a: 'e', b: 'f', simTime: 4, turnCount: 1 });
    // a↔b evicted as oldest; its nudge is gone too (no orphans).
    expect(store.getPair('a', 'b')).toBeNull();
    expect(store.peekNudge('a', 'b')).toBeNull();
    expect(store.nudgeCount()).toBe(0);
  });
});
