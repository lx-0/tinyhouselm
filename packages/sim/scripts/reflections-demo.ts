/**
 * reflections-demo — TINA-9 deliverable.
 *
 * Runs a small multi-day simulation with a deterministic policy that emits a
 * mix of `remember` and `speak` actions, so the agent's memory actually grows.
 * After it finishes we compare two ways of giving the agent context:
 *
 *   baseline: dump the last 50 raw active facts (the "everything goes in" path)
 *   ranked:   recallForDecision({limit: 10}) — the new retrieval API
 *
 * The ranked path naturally favors high-importance reflections + recent raw
 * memory. We print both prompts side-by-side and the character-count delta.
 *
 * Usage:
 *   pnpm reflections-demo
 *   pnpm reflections-demo --days 5 --seed 7
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAction, Zone } from '@tina/shared';
import { SimulationClock } from '../src/clock.js';
import { DefaultHeartbeatPolicy, type HeartbeatPolicy } from '../src/heartbeat.js';
import { type MemoryFact, ParaMemory } from '../src/memory.js';
import { Runtime, type RuntimeEvent } from '../src/runtime.js';
import { parseSkillSource } from '../src/skills.js';
import { World } from '../src/world.js';

interface Opts {
  days: number;
  seed: number;
  tickMs: number;
  speed: number;
  startHour: number;
  rememberRate: number;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    days: 4,
    seed: 11,
    tickMs: 50,
    speed: 1200,
    startHour: 6,
    rememberRate: 0.25,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? '';
    if (a === '--days') opts.days = Number.parseInt(next(), 10);
    else if (a === '--seed') opts.seed = Number.parseInt(next(), 10);
    else if (a === '--tick-ms') opts.tickMs = Number.parseInt(next(), 10);
    else if (a === '--speed') opts.speed = Number.parseInt(next(), 10);
    else if (a === '--start-hour') opts.startHour = Number.parseInt(next(), 10);
    else if (a === '--remember-rate') opts.rememberRate = Number.parseFloat(next());
  }
  return opts;
}

const ZONES: Zone[] = [
  { name: 'cafe', x: 1, y: 1, width: 5, height: 5 },
  { name: 'park', x: 14, y: 1, width: 5, height: 5 },
  { name: 'home', x: 9, y: 14, width: 5, height: 5 },
];

function fmtFact(f: MemoryFact): string {
  return `[${f.timestamp}] (${f.category} imp=${f.importance}) ${f.fact}`;
}

/**
 * Wraps the default heartbeat policy and stuffs in synthetic remember actions
 * at a controlled rate. Without this the rule-based policy only writes a fact
 * ~8% of the time, which is too sparse to demo consolidation in a short run.
 */
function chattyPolicy(base: HeartbeatPolicy, rate: number): HeartbeatPolicy {
  return {
    async decide(ctx) {
      const out = await base.decide(ctx);
      if (ctx.rng() < rate) {
        const fact = makeObservation(ctx.perception);
        if (fact) out.push({ kind: 'remember', fact } satisfies AgentAction);
      }
      return out;
    },
  };
}

function makeObservation(perception: {
  timeOfDay: string;
  self: { zone: string | null };
  nearby: Array<{ name: string }>;
}): string | null {
  const zone = perception.self.zone ?? 'somewhere';
  const tod = perception.timeOfDay;
  if (perception.nearby.length > 0) {
    const names = perception.nearby.map((n) => n.name).join(', ');
    return `${tod} at ${zone}: with ${names}`;
  }
  return `${tod} at ${zone}: alone, watching the day pass`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const personas = [
    { name: 'mei-tanaka', desc: 'extrovert barista, opens the cafe at 6:30, chatty' },
    { name: 'bruno-costa', desc: 'introvert programmer who works from home' },
    { name: 'ava-okafor', desc: 'curious writer, drifts between the cafe and the park' },
    { name: 'kenji-arai', desc: 'energetic runner, mornings at the park, social' },
  ];

  const clock = new SimulationClock({
    mode: 'stepped',
    speed: opts.speed,
    tickHz: 1000 / opts.tickMs,
    startSimTime: opts.startHour * 3600,
  });
  const world = new World({ width: 24, height: 24, clock, zones: ZONES });

  const startPositions = [
    { x: 3, y: 3 },
    { x: 16, y: 16 },
    { x: 16, y: 3 },
    { x: 12, y: 16 },
  ];
  const runtimeAgents = personas.map((p, i) => {
    const root = mkdtempSync(join(tmpdir(), `tina-refl-demo-${p.name}-`));
    return {
      skill: parseSkillSource(
        `---\nname: ${p.name}\ndescription: ${p.desc}\n---\n\n# ${p.name}\n\n${p.desc}\n`,
        `/virtual/${p.name}/SKILL.md`,
      ),
      memory: new ParaMemory({
        root,
        now: () => new Date('2026-04-21T06:00:00Z'),
        flushMode: 'deferred',
      }),
      initial: { position: startPositions[i % startPositions.length]! },
    };
  });

  const events: RuntimeEvent[] = [];
  const runtime = new Runtime({
    world,
    agents: runtimeAgents,
    seed: opts.seed,
    tickMs: opts.tickMs,
    policy: chattyPolicy(new DefaultHeartbeatPolicy(), opts.rememberRate),
    speechTtlMs: 50,
    conversationIdleMs: 200,
    reflections: { importanceBudget: 60, minFacts: 12, windowSize: 30 },
    onEvent: (e) => events.push(e),
  });

  // speed * tickMs / 1000 = simulated seconds per tick.
  const ticks = Math.ceil((opts.days * 86400) / ((opts.speed * opts.tickMs) / 1000));

  console.log(
    `# reflections-demo | days=${opts.days} seed=${opts.seed} ticks=${ticks} agents=${personas.length} remember-rate=${opts.rememberRate}`,
  );
  await runtime.runTicks(ticks);
  await runtime.flushConversations();

  const reflectionEvents = events.filter((e) => e.kind === 'reflection_written');
  const planCommits = events.filter((e) => e.kind === 'plan_committed');
  console.log(
    `# done — ${planCommits.length} day-commits, ${reflectionEvents.length} reflections written`,
  );

  const targets = await Promise.all(
    runtimeAgents.map(async (a) => ({
      slug: a.skill.id,
      memory: a.memory,
      facts: await a.memory.readFacts(),
    })),
  );
  targets.sort((a, b) => b.facts.length - a.facts.length);
  const target = targets[0]!;

  console.log('');
  console.log(`# subject: ${target.slug} — ${target.facts.length} total facts on disk`);
  console.log(`# reflections: ${target.facts.filter((f) => f.category === 'reflection').length}`);

  const baseline = target.facts.filter((f) => f.status === 'active').slice(-50);
  const baselinePrompt = baseline.map(fmtFact).join('\n');

  const ranked = await target.memory.recallForDecision({ limit: 10 });
  const rankedPrompt = ranked.map((r) => fmtFact(r.fact)).join('\n');

  const baseChars = baselinePrompt.length;
  const rankedChars = rankedPrompt.length;
  const reduction = baseChars > 0 ? ((baseChars - rankedChars) / baseChars) * 100 : 0;

  console.log('');
  console.log(`## baseline prompt (last ${baseline.length} raw facts) — ${baseChars} chars`);
  console.log('---');
  const previewLines = baselinePrompt.split('\n').slice(0, 6);
  for (const line of previewLines) console.log(line.length > 200 ? `${line.slice(0, 200)}…` : line);
  if (baseline.length > 6) console.log(`… (+${baseline.length - 6} more)`);
  console.log('---');

  console.log('');
  console.log(
    `## ranked prompt (top ${ranked.length} via recallForDecision) — ${rankedChars} chars`,
  );
  console.log('---');
  for (const line of rankedPrompt.split('\n')) {
    console.log(line.length > 200 ? `${line.slice(0, 200)}…` : line);
  }
  console.log('---');

  console.log('');
  console.log(
    `# prompt size: ${baseChars} → ${rankedChars} chars (${reduction.toFixed(1)}% reduction)`,
  );

  const allReflections = target.facts.filter((f) => f.category === 'reflection');
  if (allReflections.length > 0) {
    console.log('');
    console.log(`# ${target.slug}'s reflection trail:`);
    for (const r of allReflections) console.log(`  - ${fmtFact(r)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
