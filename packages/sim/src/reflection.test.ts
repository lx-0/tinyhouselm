import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ParaMemory } from './memory.js';
import { ReflectionEngine } from './reflection.js';

const SECONDS_PER_DAY = 86400;

async function newMemory(now = () => new Date('2026-04-21T12:00:00Z')) {
  const root = await mkdtemp(join(tmpdir(), 'tina-refl-'));
  return new ParaMemory({ root, now });
}

describe('ReflectionEngine', () => {
  it('does not fire on the very first call (no prior bookmark)', async () => {
    const mem = await newMemory();
    const engine = new ReflectionEngine();
    for (let i = 0; i < 8; i++) {
      const f = await mem.addFact({ fact: `event ${i}`, category: 'observation' });
      engine.noteNewFact(f);
    }
    const out = await engine.maybeReflect({ memory: mem, simTime: 0 });
    expect(out).toBeNull();
  });

  it('fires on day rollover and writes a reflection back to memory', async () => {
    const mem = await newMemory();
    const engine = new ReflectionEngine({ minFacts: 3 });
    // Bookmark day 0.
    await engine.maybeReflect({ memory: mem, simTime: 0 });

    for (let i = 0; i < 6; i++) {
      const f = await mem.addFact({
        fact: `bumped into Mei in the cafe (${i})`,
        category: 'relationship',
        related_entities: ['mei-tanaka'],
      });
      engine.noteNewFact(f);
    }

    const out = await engine.maybeReflect({ memory: mem, simTime: SECONDS_PER_DAY + 5 });
    expect(out).not.toBeNull();
    expect(out!.trigger).toBe('day_rollover');
    expect(out!.reflection.category).toBe('reflection');
    expect(out!.reflection.importance).toBeGreaterThanOrEqual(7);
    expect(out!.reflection.related_entities).toContain('mei-tanaka');
    expect(out!.sourceFactIds.length).toBeGreaterThan(0);

    const reflections = await mem.recentReflections(5);
    expect(reflections).toHaveLength(1);
  });

  it('fires mid-day when importance budget is exceeded', async () => {
    const mem = await newMemory();
    const engine = new ReflectionEngine({ importanceBudget: 20, minFacts: 3 });
    await engine.maybeReflect({ memory: mem, simTime: 0 });

    // 4 milestones at importance 8 = 32, well over 20.
    for (let i = 0; i < 4; i++) {
      const f = await mem.addFact({
        fact: `milestone ${i} — finished a draft`,
        category: 'milestone',
      });
      engine.noteNewFact(f);
    }
    const out = await engine.maybeReflect({ memory: mem, simTime: 100 });
    expect(out).not.toBeNull();
    expect(out!.trigger).toBe('importance_budget');
  });

  it('skips when there are not enough new raw facts since last reflection', async () => {
    const mem = await newMemory();
    const engine = new ReflectionEngine({ minFacts: 5 });
    await engine.maybeReflect({ memory: mem, simTime: 0 });

    for (let i = 0; i < 2; i++) {
      const f = await mem.addFact({ fact: `tiny ${i}`, category: 'observation' });
      engine.noteNewFact(f);
    }
    const out = await engine.maybeReflect({ memory: mem, simTime: SECONDS_PER_DAY + 1 });
    expect(out).toBeNull();
  });

  it('does not include reflection facts in subsequent synthesis windows', async () => {
    const mem = await newMemory();
    const engine = new ReflectionEngine({ minFacts: 3 });
    await engine.maybeReflect({ memory: mem, simTime: 0 });

    for (let i = 0; i < 5; i++) {
      const f = await mem.addFact({ fact: `event ${i}`, category: 'observation' });
      engine.noteNewFact(f);
    }
    const first = await engine.maybeReflect({ memory: mem, simTime: SECONDS_PER_DAY + 1 });
    expect(first).not.toBeNull();

    for (let i = 0; i < 5; i++) {
      const f = await mem.addFact({ fact: `later ${i}`, category: 'observation' });
      engine.noteNewFact(f);
    }
    const second = await engine.maybeReflect({ memory: mem, simTime: 2 * SECONDS_PER_DAY + 1 });
    expect(second).not.toBeNull();
    expect(second!.sourceFactIds.every((id) => id !== first!.reflection.id)).toBe(true);
  });
});
