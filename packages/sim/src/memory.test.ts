import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ParaMemory } from './memory.js';

const fixedNow = () => new Date('2026-04-18T12:00:00Z');

async function newMemory(): Promise<{ mem: ParaMemory; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tina-mem-'));
  const mem = new ParaMemory({ root, now: fixedNow });
  return { mem, root };
}

describe('ParaMemory', () => {
  it('addFact appends facts with monotonic ids and active status', async () => {
    const { mem, root } = await newMemory();
    const a = await mem.addFact({ fact: 'met Marcus', category: 'relationship' });
    const b = await mem.addFact({ fact: 'rained at dawn' });
    expect(a.id).toBe('self-1');
    expect(b.id).toBe('self-2');
    expect(b.category).toBe('observation');
    const raw = await readFile(join(root, 'life/areas/self/items.yaml'), 'utf8');
    const parsed = parseYaml(raw);
    expect(parsed).toHaveLength(2);
  });

  it('appendDailyNote creates a dated file and appends cleanly (no null prefix)', async () => {
    const { mem, root } = await newMemory();
    await mem.appendDailyNote('walked by the cafe');
    await mem.appendDailyNote('saw Mei');
    const path = join(root, 'memory/2026-04-18.md');
    const body = await readFile(path, 'utf8');
    expect(body.startsWith('# 2026-04-18')).toBe(true);
    expect(body).not.toContain('null');
    expect(body).toContain('- walked by the cafe');
    expect(body).toContain('- saw Mei');
  });

  it('writeSummary / readSummary round-trip', async () => {
    const { mem } = await newMemory();
    await mem.writeSummary('# Ava\nHot: paints at night\n');
    expect(await mem.readSummary()).toContain('paints at night');
  });

  it('seedFromTraits only seeds when empty', async () => {
    const { mem } = await newMemory();
    await mem.seedFromTraits(['quiet', 'night owl']);
    await mem.seedFromTraits(['ignored']);
    const facts = await mem.readFacts();
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.fact)).toEqual(['quiet', 'night owl']);
  });

  it('addFact assigns category-default importance and respects overrides', async () => {
    const { mem } = await newMemory();
    const obs = await mem.addFact({ fact: 'walked by', category: 'observation' });
    const milestone = await mem.addFact({ fact: 'finished thesis', category: 'milestone' });
    const reflect = await mem.addFact({
      fact: 'spent the week at the cafe',
      category: 'reflection',
      importance: 9,
    });
    expect(obs.importance).toBe(3);
    expect(milestone.importance).toBe(8);
    expect(reflect.importance).toBe(9);
  });

  it('recallForDecision ranks reflections above stale observations', async () => {
    const { mem } = await newMemory();
    // Old observation, low importance.
    await mem.addFact({ fact: 'rained at dawn', category: 'observation' });
    // Recent reflection, high importance.
    await mem.addFact({
      fact: 'spent the week with Mei at the cafe',
      category: 'reflection',
      related_entities: ['mei-tanaka'],
    });
    const recalled = await mem.recallForDecision({ limit: 2 });
    expect(recalled).toHaveLength(2);
    expect(recalled[0]!.fact.category).toBe('reflection');
  });

  it('recallForDecision uses query relevance to break ties', async () => {
    const { mem } = await newMemory();
    await mem.addFact({ fact: 'fixed the espresso machine', category: 'observation' });
    await mem.addFact({ fact: 'painted in the studio', category: 'observation' });
    const recalled = await mem.recallForDecision({ query: 'espresso', limit: 1 });
    expect(recalled[0]!.fact.fact).toContain('espresso');
  });

  it('appendDailyNote is byte-equivalent to string-concat for 10k deferred appends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tina-mem-'));
    // Opt out of the retention cap for this byte-equivalence guard — the cap
    // is tested separately below.
    const mem = new ParaMemory({
      root,
      now: fixedNow,
      flushMode: 'deferred',
      maxDailyLines: 50_000,
    });
    const N = 10_000;
    let expected = '# 2026-04-18\n\n';
    for (let i = 0; i < N; i++) {
      const line = `entry ${i}`;
      expected += `- ${line}\n`;
      await mem.appendDailyNote(line);
    }
    await mem.flush();
    const body = await readFile(join(root, 'memory/2026-04-18.md'), 'utf8');
    expect(body).toBe(expected);
  });

  it('appendDailyNote preserves existing on-disk content when appending to a prior day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tina-mem-'));
    const existing = '# 2026-04-18\n\n- morning coffee\n- read the paper\n';
    const dailyPath = join(root, 'memory/2026-04-18.md');
    await mkdir(dirname(dailyPath), { recursive: true });
    await writeFile(dailyPath, existing, 'utf8');
    const mem = new ParaMemory({ root, now: fixedNow });
    await mem.appendDailyNote('met Mei');
    const body = await readFile(dailyPath, 'utf8');
    expect(body).toBe(`${existing}- met Mei\n`);
  });

  it('appendDailyNote allocation pattern stays linear (10k appends finish fast)', async () => {
    // Regression guard for the quadratic-buffer leak fixed under TINA-32.
    // The old implementation reallocated the full day buffer on every append,
    // so 10k deferred appends took seconds. The array-backed path should
    // finish well under a second even on slow CI.
    const root = await mkdtemp(join(tmpdir(), 'tina-mem-'));
    const mem = new ParaMemory({ root, now: fixedNow, flushMode: 'deferred' });
    const N = 10_000;
    const started = Date.now();
    for (let i = 0; i < N; i++) {
      await mem.appendDailyNote(`line ${i}`);
    }
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('addFact caps retained facts and drops dispensable oldest first (TINA-110)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tina-mem-'));
    const mem = new ParaMemory({ root, now: fixedNow, flushMode: 'deferred', maxFacts: 5 });
    await mem.addFact({ fact: 'pref-1', category: 'preference' });
    await mem.addFact({ fact: 'reflect-1', category: 'reflection' });
    await mem.addFact({ fact: 'milestone-1', category: 'milestone' });
    // Spam relationship facts — the conversation-close leaker.
    for (let i = 0; i < 20; i++) {
      await mem.addFact({ fact: `talked with peer-${i}`, category: 'relationship' });
    }
    const facts = await mem.readFacts();
    expect(facts.length).toBeLessThanOrEqual(5);
    // High-value categories must survive.
    expect(facts.some((f) => f.category === 'reflection')).toBe(true);
    expect(facts.some((f) => f.category === 'milestone')).toBe(true);
    expect(facts.some((f) => f.category === 'preference')).toBe(true);
    // Newest relationship fact must survive; oldest should be trimmed.
    expect(facts.some((f) => f.fact === 'talked with peer-19')).toBe(true);
    expect(facts.some((f) => f.fact === 'talked with peer-0')).toBe(false);
  });

  it('addFact cap survives far past cap without ballooning memory (TINA-110)', async () => {
    // Simulates the dense-chatter steady state: 2000 conversation-close fact
    // inserts into an agent memory. Post-fix, retained size stays bounded.
    const root = await mkdtemp(join(tmpdir(), 'tina-mem-'));
    const mem = new ParaMemory({ root, now: fixedNow, flushMode: 'deferred', maxFacts: 50 });
    for (let i = 0; i < 2000; i++) {
      await mem.addFact({
        fact: `talked with peer: long transcript line ${i}`,
        category: 'relationship',
      });
    }
    const facts = await mem.readFacts();
    expect(facts.length).toBeLessThanOrEqual(50);
  });

  it('addFact cap drops superseded facts before active ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tina-mem-'));
    const mem = new ParaMemory({ root, now: fixedNow, flushMode: 'deferred', maxFacts: 3 });
    const a = await mem.addFact({ fact: 'first', category: 'preference' });
    const b = await mem.addFact({ fact: 'second', category: 'preference' });
    // Supersede `a` → that entry becomes dead weight; new replacement goes in.
    await mem.supersede(a.id, {
      ...a,
      id: 'self-supersede',
      fact: 'first (revised)',
      status: 'active',
      superseded_by: null,
    });
    // Now force a trim by adding two more preferences.
    await mem.addFact({ fact: 'third', category: 'preference' });
    await mem.addFact({ fact: 'fourth', category: 'preference' });
    const facts = await mem.readFacts();
    expect(facts.length).toBeLessThanOrEqual(3);
    // Superseded fact should be gone.
    expect(facts.some((f) => f.id === a.id && f.status === 'superseded')).toBe(false);
    // The replacement should survive as it's active.
    expect(facts.some((f) => f.fact === 'first (revised)')).toBe(true);
    // `b` is the oldest active preference — trim drops oldest among the
    // remaining pool once superseded + dispensable runs out.
    expect(facts.some((f) => f.fact === 'fourth')).toBe(true);
    void b;
  });

  it('appendDailyNote caps buffered lines and keeps the header (TINA-110)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tina-mem-'));
    const mem = new ParaMemory({
      root,
      now: fixedNow,
      flushMode: 'deferred',
      maxDailyLines: 10,
    });
    for (let i = 0; i < 1000; i++) {
      await mem.appendDailyNote(`entry ${i}`);
    }
    await mem.flush();
    const body = await readFile(join(root, 'memory/2026-04-18.md'), 'utf8');
    // Header preserved.
    expect(body.startsWith('# 2026-04-18\n\n')).toBe(true);
    // Oldest entries dropped, newest retained.
    expect(body).toContain('- entry 999');
    expect(body).not.toContain('- entry 0\n');
    // Total line count stays bounded.
    const lineCount = body.split('\n').filter(Boolean).length;
    expect(lineCount).toBeLessThanOrEqual(12);
  });
});
