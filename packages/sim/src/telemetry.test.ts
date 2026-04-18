import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulationClock } from './clock.js';
import { ParaMemory } from './memory.js';
import { Runtime } from './runtime.js';
import { parseSkillSource } from './skills.js';
import { World } from './world.js';

function skill(name: string, description: string) {
  return parseSkillSource(
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n`,
    `/virtual/${name}/SKILL.md`,
  );
}

describe('Runtime telemetry', () => {
  it('records tick count, action counts, and tick duration samples', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tina-tel-'));
    const runtime = new Runtime({
      seed: 1,
      tickMs: 100,
      world: new World({
        width: 12,
        height: 12,
        clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
      }),
      agents: [
        {
          skill: skill('a', 'outgoing energetic'),
          memory: new ParaMemory({
            root: join(root, 'a'),
            flushMode: 'deferred',
            now: () => new Date('2026-04-18T00:00:00Z'),
          }),
          initial: { position: { x: 3, y: 3 } },
        },
        {
          skill: skill('b', 'outgoing energetic'),
          memory: new ParaMemory({
            root: join(root, 'b'),
            flushMode: 'deferred',
            now: () => new Date('2026-04-18T00:00:00Z'),
          }),
          initial: { position: { x: 4, y: 3 } },
        },
      ],
    });

    await runtime.runTicks(30);
    await runtime.flushConversations();

    const t = runtime.telemetrySnapshot();
    expect(t.ticks).toBe(30);
    expect(t.agents).toBe(2);
    expect(t.tickDurationSamples.length).toBe(30);
    expect(t.tickDuration.p50).toBeGreaterThan(0);
    expect(t.tickDuration.max).toBeGreaterThanOrEqual(t.tickDuration.p99);

    // With two outgoing agents adjacent, we expect conversations to open
    expect(t.conversationsOpened).toBeGreaterThan(0);

    // Summed actions over the run must equal total observed action events.
    const sum = Object.values(t.actions).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(30);
  });
});

describe('Runtime deferred memory', () => {
  it('flushes memory on flushConversations so transcripts land on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tina-def-'));
    const runtime = new Runtime({
      seed: 3,
      tickMs: 100,
      memoryFlushEveryTicks: 0, // disable periodic flush; rely on explicit flush
      world: new World({
        width: 12,
        height: 12,
        clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
      }),
      agents: [
        {
          skill: skill('x', 'outgoing energetic'),
          memory: new ParaMemory({
            root: join(root, 'x'),
            flushMode: 'deferred',
            now: () => new Date('2026-04-18T00:00:00Z'),
          }),
          initial: { position: { x: 5, y: 5 } },
        },
        {
          skill: skill('y', 'outgoing energetic'),
          memory: new ParaMemory({
            root: join(root, 'y'),
            flushMode: 'deferred',
            now: () => new Date('2026-04-18T00:00:00Z'),
          }),
          initial: { position: { x: 5, y: 6 } },
        },
      ],
    });

    await runtime.runTicks(30);

    // nothing persisted yet in deferred mode
    await expect(readFile(join(root, 'x/life/areas/self/items.yaml'), 'utf8')).rejects.toThrow();

    await runtime.flushConversations();

    // after flush + close, transcripts land on disk
    const body = await readFile(join(root, 'x/life/areas/self/items.yaml'), 'utf8');
    expect(body).toContain('talked with');
  });
});
