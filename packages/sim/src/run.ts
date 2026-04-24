import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TileMap, Vec2 } from '@tina/shared';
import { SimulationClock } from './clock.js';
import { ParaMemory } from './memory.js';
import { type ScheduleEntry, loadAllPersonas, seedNamedPersonaMemories } from './named-personas.js';
import { describeAction } from './perception.js';
import { seededRng } from './rng.js';
import { Runtime, type RuntimeEvent } from './runtime.js';
import { type SkillDocument, loadAllSkills, loadSkill, skillDirectory } from './skills.js';
import { homeForAgent, nearestWalkable } from './tilemap.js';
import { buildStarterTown } from './town.js';
import { World } from './world.js';

interface CliOptions {
  agentsDir: string;
  include: string[] | null;
  ticks: number;
  tickMs: number;
  seed: number;
  worldWidth: number;
  worldHeight: number;
  json: boolean;
  quiet: boolean;
  skillPaths: string[];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DEFAULTS: CliOptions = {
  agentsDir: resolve(REPO_ROOT, 'world', 'agents'),
  include: null,
  ticks: 60,
  tickMs: 100,
  seed: 42,
  // World dimensions are taken from the starter town tilemap when present;
  // these only matter for synthetic / mapless runs.
  worldWidth: 32,
  worldHeight: 24,
  json: false,
  quiet: false,
  skillPaths: [],
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? '';
    switch (arg) {
      case '--agents-dir':
        opts.agentsDir = next();
        break;
      case '--agents':
      case '-a':
        opts.include = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--skill':
        opts.skillPaths.push(next());
        break;
      case '--ticks':
      case '-t':
        opts.ticks = Number.parseInt(next(), 10);
        break;
      case '--tick-ms':
        opts.tickMs = Number.parseInt(next(), 10);
        break;
      case '--seed':
        opts.seed = Number.parseInt(next(), 10);
        break;
      case '--map': {
        const [w, h] = next()
          .split('x')
          .map((s) => Number.parseInt(s, 10));
        if (w && h) {
          opts.worldWidth = w;
          opts.worldHeight = h;
        }
        break;
      }
      case '--json':
        opts.json = true;
        break;
      case '--quiet':
      case '-q':
        opts.quiet = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`tina-run — run N personas for T ticks

Usage:
  pnpm run-sim [flags]

Flags:
  --agents-dir <path>   Directory of agentskills.io personas (default world/agents)
  --agents <a,b,c>      Only include these slugs (default: all)
  --skill <path>        Extra SKILL.md path (repeatable)
  --ticks <N>           Number of ticks (default 60)
  --tick-ms <ms>        Real ms per tick (default 100)
  --seed <N>            Seed for deterministic RNG (default 42)
  --map <WxH>           World bounds (default 24x24)
  --json                Emit NDJSON events instead of text
  --quiet               Skip per-tick positional lines
  --help                Show this help
`);
}

const NAMED_PERSONAS_DIR = resolve(REPO_ROOT, 'packages', 'sim', 'personas', 'named');

async function loadSkills(opts: CliOptions): Promise<{
  skills: SkillDocument[];
  memoryRootFor: (id: string) => string;
  hourScheduleFor: (id: string) => Map<number, ScheduleEntry> | null;
}> {
  if (opts.skillPaths.length > 0) {
    // Explicit --skill paths bypass the named+procedural merge; they're
    // expected to carry their own memory dir next to each SKILL.md.
    const docs: SkillDocument[] = [];
    for (const p of opts.skillPaths) docs.push(await loadSkill(p));
    const filtered = opts.include ? docs.filter((s) => new Set(opts.include!).has(s.id)) : docs;
    return {
      skills: filtered,
      memoryRootFor: (id) => {
        const s = filtered.find((x) => x.id === id);
        return s ? `${skillDirectory(s)}/memory` : resolve(opts.agentsDir, id, 'memory');
      },
      hourScheduleFor: () => null,
    };
  }
  const loaded = await loadAllPersonas({
    namedManifestDir: NAMED_PERSONAS_DIR,
    proceduralDir: opts.agentsDir,
  });
  await seedNamedPersonaMemories(loaded.named);
  if (opts.include) {
    const wanted = new Set(opts.include);
    const filtered = loaded.skills.filter((s) => wanted.has(s.id));
    // Guarantee named ids stay even if filter order dropped them; preserves
    // the "named personas always present" contract from TINA-27.
    for (const np of loaded.named) {
      if (wanted.has(np.manifest.id) && !filtered.some((s) => s.id === np.manifest.id)) {
        filtered.unshift(np.skill);
      }
    }
    return {
      skills: filtered,
      memoryRootFor: loaded.memoryRootFor,
      hourScheduleFor: loaded.hourScheduleFor,
    };
  }
  return {
    skills: loaded.skills,
    memoryRootFor: loaded.memoryRootFor,
    hourScheduleFor: loaded.hourScheduleFor,
  };
}

function spawnAnchorsFromMap(map: TileMap): Vec2[] {
  // Spawn at the door of every home + the cafe entrance + the park bench so
  // agents start scattered across the town instead of all on top of each other.
  const anchors: Vec2[] = [];
  for (const loc of map.locations) {
    if (loc.affordances.includes('sleep') || loc.id === 'cafe.counter' || loc.id === 'park.bench') {
      anchors.push(loc.anchor);
    }
  }
  if (anchors.length === 0)
    anchors.push({ x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) });
  return anchors;
}

function pad(n: number | string, width: number): string {
  return String(n).padStart(width);
}

function formatEvent(event: RuntimeEvent): string {
  const t = event.kind === 'spawn' ? ' -- ' : `${pad(event.simTime.toFixed(1), 6)}s`;
  const tick = event.kind === 'spawn' ? '   ' : pad(event.tick, 3);
  switch (event.kind) {
    case 'tick':
      return `t=${t}  tick=${tick}  --`;
    case 'spawn':
      return `t=${t}  tick=${tick}  spawn  ${event.agentId}  (${event.name})`;
    case 'action': {
      const heard =
        event.action.kind === 'speak' && event.heardBy && event.heardBy.length > 0
          ? `  heardBy=${event.heardBy.join(',')}`
          : '';
      return `t=${t}  tick=${tick}  ${event.agentId.padEnd(16)}  ${describeAction(event.action)}${heard}`;
    }
    case 'conversation_open':
      return `t=${t}  tick=${tick}  conv_open  ${event.sessionId}  [${event.participants.join(', ')}]`;
    case 'conversation_close':
      return `t=${t}  tick=${tick}  conv_close ${event.sessionId}  [${event.participants.join(', ')}]  turns=${event.transcript.length}  reason=${event.reason}`;
    case 'plan_committed':
      return `t=${t}  tick=${tick}  plan_commit  ${event.agentId.padEnd(16)}  day=${event.day}  ${event.summary}`;
    case 'plan_replan':
      return `t=${t}  tick=${tick}  plan_replan  ${event.agentId.padEnd(16)}  reason=${event.reason}  ${event.detail}`;
    case 'plan_resume':
      return `t=${t}  tick=${tick}  plan_resume  ${event.agentId.padEnd(16)}  reason=${event.reason}`;
    case 'reflection_written':
      return `t=${t}  tick=${tick}  reflection   ${event.agentId.padEnd(16)}  trigger=${event.trigger}  src=${event.sourceCount}  ${event.summary}`;
    case 'intervention':
      return `t=${t}  tick=${tick}  intervention ${event.type.padEnd(14)}  aff=${event.affected.length}  ${event.summary}`;
    case 'relationship_nudge_applied':
      return `t=${t}  tick=${tick}  nudge_applied ${event.direction.padEnd(10)}  ${event.a} ↔ ${event.b}  session=${event.sessionId}`;
    case 'group_moment':
      return `t=${t}  tick=${tick}  group_moment zone=${event.zone.padEnd(12)}  [${event.participants.join(', ')}]  session=${event.sessionId}`;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const { skills, memoryRootFor, hourScheduleFor } = await loadSkills(opts);
  if (skills.length === 0) {
    console.error(
      `no personas found. Checked ${resolve(opts.agentsDir)}${
        opts.include ? ` with filter [${opts.include.join(', ')}]` : ''
      }`,
    );
    process.exit(1);
  }

  const tileMap = buildStarterTown();
  const positionRng = seededRng(`positions:${opts.seed}`);

  const clock = new SimulationClock({
    mode: 'stepped',
    speed: 60,
    tickHz: 1000 / opts.tickMs,
  });
  const world = new World({ width: tileMap.width, height: tileMap.height, clock, tileMap });
  const zones = world.zones;
  const anchors = spawnAnchorsFromMap(tileMap);

  const runtimeAgents = skills.map((skill) => {
    const home = homeForAgent(tileMap, skill.id);
    const baseAnchor = home?.anchor ??
      anchors[Math.floor(positionRng() * anchors.length) % anchors.length] ?? { x: 1, y: 1 };
    const jitter = {
      x: Math.floor(positionRng() * 3) - 1,
      y: Math.floor(positionRng() * 3) - 1,
    };
    const candidate: Vec2 = {
      x: clamp(baseAnchor.x + jitter.x, 0, world.width - 1),
      y: clamp(baseAnchor.y + jitter.y, 0, world.height - 1),
    };
    const safe = nearestWalkable(tileMap, candidate, 6) ?? baseAnchor;
    return {
      skill,
      memory: new ParaMemory({
        root: memoryRootFor(skill.id),
        flushMode: 'deferred',
      }),
      initial: {
        position: { ...safe },
      },
      hourSchedule: hourScheduleFor(skill.id),
    };
  });

  const emit = (event: RuntimeEvent) => {
    if (opts.json) {
      console.log(JSON.stringify(event));
      return;
    }
    if (event.kind === 'tick' && opts.quiet) return;
    console.log(formatEvent(event));
  };

  const runtime = new Runtime({
    agents: runtimeAgents,
    world,
    tickMs: opts.tickMs,
    seed: opts.seed,
    onEvent: emit,
  });

  if (!opts.json) {
    console.log(
      `[tina] running ${skills.length} agents for ${opts.ticks} ticks @ ${opts.tickMs}ms/tick (seed=${opts.seed})`,
    );
    console.log(
      `[tina] map ${world.width}x${world.height}  zones: ${zones.map((z) => z.name).join(', ')}  locations: ${tileMap.locations.length}  personas: ${skills.map((s) => s.id).join(', ')}`,
    );
  }

  await runtime.runTicks(opts.ticks);
  await runtime.flushConversations();

  if (!opts.json) {
    const t = runtime.telemetrySnapshot();
    const a = t.actions;
    console.log(
      `[tina] done: ${t.ticks} ticks, ${sumActions(a)} actions (${a.move_to} moves, ${a.goto} gotos, ${a.speak} speeches, ${a.remember} remembered), ${t.conversationsOpened} conversations opened, ${t.conversationsClosed} closed`,
    );
    console.log(
      `[tina] tick ms  mean=${t.tickDuration.mean.toFixed(2)} p50=${t.tickDuration.p50.toFixed(2)} p95=${t.tickDuration.p95.toFixed(2)} p99=${t.tickDuration.p99.toFixed(2)} max=${t.tickDuration.max.toFixed(2)}`,
    );
    console.log(
      `[tina] wall=${t.wallMs.toFixed(0)}ms  actions/min=${t.actionsPerMinute.toFixed(0)}  conversations/min=${t.conversationsPerMinute.toFixed(0)}`,
    );
  }
}

function sumActions(r: Record<string, number>): number {
  let s = 0;
  for (const k of Object.keys(r)) s += r[k]!;
  return s;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
