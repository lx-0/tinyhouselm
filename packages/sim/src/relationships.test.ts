import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RELATIONSHIP_FILE,
  RELATIONSHIP_RECORD_VERSION,
  RelationshipStore,
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
