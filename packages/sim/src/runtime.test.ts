import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulationClock } from './clock.js';
import type { HeartbeatPolicy } from './heartbeat.js';
import { ParaMemory } from './memory.js';
import { Runtime, type RuntimeEvent } from './runtime.js';
import { type SkillDocument, parseSkillSource } from './skills.js';
import { World } from './world.js';

const silentPolicy: HeartbeatPolicy = {
  async decide() {
    return [];
  },
};

const personas: Array<{ name: string; description: string }> = [
  { name: 'alpha', description: 'extrovert, energetic, social' },
  { name: 'bravo', description: 'introvert, quiet, slow' },
  { name: 'charlie', description: 'curious, steady' },
];

function skillFor(p: { name: string; description: string }): SkillDocument {
  return parseSkillSource(
    `---\nname: ${p.name}\ndescription: ${p.description}\n---\n\n# ${p.name}\n\ntraits.\n`,
    `/virtual/${p.name}/SKILL.md`,
  );
}

async function makeRuntime(seed: number): Promise<{ runtime: Runtime; events: RuntimeEvent[] }> {
  const events: RuntimeEvent[] = [];
  const agents = await Promise.all(
    personas.map(async (p, i) => {
      const root = await mkdtemp(join(tmpdir(), `tina-mem-${p.name}-`));
      return {
        skill: skillFor(p),
        memory: new ParaMemory({ root, now: () => new Date('2026-04-18T00:00:00Z') }),
        initial: { position: { x: 4 + i * 3, y: 4 } },
      };
    }),
  );
  const clock = new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 });
  const world = new World({ width: 16, height: 16, clock });
  const runtime = new Runtime({
    agents,
    world,
    seed,
    tickMs: 100,
    onEvent: (e) => events.push(e),
  });
  return { runtime, events };
}

function actionKey(e: RuntimeEvent): string {
  if (e.kind !== 'action') return e.kind;
  const action = e.action;
  switch (action.kind) {
    case 'move_to':
      return `${e.tick}:${e.agentId}:move:${action.to.x},${action.to.y}`;
    case 'goto':
      return `${e.tick}:${e.agentId}:goto:${action.target.x},${action.target.y}`;
    case 'speak':
      return `${e.tick}:${e.agentId}:speak:${action.text}`;
    case 'remember':
      return `${e.tick}:${e.agentId}:remember:${action.fact}`;
    case 'wait':
      return `${e.tick}:${e.agentId}:wait`;
    case 'set_goal':
      return `${e.tick}:${e.agentId}:goal`;
  }
}

describe('Runtime', () => {
  it('runs 50+ ticks for 3 personas without throwing and produces actions', async () => {
    const { runtime, events } = await makeRuntime(7);
    await runtime.runTicks(60);
    const ticks = events.filter((e) => e.kind === 'tick').length;
    const actions = events.filter((e) => e.kind === 'action');
    expect(ticks).toBe(60);
    expect(actions.length).toBeGreaterThan(60);
    expect(actions.some((e) => e.kind === 'action' && e.action.kind === 'speak')).toBe(true);
    expect(actions.some((e) => e.kind === 'action' && e.action.kind === 'move_to')).toBe(true);
  });

  it('is deterministic for identical seed + inputs', async () => {
    const a = await makeRuntime(42);
    const b = await makeRuntime(42);
    await a.runtime.runTicks(50);
    await b.runtime.runTicks(50);
    const keysA = a.events.filter((e) => e.kind === 'action').map(actionKey);
    const keysB = b.events.filter((e) => e.kind === 'action').map(actionKey);
    expect(keysA).toEqual(keysB);
  });

  it('agents stay within world bounds', async () => {
    const { runtime } = await makeRuntime(11);
    await runtime.runTicks(80);
    for (const agent of runtime.listAgents()) {
      expect(agent.state.position.x).toBeGreaterThanOrEqual(0);
      expect(agent.state.position.x).toBeLessThan(16);
      expect(agent.state.position.y).toBeGreaterThanOrEqual(0);
      expect(agent.state.position.y).toBeLessThan(16);
    }
  });

  it('speech within speechRadius shows up in heardBy', async () => {
    const { runtime, events } = await makeRuntime(3);
    await runtime.runTicks(80);
    const heardSomeone = events.some(
      (e) => e.kind === 'action' && e.action.kind === 'speak' && (e.heardBy?.length ?? 0) > 0,
    );
    expect(heardSomeone).toBe(true);
  });

  it('goto moves the agent one step per tick until arrival', async () => {
    const events: RuntimeEvent[] = [];
    const root = await mkdtemp(join(tmpdir(), 'tina-goto-'));
    const world = new World({
      width: 16,
      height: 16,
      clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
    });
    const runtime = new Runtime({
      world,
      policy: silentPolicy,
      agents: [
        {
          skill: skillFor({ name: 'solo', description: 'quiet tired sedentary' }),
          memory: new ParaMemory({
            root,
            now: () => new Date('2026-04-18T00:00:00Z'),
          }),
          initial: { position: { x: 2, y: 2 }, gotoTarget: { x: 7, y: 2 } },
        },
      ],
      seed: 5,
      tickMs: 100,
      onEvent: (e) => events.push(e),
    });

    const trace: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 10; i++) {
      await runtime.tickOnce();
      const solo = runtime.listAgents()[0]!;
      trace.push({ ...solo.state.position });
    }

    const solo = runtime.listAgents()[0]!;
    expect(solo.state.position).toEqual({ x: 7, y: 2 });
    expect(solo.state.gotoTarget).toBeNull();
    // one step per tick, monotonically, until arrival
    expect(trace[0]).toEqual({ x: 3, y: 2 });
    expect(trace[4]).toEqual({ x: 7, y: 2 });
    expect(trace[5]).toEqual({ x: 7, y: 2 });
  });
});
