import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ConversationTurn,
  MOMENT_RECORD_VERSION,
  type WorldClock,
  buildMomentHeadline,
  deriveWorldClock,
} from '@tina/shared';
import { describe, expect, test } from 'vitest';
import { MOMENT_FILE, MomentStore } from './moments.js';

function clockAt(hour: number, minute: number): WorldClock {
  return deriveWorldClock(hour * 3600 + minute * 60, 30);
}

function turn(speakerId: string, text: string, at: number): ConversationTurn {
  return { speakerId, text, at };
}

function mkIdSeq(prefix = 'mom'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function mkStore(overrides: Partial<Parameters<typeof makeStoreArgs>[0]> = {}): MomentStore {
  return new MomentStore(makeStoreArgs(overrides));
}

function makeStoreArgs(
  overrides: {
    dir?: string;
    maxMoments?: number;
    reflectionAttachWindowSim?: number;
    idGenerator?: () => string;
    now?: () => string;
  } = {},
) {
  return {
    maxMoments: overrides.maxMoments ?? 3,
    reflectionAttachWindowSim: overrides.reflectionAttachWindowSim,
    idGenerator: overrides.idGenerator ?? mkIdSeq(),
    now: overrides.now ?? (() => '2026-04-23T00:00:00.000Z'),
    dir: overrides.dir,
  };
}

describe('buildMomentHeadline', () => {
  test('two named participants + zone', () => {
    expect(
      buildMomentHeadline({
        participants: [{ name: 'Mei' }, { name: 'Hiro' }],
        zone: 'cafe',
        transcriptLength: 5,
        clock: { hour: 15, minute: 14 },
      }),
    ).toBe('Mei and Hiro talked in the cafe at 3:14pm');
  });

  test('two participants with short transcript → crossed paths', () => {
    expect(
      buildMomentHeadline({
        participants: [{ name: 'Ava' }, { name: 'Bruno' }],
        zone: 'park',
        transcriptLength: 1,
        clock: { hour: 7, minute: 2 },
      }),
    ).toBe('Ava and Bruno crossed paths in the park at 7:02am');
  });

  test('two participants with long transcript → argued', () => {
    expect(
      buildMomentHeadline({
        participants: [{ name: 'Mei' }, { name: 'Bruno' }],
        zone: null,
        transcriptLength: 12,
        clock: { hour: 0, minute: 30 },
      }),
    ).toBe('Mei and Bruno argued at 12:30am');
  });

  test('solo participant muttering', () => {
    expect(
      buildMomentHeadline({
        participants: [{ name: 'Kenji' }],
        zone: 'plaza',
        transcriptLength: 3,
        clock: { hour: 23, minute: 30 },
      }),
    ).toBe('Kenji muttered to themselves in the plaza at 11:30pm');
  });

  test('three+ participants list out with oxford comma', () => {
    expect(
      buildMomentHeadline({
        participants: [{ name: 'Mei' }, { name: 'Hiro' }, { name: 'Ava' }],
        zone: 'cafe',
        transcriptLength: 8,
        clock: { hour: 12, minute: 0 },
      }),
    ).toBe('Mei, Hiro, and Ava argued in the cafe at 12:00pm');
  });

  test('same inputs yield identical output (deterministic, no LLM)', () => {
    const inputs = {
      participants: [{ name: 'Mei' }, { name: 'Hiro' }],
      zone: 'cafe',
      transcriptLength: 5,
      clock: { hour: 15, minute: 14 },
    };
    expect(buildMomentHeadline(inputs)).toBe(buildMomentHeadline(inputs));
  });
});

describe('MomentStore.captureClose', () => {
  test('builds a record with deterministic headline + stable id per session', () => {
    const store = mkStore({ idGenerator: mkIdSeq('abc') });
    const participants = [
      { id: 'mei', name: 'Mei', named: true, color: '#ff00aa' },
      { id: 'hiro', name: 'Hiro', named: true, color: '#00ccff' },
    ];
    const r1 = store.captureClose(
      {
        sessionId: 'conv-1',
        simTime: 15 * 3600 + 14 * 60,
        openedAt: 15 * 3600,
        transcript: [turn('mei', 'hi', 0), turn('hiro', 'oh hey', 1), turn('mei', 'coffee?', 2)],
        participants,
        zone: 'cafe',
        closeReason: 'idle',
      },
      clockAt(15, 14),
    );
    expect(r1.id).toBe('abc1');
    expect(r1.headline).toBe('Mei and Hiro talked in the cafe at 3:14pm');
    expect(r1.participants).toEqual(participants);
    expect(r1.transcript).toHaveLength(3);
    expect(r1.reflection).toBeNull();
    expect(r1.version).toBe(MOMENT_RECORD_VERSION);
    expect(r1.capturedAt).toBe('2026-04-23T00:00:00.000Z');

    // Second capture of the same session id must return the same moment (create-or-retrieve).
    const r2 = store.captureClose(
      {
        sessionId: 'conv-1',
        simTime: 20000,
        openedAt: 10000,
        transcript: [],
        participants,
        zone: null,
        closeReason: 'drifted',
      },
      clockAt(5, 0),
    );
    expect(r2.id).toBe('abc1');
    expect(r2.headline).toBe(r1.headline);
  });

  test('evicts oldest when over the cap', () => {
    const store = mkStore({ maxMoments: 2, idGenerator: mkIdSeq('m') });
    const participants = [
      { id: 'a', name: 'A', named: false, color: null },
      { id: 'b', name: 'B', named: false, color: null },
    ];
    for (let i = 0; i < 4; i++) {
      store.captureClose(
        {
          sessionId: `s${i}`,
          simTime: i * 60,
          openedAt: i * 60 - 30,
          transcript: [turn('a', 'hi', i * 60)],
          participants,
          zone: null,
          closeReason: 'idle',
        },
        clockAt(10, 0),
      );
    }
    const ids = store.list().map((r) => r.id);
    expect(ids).toEqual(['m3', 'm4']);
    expect(store.count()).toBe(2);
    expect(store.getBySession('s0')).toBeNull();
    expect(store.getBySession('s2')?.id).toBe('m3');
  });
});

describe('MomentStore.attachReflection', () => {
  const participants = [
    { id: 'mei', name: 'Mei', named: true, color: null },
    { id: 'hiro', name: 'Hiro', named: true, color: null },
  ];

  test('attaches to the most recent in-window moment for that participant', () => {
    const store = mkStore();
    const m = store.captureClose(
      {
        sessionId: 's1',
        simTime: 1000,
        openedAt: 900,
        transcript: [turn('mei', 'hi', 900)],
        participants,
        zone: 'cafe',
        closeReason: 'idle',
      },
      clockAt(1, 0),
    );

    const attachedTo = store.attachReflection({
      reflectionId: 'refl-1',
      agentId: 'mei',
      summary: 'realized I value Hiro',
      sourceCount: 3,
      trigger: 'importance_budget',
      simTime: 1100,
    });
    expect(attachedTo).toBe(m.id);
    expect(store.get(m.id)?.reflection?.reflectionId).toBe('refl-1');
  });

  test('does not attach reflections outside the window', () => {
    const store = mkStore({ reflectionAttachWindowSim: 60 });
    const m = store.captureClose(
      {
        sessionId: 's1',
        simTime: 1000,
        openedAt: 900,
        transcript: [turn('mei', 'hi', 900)],
        participants,
        zone: 'cafe',
        closeReason: 'idle',
      },
      clockAt(1, 0),
    );

    const attachedTo = store.attachReflection({
      reflectionId: 'refl-1',
      agentId: 'mei',
      summary: 'much later reflection',
      sourceCount: 3,
      trigger: 'day_rollover',
      simTime: 5000,
    });
    expect(attachedTo).toBeNull();
    expect(store.get(m.id)?.reflection).toBeNull();
  });

  test('does not attach to moments that already have a reflection', () => {
    const store = mkStore();
    const m = store.captureClose(
      {
        sessionId: 's1',
        simTime: 1000,
        openedAt: 900,
        transcript: [turn('mei', 'hi', 900)],
        participants,
        zone: 'cafe',
        closeReason: 'idle',
      },
      clockAt(1, 0),
    );
    store.attachReflection({
      reflectionId: 'refl-1',
      agentId: 'mei',
      summary: 'first',
      sourceCount: 1,
      trigger: 'manual',
      simTime: 1010,
    });
    const second = store.attachReflection({
      reflectionId: 'refl-2',
      agentId: 'mei',
      summary: 'second',
      sourceCount: 1,
      trigger: 'manual',
      simTime: 1020,
    });
    expect(second).toBeNull();
    expect(store.get(m.id)?.reflection?.reflectionId).toBe('refl-1');
  });

  test('ignores reflections whose agent is not a participant', () => {
    const store = mkStore();
    store.captureClose(
      {
        sessionId: 's1',
        simTime: 1000,
        openedAt: 900,
        transcript: [turn('mei', 'hi', 900)],
        participants,
        zone: 'cafe',
        closeReason: 'idle',
      },
      clockAt(1, 0),
    );
    const attachedTo = store.attachReflection({
      reflectionId: 'refl-nobody',
      agentId: 'someone-else',
      summary: 'unrelated',
      sourceCount: 1,
      trigger: 'manual',
      simTime: 1100,
    });
    expect(attachedTo).toBeNull();
  });
});

describe('MomentStore disk persistence', () => {
  test('flush writes + load restores by id and sessionId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tina-moments-'));
    const participants = [
      { id: 'mei', name: 'Mei', named: true, color: null },
      { id: 'hiro', name: 'Hiro', named: true, color: null },
    ];
    const storeA = new MomentStore({
      dir,
      maxMoments: 10,
      idGenerator: mkIdSeq('x'),
      now: () => '2026-04-23T00:00:00.000Z',
    });
    const rec = storeA.captureClose(
      {
        sessionId: 's1',
        simTime: 1000,
        openedAt: 900,
        transcript: [turn('mei', 'hi', 900)],
        participants,
        zone: 'cafe',
        closeReason: 'idle',
      },
      clockAt(15, 14),
    );
    await storeA.flush();

    const body = await readFile(join(dir, MOMENT_FILE), 'utf8');
    const parsed = JSON.parse(body) as { version: number; moments: unknown[] };
    expect(parsed.version).toBe(MOMENT_RECORD_VERSION);
    expect(parsed.moments).toHaveLength(1);

    const storeB = new MomentStore({
      dir,
      maxMoments: 10,
      idGenerator: mkIdSeq('shouldnotbeused'),
    });
    await storeB.load();
    expect(storeB.count()).toBe(1);
    expect(storeB.get(rec.id)?.headline).toBe(rec.headline);
    expect(storeB.getBySession('s1')?.id).toBe(rec.id);
  });

  test('load ignores version mismatches cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tina-moments-ver-'));
    const fake: Record<string, unknown> = {
      version: 999,
      moments: [{ id: 'nope', version: 999 }],
    };
    await (await import('node:fs/promises')).writeFile(
      join(dir, MOMENT_FILE),
      JSON.stringify(fake),
      'utf8',
    );
    const store = new MomentStore({ dir });
    await store.load();
    expect(store.count()).toBe(0);
  });
});
