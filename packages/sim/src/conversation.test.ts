import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { SimulationClock } from './clock.js';
import { ConversationRegistry } from './conversation.js';
import { type MemoryFact, ParaMemory } from './memory.js';
import { Runtime, type RuntimeEvent } from './runtime.js';
import { type SkillDocument, parseSkillSource } from './skills.js';
import { World } from './world.js';

const chatty: Array<{ name: string; description: string }> = [
  { name: 'alpha', description: 'extrovert, outgoing, chatty, social' },
  { name: 'bravo', description: 'extrovert, social, chatty' },
];

function skillFor(p: { name: string; description: string }): SkillDocument {
  return parseSkillSource(
    `---\nname: ${p.name}\ndescription: ${p.description}\n---\n\n# ${p.name}\n\ntraits.\n`,
    `/virtual/${p.name}/SKILL.md`,
  );
}

interface MadeRuntime {
  runtime: Runtime;
  events: RuntimeEvent[];
  memoryRoots: string[];
}

async function makeRuntime(seed: number): Promise<MadeRuntime> {
  const events: RuntimeEvent[] = [];
  const memoryRoots: string[] = [];
  const agents = await Promise.all(
    chatty.map(async (p, i) => {
      const root = await mkdtemp(join(tmpdir(), `tina-conv-${p.name}-`));
      memoryRoots.push(root);
      return {
        skill: skillFor(p),
        memory: new ParaMemory({ root, now: () => new Date('2026-04-18T12:00:00Z') }),
        initial: { position: { x: 4 + i, y: 4 } },
      };
    }),
  );
  const clock = new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 });
  const world = new World({ width: 12, height: 12, clock });
  const runtime = new Runtime({
    agents,
    world,
    seed,
    tickMs: 100,
    speechRadius: 3,
    conversationIdleMs: 500,
    onEvent: (e) => events.push(e),
  });
  return { runtime, events, memoryRoots };
}

describe('conversation lifecycle', () => {
  it('opens a session when co-located agents exchange speech', async () => {
    const { runtime, events } = await makeRuntime(7);
    await runtime.runTicks(40);
    await runtime.flushConversations();

    const opens = events.filter((e) => e.kind === 'conversation_open');
    const closes = events.filter((e) => e.kind === 'conversation_close');
    expect(opens.length).toBeGreaterThan(0);
    expect(closes.length).toBeGreaterThanOrEqual(opens.length);
    const first = opens[0]!;
    expect(first.kind).toBe('conversation_open');
    if (first.kind === 'conversation_open') {
      expect(first.participants.sort()).toEqual(['alpha', 'bravo']);
    }
  });

  it('writes the transcript to both participants memories on close', async () => {
    const { runtime, events, memoryRoots } = await makeRuntime(9);
    await runtime.runTicks(40);
    await runtime.flushConversations();

    const close = events.find((e) => e.kind === 'conversation_close');
    expect(close).toBeTruthy();
    if (!close || close.kind !== 'conversation_close') return;
    expect(close.transcript.length).toBeGreaterThan(0);

    for (const root of memoryRoots) {
      const items = await readFile(join(root, 'life/areas/self/items.yaml'), 'utf8');
      const facts = parseYaml(items) as MemoryFact[];
      const conv = facts.find((f) => f.fact.startsWith('talked with '));
      expect(conv).toBeDefined();
      expect(conv?.category).toBe('relationship');

      const daily = await readFile(join(root, 'memory/2026-04-18.md'), 'utf8');
      expect(daily).toContain('conversation with');
    }
  });

  it('records overheard speech in listener daily notes', async () => {
    const { runtime, memoryRoots } = await makeRuntime(11);
    await runtime.runTicks(20);

    let overheard = 0;
    for (const root of memoryRoots) {
      const path = join(root, 'memory/2026-04-18.md');
      try {
        const body = await readFile(path, 'utf8');
        if (/heard .+: "/.test(body)) overheard += 1;
      } catch {
        // no daily note if agent heard nothing — not expected in this test
      }
    }
    expect(overheard).toBeGreaterThan(0);
  });

  it('closes the session once participants drift out of range', async () => {
    const events: RuntimeEvent[] = [];
    const rootA = await mkdtemp(join(tmpdir(), 'tina-conv-drift-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'tina-conv-drift-b-'));
    const now = () => new Date('2026-04-18T12:00:00Z');
    const world = new World({
      width: 40,
      height: 8,
      clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
    });
    const runtime = new Runtime({
      world,
      agents: [
        {
          skill: skillFor(chatty[0]!),
          memory: new ParaMemory({ root: rootA, now }),
          initial: { position: { x: 4, y: 4 } },
        },
        {
          skill: skillFor(chatty[1]!),
          memory: new ParaMemory({ root: rootB, now }),
          initial: { position: { x: 5, y: 4 } },
        },
      ],
      seed: 1,
      tickMs: 100,
      speechRadius: 2,
      conversationIdleMs: 10_000,
      onEvent: (e) => events.push(e),
    });

    await runtime.runTicks(6);

    for (let i = 0; i < 40; i++) {
      const alpha = runtime.listAgents().find((a) => a.def.id === 'alpha')!;
      alpha.state.position = { x: Math.min(alpha.state.position.x + 1, 39), y: 4 };
      alpha.state.gotoTarget = null;
      await runtime.tickOnce();
    }

    const open = events.find((e) => e.kind === 'conversation_open');
    const close = events.find((e) => e.kind === 'conversation_close');
    expect(open).toBeTruthy();
    expect(close).toBeTruthy();
    if (close && close.kind === 'conversation_close') {
      expect(close.reason).toBe('drifted');
    }
  });
});

describe('ConversationRegistry', () => {
  it('pair-keys are symmetric (a,b) === (b,a)', () => {
    const registry = new ConversationRegistry({ speechRadius: 2, idleTtlSim: 10 });
    const seen: string[] = [];
    registry.recordSpeech('a', 'hi', 0, ['b'], {
      onOpen: (s) => seen.push(`open:${[...s.participants].sort().join(',')}`),
    });
    registry.recordSpeech('b', 'hey', 1, ['a'], {
      onOpen: (s) => seen.push(`open:${[...s.participants].sort().join(',')}`),
    });
    expect(seen).toEqual(['open:a,b']);
    expect(registry.activeCount()).toBe(1);
  });

  it('drain emits onClose for every active session', () => {
    const registry = new ConversationRegistry({ speechRadius: 2, idleTtlSim: 10 });
    registry.recordSpeech('a', 'hi', 0, ['b'], {});
    registry.recordSpeech('c', 'hi', 0, ['d'], {});
    const closed: string[] = [];
    registry.drain({ onClose: (s) => closed.push([...s.participants].sort().join(',')) });
    expect(closed.sort()).toEqual(['a,b', 'c,d']);
    expect(registry.activeCount()).toBe(0);
  });

  it('caps transcript length so endless chatter can no longer OOM the heap', () => {
    const registry = new ConversationRegistry({
      speechRadius: 2,
      idleTtlSim: 10_000,
      maxTranscriptTurns: 5,
    });
    for (let i = 0; i < 200; i++) {
      registry.recordSpeech('a', `msg-${i}`, i, ['b'], {});
    }
    let transcriptLen = -1;
    let firstText: string | undefined;
    let lastText: string | undefined;
    registry.drain({
      onClose: (s) => {
        transcriptLen = s.transcript.length;
        firstText = s.transcript[0]?.text;
        lastText = s.transcript[s.transcript.length - 1]?.text;
      },
    });
    expect(transcriptLen).toBe(5);
    // Oldest turns dropped; most recent kept.
    expect(firstText).toBe('msg-195');
    expect(lastText).toBe('msg-199');
  });

  it("force-closes a session with reason 'aged' once it exceeds maxAgeSim, even when chatter is continuous", () => {
    const registry = new ConversationRegistry({
      speechRadius: 10,
      idleTtlSim: 100_000,
      maxAgeSim: 30,
    });
    // Keep speaking well past the age cap — idle timer never trips.
    for (let t = 0; t <= 50; t++) {
      registry.recordSpeech('a', `t${t}`, t, ['b'], {});
    }
    const positions = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 1, y: 0 }],
    ]);
    const closed: Array<{ participants: string; reason: string }> = [];
    registry.sweep(positions, 60, {
      onClose: (s, reason) =>
        closed.push({ participants: [...s.participants].sort().join(','), reason }),
    });
    expect(closed).toEqual([{ participants: 'a,b', reason: 'aged' }]);
    expect(registry.activeCount()).toBe(0);
  });
});

describe('drift helpers', () => {
  it('leaves persisted memory directories readable', async () => {
    const { memoryRoots } = await makeRuntime(3);
    for (const root of memoryRoots) {
      const info = await stat(root);
      expect(info.isDirectory()).toBe(true);
    }
  });
});
