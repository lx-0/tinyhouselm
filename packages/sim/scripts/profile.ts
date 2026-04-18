/**
 * Tick-loop profiler. Spawns N synthetic personas in a tmpdir and ticks the
 * runtime `ticks` times, recording per-tick wall time. Prints p50/p99 ms/tick.
 *
 * Usage: tsx scripts/profile.ts --agents 100 --ticks 120 [--seed 7]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Zone } from '@tina/shared';
import { SimulationClock } from '../src/clock.js';
import { ParaMemory } from '../src/memory.js';
import { Runtime, type RuntimeEvent } from '../src/runtime.js';
import type { SkillDocument } from '../src/skills.js';
import { World } from '../src/world.js';

interface Opts {
  agents: number;
  ticks: number;
  seed: number;
  tickMs: number;
  worldSize: number;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = { agents: 100, ticks: 60, seed: 7, tickMs: 100, worldSize: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--agents' || a === '-n') opts.agents = Number.parseInt(next() ?? '', 10);
    else if (a === '--ticks' || a === '-t') opts.ticks = Number.parseInt(next() ?? '', 10);
    else if (a === '--seed') opts.seed = Number.parseInt(next() ?? '', 10);
    else if (a === '--tick-ms') opts.tickMs = Number.parseInt(next() ?? '', 10);
    else if (a === '--world') opts.worldSize = Number.parseInt(next() ?? '', 10);
  }
  return opts;
}

const TRAITS = [
  'outgoing',
  'introvert',
  'energetic',
  'quiet',
  'restless',
  'reserved',
  'chatty',
  'shy',
];

function synthSkills(n: number): SkillDocument[] {
  const out: SkillDocument[] = [];
  for (let i = 0; i < n; i++) {
    const trait = TRAITS[i % TRAITS.length]!;
    const id = `agent-${String(i).padStart(3, '0')}`;
    const name = `Agent ${i}`;
    out.push({
      id,
      displayName: name,
      description: `${trait} synthetic persona #${i}`,
      metadata: {},
      body: `# ${name}\n\nTraits: ${trait}.`,
      path: `/virtual/${id}/SKILL.md`,
      raw: { name: id },
    });
  }
  return out;
}

function defaultZones(w: number, h: number): Zone[] {
  const zw = Math.max(4, Math.floor(w / 4));
  const zh = Math.max(4, Math.floor(h / 4));
  return [
    { name: 'cafe', x: 1, y: 1, width: zw, height: zh },
    { name: 'park', x: w - zw - 1, y: 1, width: zw, height: zh },
    { name: 'home', x: Math.floor(w / 2 - zw / 2), y: h - zh - 1, width: zw, height: zh },
  ];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tina-profile-'));
  try {
    const skills = synthSkills(opts.agents);
    const zones = defaultZones(opts.worldSize, opts.worldSize);
    const anchors = zones.map((z) => ({
      x: Math.floor(z.x + z.width / 2),
      y: Math.floor(z.y + z.height / 2),
    }));

    const clock = new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 1000 / opts.tickMs });
    const world = new World({ width: opts.worldSize, height: opts.worldSize, clock, zones });

    const runtimeAgents = skills.map((skill, i) => {
      const anchor = anchors[i % anchors.length]!;
      const jx = ((i * 37) % 7) - 3;
      const jy = ((i * 53) % 9) - 4;
      return {
        skill,
        memory: new ParaMemory({ root: join(tmpRoot, skill.id), flushMode: 'deferred' }),
        initial: {
          position: {
            x: Math.max(0, Math.min(opts.worldSize - 1, anchor.x + jx)),
            y: Math.max(0, Math.min(opts.worldSize - 1, anchor.y + jy)),
          },
        },
      };
    });

    let actions = 0;
    let convs = 0;
    const onEvent = (e: RuntimeEvent) => {
      if (e.kind === 'action') actions++;
      else if (e.kind === 'conversation_open') convs++;
    };

    const runtime = new Runtime({
      agents: runtimeAgents,
      world,
      tickMs: opts.tickMs,
      seed: opts.seed,
      onEvent,
    });

    // Warm-up tick (file creation, etc.)
    await runtime.tickOnce();
    actions = 0;
    convs = 0;

    const samples: number[] = [];
    const startAll = performance.now();
    for (let i = 0; i < opts.ticks; i++) {
      const t0 = performance.now();
      await runtime.tickOnce();
      samples.push(performance.now() - t0);
    }
    await runtime.flushConversations();
    const totalMs = performance.now() - startAll;

    samples.sort((a, b) => a - b);
    const p50 = quantile(samples, 0.5);
    const p95 = quantile(samples, 0.95);
    const p99 = quantile(samples, 0.99);
    const max = samples[samples.length - 1] ?? 0;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

    console.log(
      `[profile] agents=${opts.agents} ticks=${opts.ticks} world=${opts.worldSize}x${opts.worldSize}`,
    );
    console.log(
      `[profile] ms/tick  mean=${mean.toFixed(2)}  p50=${p50.toFixed(2)}  p95=${p95.toFixed(2)}  p99=${p99.toFixed(2)}  max=${max.toFixed(2)}`,
    );
    console.log(
      `[profile] wall=${totalMs.toFixed(0)}ms  actions=${actions}  conversations_opened=${convs}  actions/tick=${(actions / opts.ticks).toFixed(1)}`,
    );
    const budget = opts.tickMs;
    const overBudget = samples.filter((s) => s > budget).length;
    console.log(
      `[profile] budget=${budget}ms/tick  over-budget ticks=${overBudget}/${opts.ticks} (${((100 * overBudget) / opts.ticks).toFixed(0)}%)`,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
