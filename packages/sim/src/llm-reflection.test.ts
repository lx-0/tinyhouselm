import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLlmSynthesizer } from './llm-reflection.js';
import { type MemoryFact, ParaMemory } from './memory.js';
import { ReflectionEngine } from './reflection.js';

const SECONDS_PER_DAY = 86400;

async function seedMemory(): Promise<ParaMemory> {
  const root = await mkdtemp(join(tmpdir(), 'tina-llm-refl-'));
  const mem = new ParaMemory({ root, now: () => new Date('2026-04-21T12:00:00Z'), entity: 'mei' });
  for (let i = 0; i < 8; i++) {
    await mem.addFact({
      fact: `morning shift felt tense; dropped an order near Bruno (${i})`,
      category: 'relationship',
      related_entities: ['bruno-costa'],
    });
  }
  return mem;
}

function mockFetchReturning(
  body: unknown,
  { status = 200 }: { status?: number } = {},
): typeof fetch {
  return vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

describe('createLlmSynthesizer', () => {
  it('parses bulleted output into reflection bullets with source fact ids and records cost', async () => {
    const mem = await seedMemory();
    const facts = await mem.readFacts();
    const validIds = facts.map((f) => f.id);

    const recorded: Array<{ usd: number; note?: string }> = [];
    const budget = {
      record: (usd: number, note?: string) => {
        recorded.push({ usd, note });
      },
      exhausted: () => false,
    };

    const fetchImpl = mockFetchReturning({
      content: [
        {
          type: 'text',
          text: `- I feel anxious around bruno-costa in the cafe during the rush [ids: ${validIds[0]}, ${validIds[1]}]
- My morning energy is consistently drained by back-to-back orders [ids: ${validIds[2]}, ${validIds[3]}]
- I find late mornings calmer once the rush is over [ids: ${validIds[4]}]`,
        },
      ],
      usage: { input_tokens: 600, output_tokens: 120 },
    });

    const synth = createLlmSynthesizer({
      apiKey: 'sk-test',
      budget,
      fetchImpl,
      log: () => {},
    });

    const bullets = await synth.synthesize(facts, {
      entity: 'mei',
      trigger: 'day_rollover',
      day: 1,
    });
    expect(bullets).toHaveLength(3);
    expect(bullets[0]!.text).toContain('anxious');
    expect(bullets[0]!.sourceFactIds!.length).toBeGreaterThan(0);
    expect(bullets[0]!.sourceFactIds!.every((id) => validIds.includes(id))).toBe(true);
    expect(bullets[0]!.entities).toContain('bruno-costa');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.usd).toBeGreaterThan(0);
    expect(recorded[0]!.usd).toBeLessThan(0.01);
  });

  it('falls back to deterministic when the budget is exhausted (no HTTP call)', async () => {
    const mem = await seedMemory();
    const facts = await mem.readFacts();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const synth = createLlmSynthesizer({
      apiKey: 'sk-test',
      budget: { record: () => {}, exhausted: () => true },
      fetchImpl,
      log: () => {},
    });
    const bullets = await synth.synthesize(facts, { entity: 'mei', trigger: 'manual', day: 0 });
    expect(bullets.length).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to deterministic on HTTP error', async () => {
    const mem = await seedMemory();
    const facts = await mem.readFacts();
    const fetchImpl = mockFetchReturning('bad gateway', { status: 502 });
    const synth = createLlmSynthesizer({
      apiKey: 'sk-test',
      fetchImpl,
      log: () => {},
    });
    const bullets = await synth.synthesize(facts, { entity: 'mei', trigger: 'manual', day: 0 });
    expect(bullets.length).toBeGreaterThan(0); // fell back
  });

  it('integrates with ReflectionEngine to write multiple bullets with evidence pointers', async () => {
    const mem = await seedMemory();
    const factsBefore = await mem.readFacts();
    const firstId = factsBefore[0]!.id;
    const secondId = factsBefore[1]!.id;
    const fetchImpl = mockFetchReturning({
      content: [
        {
          type: 'text',
          text: `- Feeling anxious around bruno-costa when the cafe gets busy [ids: ${firstId}, ${secondId}]
- Tend to slow down after the first rush is over [ids: ${secondId}]`,
        },
      ],
      usage: { input_tokens: 300, output_tokens: 60 },
    });
    const synth = createLlmSynthesizer({ apiKey: 'sk', fetchImpl, log: () => {} });

    const engine = new ReflectionEngine({ synthesizer: synth, minFacts: 3 });
    await engine.maybeReflect({ memory: mem, simTime: 0 }); // bookmark
    const out = await engine.maybeReflect({ memory: mem, simTime: SECONDS_PER_DAY + 1 });
    expect(out).not.toBeNull();
    expect(out!.reflections.length).toBe(2);
    expect(out!.reflections[0]!.category).toBe('reflection');
    expect(out!.reflections[0]!.derived_from!.length).toBeGreaterThan(0);
    expect(out!.reflections[0]!.source).toContain('llm');

    const stored: MemoryFact[] = await mem.recentReflections(10);
    expect(stored.length).toBe(2);
  });
});
