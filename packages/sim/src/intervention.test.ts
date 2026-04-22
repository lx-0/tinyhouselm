import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulationClock } from './clock.js';
import type { HeartbeatPolicy } from './heartbeat.js';
import { ParaMemory } from './memory.js';
import { Runtime, type RuntimeEvent } from './runtime.js';
import { parseSkillSource } from './skills.js';
import { World } from './world.js';

const silentPolicy: HeartbeatPolicy = {
  async decide() {
    return [];
  },
};

async function makeRuntime(opts: {
  personas: Array<{ id: string; position: { x: number; y: number } }>;
  zones?: Array<{ name: string; x: number; y: number; width: number; height: number }>;
}): Promise<{ runtime: Runtime; events: RuntimeEvent[] }> {
  const events: RuntimeEvent[] = [];
  const world = new World({
    width: 16,
    height: 16,
    clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
    zones: opts.zones,
  });
  const agents = await Promise.all(
    opts.personas.map(async (p) => ({
      skill: parseSkillSource(
        `---\nname: ${p.id}\ndescription: steady quiet\n---\n\n# ${p.id}\n`,
        `/virtual/${p.id}/SKILL.md`,
      ),
      memory: new ParaMemory({
        root: await mkdtemp(join(tmpdir(), `tina-intr-${p.id}-`)),
        now: () => new Date('2026-04-18T00:00:00Z'),
      }),
      initial: { position: { ...p.position } },
    })),
  );
  const runtime = new Runtime({
    agents,
    world,
    policy: silentPolicy,
    seed: 1,
    tickMs: 100,
    reflections: false,
    memoryFlushEveryTicks: 0,
    onEvent: (e) => events.push(e),
  });
  return { runtime, events };
}

describe('Runtime interventions', () => {
  it('injectWhisper reaches exactly one agent and triggers plan_replan with reason=whisper', async () => {
    const { runtime, events } = await makeRuntime({
      personas: [
        { id: 'alpha', position: { x: 2, y: 2 } },
        { id: 'bravo', position: { x: 10, y: 10 } },
      ],
    });
    await runtime.runTicks(1);
    runtime.injectWhisper({ agentId: 'alpha', text: 'Mei is looking for you' });
    await runtime.runTicks(1);

    const replans = events.filter((e) => e.kind === 'plan_replan');
    const alphaReplans = replans.filter((e) => e.kind === 'plan_replan' && e.agentId === 'alpha');
    const bravoReplans = replans.filter((e) => e.kind === 'plan_replan' && e.agentId === 'bravo');
    expect(alphaReplans.length).toBeGreaterThan(0);
    expect(alphaReplans[0]).toMatchObject({ reason: 'whisper' });
    expect(bravoReplans.length).toBe(0);

    const mem = await runtime.listAgents().find((a) => a.def.id === 'alpha')!;
    // Memory fact tagged with intervention source
    const memory = (runtime as unknown as { memories: Map<string, ParaMemory> }).memories.get(
      mem.def.id,
    );
    if (!memory) throw new Error('memory missing');
    const facts = await memory.readFacts();
    const whisperFact = facts.find((f) => f.source === 'intervention:whisper');
    expect(whisperFact).toBeDefined();
    expect(whisperFact!.fact).toContain('Mei is looking for you');
  });

  it('injectWorldEvent with a zone only reaches agents inside that zone', async () => {
    const { runtime, events } = await makeRuntime({
      personas: [
        { id: 'inside', position: { x: 1, y: 1 } },
        { id: 'outside', position: { x: 10, y: 10 } },
      ],
      zones: [{ name: 'cafe', x: 0, y: 0, width: 4, height: 4 }],
    });
    await runtime.runTicks(1);
    const result = runtime.injectWorldEvent({ text: 'a fire starts', zone: 'cafe' });
    expect(result.affected).toEqual(['inside']);
    await runtime.runTicks(1);

    const replans = events.filter((e) => e.kind === 'plan_replan');
    const insideReplans = replans.filter((e) => e.kind === 'plan_replan' && e.agentId === 'inside');
    const outsideReplans = replans.filter(
      (e) => e.kind === 'plan_replan' && e.agentId === 'outside',
    );
    expect(insideReplans.length).toBeGreaterThan(0);
    expect(insideReplans[0]).toMatchObject({ reason: 'intervention:world_event' });
    expect(outsideReplans.length).toBe(0);
  });

  it('dropObject adds to world, emits object_add, and nearby agents replan', async () => {
    const { runtime, events } = await makeRuntime({
      personas: [
        { id: 'near', position: { x: 4, y: 4 } },
        { id: 'far', position: { x: 14, y: 14 } },
      ],
    });
    await runtime.runTicks(1);
    const result = runtime.dropObject({
      label: 'old letter',
      pos: { x: 5, y: 5 },
    });
    expect(runtime.world.listObjects().map((o) => o.id)).toContain(result.object.id);
    const deltas = runtime.world.drainDeltas();
    expect(deltas.some((d) => d.kind === 'object_add' && d.object.id === result.object.id)).toBe(
      true,
    );
    await runtime.runTicks(1);

    const nearReplans = events.filter((e) => e.kind === 'plan_replan' && e.agentId === 'near');
    const farReplans = events.filter((e) => e.kind === 'plan_replan' && e.agentId === 'far');
    expect(nearReplans.length).toBeGreaterThan(0);
    expect(nearReplans[0]).toMatchObject({ reason: 'intervention:object_drop' });
    expect(farReplans.length).toBe(0);
  });

  it('removeObject removes from world, emits object_remove, and nearby agents observe', async () => {
    const { runtime, events } = await makeRuntime({
      personas: [{ id: 'watcher', position: { x: 5, y: 5 } }],
    });
    await runtime.runTicks(1);
    const drop = runtime.dropObject({
      id: 'rm-test',
      label: 'strange book',
      pos: { x: 4, y: 5 },
    });
    await runtime.runTicks(1);
    // Clear the drop-triggered deltas so we can assert only on the remove.
    runtime.world.drainDeltas();
    const removed = runtime.removeObject({ id: drop.object.id });
    expect(removed.affected).toEqual(['watcher']);
    expect(runtime.world.getObject(drop.object.id)).toBeNull();
    const after = runtime.world.drainDeltas();
    expect(after.some((d) => d.kind === 'object_remove' && d.id === drop.object.id)).toBe(true);
    await runtime.runTicks(1);

    const removeReplans = events.filter(
      (e) =>
        e.kind === 'plan_replan' &&
        e.agentId === 'watcher' &&
        e.reason === 'intervention:object_remove',
    );
    expect(removeReplans.length).toBeGreaterThan(0);
  });

  it('whisper validation: empty text + unknown agent fail loudly', async () => {
    const { runtime } = await makeRuntime({
      personas: [{ id: 'alpha', position: { x: 1, y: 1 } }],
    });
    expect(() => runtime.injectWhisper({ agentId: 'alpha', text: '  ' })).toThrow();
    expect(() => runtime.injectWhisper({ agentId: 'ghost', text: 'hi' })).toThrow();
  });

  it('end-to-end: whisper drives a replan + memory fact within runTicks(3)', async () => {
    const { runtime, events } = await makeRuntime({
      personas: [{ id: 'target', position: { x: 3, y: 3 } }],
    });
    runtime.injectWhisper({ agentId: 'target', text: 'the bridge is out' });
    await runtime.runTicks(3);

    const replans = events.filter(
      (e) => e.kind === 'plan_replan' && e.agentId === 'target' && e.reason === 'whisper',
    );
    expect(replans.length).toBe(1);

    const memory = (runtime as unknown as { memories: Map<string, ParaMemory> }).memories.get(
      'target',
    );
    if (!memory) throw new Error('memory missing');
    const facts = await memory.readFacts();
    const fact = facts.find((f) => f.source === 'intervention:whisper');
    expect(fact?.fact).toContain('the bridge is out');
  });
});
