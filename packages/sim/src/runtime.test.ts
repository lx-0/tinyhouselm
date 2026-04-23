import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAction } from '@tina/shared';
import { describe, expect, it } from 'vitest';
import { SimulationClock } from './clock.js';
import type { HeartbeatPolicy } from './heartbeat.js';
import { ParaMemory } from './memory.js';
import { Runtime, type RuntimeEvent } from './runtime.js';
import { type SkillDocument, parseSkillSource } from './skills.js';
import { blankMap, setTile } from './tilemap.js';
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

  it('commits a day plan for each agent on the first tick', async () => {
    const { runtime, events } = await makeRuntime(5);
    await runtime.runTicks(2);
    const committed = events.filter((e) => e.kind === 'plan_committed');
    expect(committed).toHaveLength(personas.length);
    for (const ev of committed) {
      if (ev.kind !== 'plan_committed') continue;
      expect(ev.day).toBe(0);
      expect(ev.summary.length).toBeGreaterThan(10);
      expect(ev.tick).toBe(0);
    }
  });

  it('suspends & resumes the listener when a nearby agent speaks', async () => {
    const events: RuntimeEvent[] = [];
    const world = new World({
      width: 16,
      height: 16,
      clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
      zones: [{ name: 'cafe', x: 0, y: 0, width: 4, height: 4 }],
    });

    // listener drives itself — extrovert so the plan always wants to head to
    // the cafe on the first tick. Speaker is scripted to speak on tick 2 and
    // then go silent.
    const listenerRoot = await mkdtemp(join(tmpdir(), 'tina-listener-'));
    const speakerRoot = await mkdtemp(join(tmpdir(), 'tina-speaker-'));

    const scriptedSpeaker: HeartbeatPolicy = {
      async decide(ctx) {
        if (ctx.persona.id !== 'speaker') return [{ kind: 'wait', seconds: 1 }];
        if (ctx.perception.tick === 2) {
          return [{ kind: 'speak', to: null, text: 'hey, got a sec?' }];
        }
        return [{ kind: 'wait', seconds: 1 }];
      },
    };

    // We need both plan-driven listener and scripted speaker. Route decisions
    // to the right policy per agent.
    const fanout: HeartbeatPolicy = {
      async decide(ctx) {
        if (ctx.persona.id === 'speaker') return scriptedSpeaker.decide(ctx);
        // Listener: use plan. If suspended, reply once. Otherwise idle —
        // we only care about plan_replan / plan_resume emission.
        if (ctx.suspended === 'conversation') {
          return [{ kind: 'speak', to: null, text: 'hey.' }];
        }
        return [{ kind: 'wait', seconds: 1 }] as AgentAction[];
      },
    };

    const runtime = new Runtime({
      world,
      policy: fanout,
      agents: [
        {
          skill: parseSkillSource(
            '---\nname: listener\ndescription: extrovert social energetic\n---\n\n# Listener\n',
            '/virtual/listener/SKILL.md',
          ),
          memory: new ParaMemory({
            root: listenerRoot,
            now: () => new Date('2026-04-18T00:00:00Z'),
          }),
          initial: { position: { x: 8, y: 8 } },
        },
        {
          skill: parseSkillSource(
            '---\nname: speaker\ndescription: outgoing\n---\n\n# Speaker\n',
            '/virtual/speaker/SKILL.md',
          ),
          memory: new ParaMemory({
            root: speakerRoot,
            now: () => new Date('2026-04-18T00:00:00Z'),
          }),
          initial: { position: { x: 9, y: 8 } },
        },
      ],
      seed: 99,
      tickMs: 100,
      onEvent: (e) => events.push(e),
    });

    // Tick 0–2: speaker stays silent. On tick 2 it speaks — runtime sees it
    // on tick 3 via recentSpeech, triggering plan_replan for the listener.
    await runtime.runTicks(5);

    const replans = events.filter((e) => e.kind === 'plan_replan' && e.agentId === 'listener');
    expect(replans.length).toBeGreaterThan(0);
    expect(replans[0]).toMatchObject({ reason: 'conversation' });

    // Move speaker far away so listener isolates; replay enough ticks for the
    // recentSpeech window to expire (speechTtlMs=2000, tickMs=100).
    runtime.listAgents().find((a) => a.def.id === 'speaker')!.state.position = {
      x: 0,
      y: 0,
    };
    await runtime.runTicks(40);

    const resumes = events.filter((e) => e.kind === 'plan_resume' && e.agentId === 'listener');
    expect(resumes.length).toBeGreaterThan(0);
    expect(resumes[0]).toMatchObject({ reason: 'conversation_ended' });
  });

  it('writes a reflection when remember actions push past the importance budget', async () => {
    const events: RuntimeEvent[] = [];
    const root = await mkdtemp(join(tmpdir(), 'tina-refl-'));
    const world = new World({
      width: 16,
      height: 16,
      clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
    });
    const rememberPolicy: HeartbeatPolicy = {
      async decide(ctx) {
        return [
          { kind: 'remember', fact: `noticed thing ${ctx.perception.tick}` },
        ] satisfies AgentAction[];
      },
    };
    const runtime = new Runtime({
      world,
      policy: rememberPolicy,
      agents: [
        {
          skill: parseSkillSource(
            '---\nname: thinker\ndescription: thoughtful introvert\n---\n\n# Thinker\n',
            '/virtual/thinker/SKILL.md',
          ),
          memory: new ParaMemory({
            root,
            now: () => new Date('2026-04-18T00:00:00Z'),
          }),
          initial: { position: { x: 4, y: 4 } },
        },
      ],
      seed: 1,
      tickMs: 100,
      reflections: { importanceBudget: 15, minFacts: 4 },
      onEvent: (e) => events.push(e),
    });

    await runtime.runTicks(20);
    await runtime.awaitReflections();

    const reflections = events.filter((e) => e.kind === 'reflection_written');
    expect(reflections.length).toBeGreaterThan(0);
    const first = reflections[0]!;
    if (first.kind !== 'reflection_written') throw new Error('typeguard');
    expect(first.trigger).toBe('importance_budget');
    expect(first.sourceCount).toBeGreaterThanOrEqual(4);
    expect(runtime.telemetrySnapshot().reflectionsWritten).toBe(reflections.length);
  });

  it('does not block the tick loop on slow reflection synthesis', async () => {
    // Regression: TINA-21. Synchronously awaiting the reflection synthesizer
    // inside tickOnce caused a hung LLM call to stall the entire sim. With
    // the fire-and-forget fix, a synthesizer that never resolves must not
    // prevent the next tick from advancing.
    const root = await mkdtemp(join(tmpdir(), 'tina-refl-nonblock-'));
    const world = new World({
      width: 16,
      height: 16,
      clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
    });
    let synthCalls = 0;
    const neverResolves = new Promise<never>(() => {}); // never settles
    const rememberPolicy: HeartbeatPolicy = {
      async decide(ctx) {
        return [
          { kind: 'remember', fact: `noticed thing ${ctx.perception.tick}` },
        ] satisfies AgentAction[];
      },
    };
    const runtime = new Runtime({
      world,
      policy: rememberPolicy,
      agents: [
        {
          skill: parseSkillSource(
            '---\nname: stallwatcher\ndescription: a thinker\n---\n\n# Stallwatcher\n',
            '/virtual/stallwatcher/SKILL.md',
          ),
          memory: new ParaMemory({
            root,
            now: () => new Date('2026-04-18T00:00:00Z'),
          }),
          initial: { position: { x: 4, y: 4 } },
        },
      ],
      seed: 1,
      tickMs: 100,
      reflections: {
        importanceBudget: 5,
        minFacts: 2,
        synthesizer: {
          label: 'stalling',
          synthesize: async () => {
            synthCalls += 1;
            // Simulate a hung LLM call — this promise never resolves. Before
            // the fix this would deadlock the tick loop.
            await neverResolves;
            return [];
          },
        },
      },
    });

    // Race runTicks(20) against a 2s wall timeout. With the fix, ticks
    // complete almost instantly because reflection is fire-and-forget.
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 2_000).unref?.(),
    );
    const result = await Promise.race([runtime.runTicks(20).then(() => 'done' as const), timeout]);
    expect(result).toBe('done');
    expect(runtime.telemetrySnapshot().ticks).toBe(20);
    expect(synthCalls).toBeGreaterThan(0);
    // We do NOT await runtime.awaitReflections here because the synthesizer
    // never resolves; the sim must still tick past it.
  });

  it('does not block the tick loop when many conversations close on the same tick (TINA-22)', async () => {
    // Regression: a mass-aged-close burst (e.g. ~2000 sessions all hitting
    // maxAgeSim on the same tick) used to await thousands of disk writes
    // synchronously inside `sweepConversations`, stalling the sim. With the
    // fire-and-forget persistConversation fix, the tick loop must complete
    // even when persistence is artificially slow.
    const personasN = 6;
    const agents = await Promise.all(
      Array.from({ length: personasN }, async (_, i) => {
        const root = await mkdtemp(join(tmpdir(), `tina-mass-close-${i}-`));
        const mem = new ParaMemory({
          root,
          now: () => new Date('2026-04-18T00:00:00Z'),
        });
        // Slow disk: every fact write awaits ~250ms. With N×(N-1) sessions
        // closing at once and pre-fix awaited disk writes, runTicks(5) would
        // exceed the wall timeout. With fire-and-forget persistence, ticks
        // sail through.
        const origAdd = mem.addFact.bind(mem);
        mem.addFact = async (input) => {
          await new Promise((r) => setTimeout(r, 250));
          return origAdd(input);
        };
        return {
          skill: parseSkillSource(
            `---\nname: chatter${i}\ndescription: chatty social\n---\n\n# Chatter${i}\n`,
            `/virtual/chatter${i}/SKILL.md`,
          ),
          memory: mem,
          initial: { position: { x: 4 + i, y: 4 } },
        };
      }),
    );
    // Aggressive close: maxAgeSim well below the simTime that runTicks(5) reaches.
    const world = new World({
      width: 16,
      height: 16,
      clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
    });
    const speakingPolicy: HeartbeatPolicy = {
      async decide() {
        return [{ kind: 'speak', to: null, text: 'hi' }] satisfies AgentAction[];
      },
    };
    const runtime = new Runtime({
      world,
      policy: speakingPolicy,
      agents,
      seed: 7,
      tickMs: 100,
      speechRadius: 32,
      conversationIdleMs: 600_000,
      conversationMaxAgeMs: 10,
      conversationMaxAgeJitter: 0,
    });

    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 2_000).unref?.(),
    );
    const result = await Promise.race([runtime.runTicks(5).then(() => 'done' as const), timeout]);
    expect(result).toBe('done');
    expect(runtime.telemetrySnapshot().ticks).toBe(5);
    // Drain background persistence so test cleanup is well-behaved.
    await runtime.awaitConversationPersists();
  });

  it('fills perception.recentFacts via recallForDecision so reflections rise to the top', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tina-recall-'));
    const memory = new ParaMemory({ root, now: () => new Date('2026-04-18T00:00:00Z') });
    // Pre-seed memory with a stale observation and a recent reflection.
    await memory.addFact({ fact: 'rained at dawn', category: 'observation' });
    await memory.addFact({
      fact: 'spent the week at the cafe with Mei',
      category: 'reflection',
      related_entities: ['mei'],
    });

    let captured: { recentFactCount: number; firstCategory?: string } | null = null;
    const captPolicy: HeartbeatPolicy = {
      async decide(ctx) {
        if (!captured) {
          captured = {
            recentFactCount: ctx.perception.recentFacts.length,
            firstCategory: ctx.perception.recentFacts[0]?.category,
          };
        }
        return [];
      },
    };

    const world = new World({
      width: 16,
      height: 16,
      clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
    });
    const runtime = new Runtime({
      world,
      policy: captPolicy,
      agents: [
        {
          skill: parseSkillSource(
            '---\nname: solo\ndescription: introvert\n---\n\n# Solo\n',
            '/virtual/solo/SKILL.md',
          ),
          memory,
          initial: { position: { x: 4, y: 4 } },
        },
      ],
      seed: 1,
      tickMs: 100,
    });
    await runtime.runTicks(1);
    expect(captured).not.toBeNull();
    expect(captured!.recentFactCount).toBeGreaterThan(0);
    expect(captured!.firstCategory).toBe('reflection');
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

  it('agentContext exposes mood + active plan block after first tick', async () => {
    const { runtime } = await makeRuntime(17);
    await runtime.runTicks(1);
    const ctx = runtime.agentContext('alpha');
    expect(ctx.plan).not.toBeNull();
    expect(ctx.plan!.day).toBe(0);
    expect(ctx.plan!.summary.length).toBeGreaterThan(10);
    expect(ctx.plan!.blockId.length).toBeGreaterThan(0);
    expect(['focused', 'chatty', 'relaxed', 'restless', 'drowsy', 'engaged', 'idle']).toContain(
      ctx.mood,
    );
  });

  it('agentContext surfaces the authored hour-schedule intent for named personas (TINA-100)', async () => {
    // Build a runtime with one authored persona whose schedule pins them in
    // the `work` zone from 09 to 17. We tick once at sim-time 10:00 — the
    // plan that commits should be block-sourced from the authored schedule.
    const events: RuntimeEvent[] = [];
    const root = await mkdtemp(join(tmpdir(), 'tina-mem-authored-'));
    const hourSchedule = new Map<
      number,
      { hour: number; zone: 'cafe' | 'park' | 'work' | 'home' | null; intent: string }
    >();
    for (let h = 0; h < 24; h++) {
      if (h >= 9 && h <= 17)
        hourSchedule.set(h, { hour: h, zone: 'work', intent: 'library shift — reference desk' });
      else if (h === 19)
        hourSchedule.set(h, { hour: h, zone: 'park', intent: 'evening walk in the park' });
      else hourSchedule.set(h, { hour: h, zone: 'home', intent: 'at home' });
    }
    const clock = new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 });
    // startSimTime is unset; clock begins at 0. Seek by running to ~10:00.
    const world = new World({
      width: 32,
      height: 24,
      clock,
      zones: [
        { name: 'cafe', x: 0, y: 0, width: 6, height: 6 },
        { name: 'park', x: 10, y: 0, width: 6, height: 6 },
        { name: 'home', x: 0, y: 10, width: 6, height: 6 },
        { name: 'work', x: 10, y: 10, width: 6, height: 6 },
      ],
    });
    const runtime = new Runtime({
      agents: [
        {
          skill: skillFor({ name: 'mei', description: 'librarian' }),
          memory: new ParaMemory({
            root,
            now: () => new Date('2026-04-23T00:00:00Z'),
          }),
          initial: { position: { x: 2, y: 2 } },
          hourSchedule,
        },
      ],
      world,
      policy: silentPolicy,
      seed: 100,
      tickMs: 100,
      onEvent: (e) => events.push(e),
    });
    // Advance sim-time to ~10:00 by bumping the clock manually, then tick.
    // The clock's underlying `stepped` mode advances simTime by tickMs *
    // speed per `tick` — we abuse that by running tickless: just observe
    // the committed plan via ensurePlan semantics exercised in tickOnce.
    clock.restore({ simTime: 10 * 3600, ticks: clock.ticks, speed: clock.speed });
    await runtime.runTicks(1);
    const ctx = runtime.agentContext('mei');
    expect(ctx.plan).not.toBeNull();
    expect(ctx.plan!.blockIntent).toBe('library shift — reference desk');
    expect(ctx.plan!.preferredZone).toBe('work');
    expect(ctx.plan!.blockId.startsWith('authored-')).toBe(true);
  });

  it('setOnEvent replaces the observer callback post-construction', async () => {
    const { runtime } = await makeRuntime(19);
    const after: string[] = [];
    runtime.setOnEvent((e) => after.push(e.kind));
    await runtime.runTicks(2);
    expect(after.filter((k) => k === 'tick').length).toBe(2);
    expect(after.includes('plan_committed')).toBe(true);
  });

  it('routes around a wall via A* without clipping', async () => {
    // 5-wide world with a vertical wall at x=2, gap at the bottom row.
    //   . . W . .
    //   . . W . .
    //   . . . . .   <- only y=2 is open through the wall column
    const map = blankMap(5, 3, 'grass');
    setTile(map, 2, 0, { kind: 'wall', walkable: false });
    setTile(map, 2, 1, { kind: 'wall', walkable: false });
    const root = await mkdtemp(join(tmpdir(), 'tina-path-'));
    const world = new World({
      width: map.width,
      height: map.height,
      tileMap: map,
      clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
    });
    const runtime = new Runtime({
      world,
      policy: silentPolicy,
      reflections: false,
      memoryFlushEveryTicks: 0,
      recallLimit: 0,
      agents: [
        {
          skill: skillFor({ name: 'walker', description: 'quiet sedentary' }),
          memory: new ParaMemory({ root, now: () => new Date('2026-04-18T00:00:00Z') }),
          initial: { position: { x: 0, y: 0 }, gotoTarget: { x: 4, y: 0 } },
        },
      ],
      seed: 1,
      tickMs: 100,
    });

    const trace: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 12; i++) {
      await runtime.tickOnce();
      const a = runtime.listAgents()[0]!;
      trace.push({ ...a.state.position });
      if (a.state.gotoTarget === null && a.state.position.x === 4) break;
    }

    const a = runtime.listAgents()[0]!;
    expect(a.state.position).toEqual({ x: 4, y: 0 });
    // Must never have stepped on the wall column above the bottom row.
    for (const p of trace) {
      if (p.x === 2) expect(p.y).toBe(2);
    }
  });
});
