import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGatewaySynthesizer } from './llm-gateway.js';
import { type MemoryFact, ParaMemory } from './memory.js';
import { ReflectionEngine } from './reflection.js';

const SECONDS_PER_DAY = 86400;

async function seedMemory(): Promise<ParaMemory> {
  const root = await mkdtemp(join(tmpdir(), 'tina-gateway-refl-'));
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

describe('createGatewaySynthesizer', () => {
  it('posts OpenAI-shaped chat completions to the gateway with Bearer auth', async () => {
    const mem = await seedMemory();
    const facts = await mem.readFacts();
    const firstId = facts[0]!.id;

    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: `- I feel anxious around bruno-costa during the rush [ids: ${firstId}]
- My mornings drain me [ids: ${firstId}]`,
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;

    const synth = createGatewaySynthesizer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.yester.cloud/v1',
      model: 'cheap',
      fetchImpl,
      log: () => {},
    });

    const bullets = await synth.synthesize(facts, {
      entity: 'mei',
      trigger: 'day_rollover',
      day: 1,
    });
    expect(bullets.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://llm.yester.cloud/v1/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('cheap');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
  });

  it('parses bulleted content into reflection bullets and records cost via tier pricing', async () => {
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
      choices: [
        {
          message: {
            role: 'assistant',
            content: `- I feel anxious around bruno-costa in the cafe during the rush [ids: ${validIds[0]}, ${validIds[1]}]
- My morning energy is consistently drained by back-to-back orders [ids: ${validIds[2]}, ${validIds[3]}]
- I find late mornings calmer once the rush is over [ids: ${validIds[4]}]`,
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 600, completion_tokens: 120, total_tokens: 720 },
    });

    const synth = createGatewaySynthesizer({
      apiKey: 'sk-test',
      model: 'default',
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
    // default tier: 600*0.6/1e6 + 120*2.2/1e6 ≈ $0.000624
    expect(recorded[0]!.usd).toBeGreaterThan(0);
    expect(recorded[0]!.usd).toBeLessThan(0.01);
  });

  it('falls back to deterministic when the budget is exhausted (no HTTP call)', async () => {
    const mem = await seedMemory();
    const facts = await mem.readFacts();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const synth = createGatewaySynthesizer({
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
    const synth = createGatewaySynthesizer({
      apiKey: 'sk-test',
      fetchImpl,
      log: () => {},
    });
    const bullets = await synth.synthesize(facts, { entity: 'mei', trigger: 'manual', day: 0 });
    expect(bullets.length).toBeGreaterThan(0);
  });

  it('integrates with ReflectionEngine to write multiple bullets with evidence pointers', async () => {
    const mem = await seedMemory();
    const factsBefore = await mem.readFacts();
    const firstId = factsBefore[0]!.id;
    const secondId = factsBefore[1]!.id;
    const fetchImpl = mockFetchReturning({
      choices: [
        {
          message: {
            role: 'assistant',
            content: `- Feeling anxious around bruno-costa when the cafe gets busy [ids: ${firstId}, ${secondId}]
- Tend to slow down after the first rush is over [ids: ${secondId}]`,
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 300, completion_tokens: 60, total_tokens: 360 },
    });
    const synth = createGatewaySynthesizer({ apiKey: 'sk', fetchImpl, log: () => {} });

    const engine = new ReflectionEngine({ synthesizer: synth, minFacts: 3 });
    await engine.maybeReflect({ memory: mem, simTime: 0 });
    const out = await engine.maybeReflect({ memory: mem, simTime: SECONDS_PER_DAY + 1 });
    expect(out).not.toBeNull();
    expect(out!.reflections.length).toBe(2);
    expect(out!.reflections[0]!.category).toBe('reflection');
    expect(out!.reflections[0]!.derived_from!.length).toBeGreaterThan(0);
    expect(out!.reflections[0]!.source).toContain('llm-gateway');

    const stored: MemoryFact[] = await mem.recentReflections(10);
    expect(stored.length).toBe(2);
  });
});
