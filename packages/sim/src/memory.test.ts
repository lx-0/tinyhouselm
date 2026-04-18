import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
