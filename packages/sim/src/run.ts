import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimulationClock } from './clock.js';
import { ParaMemory } from './memory.js';
import { describeAction } from './perception.js';
import { seededRng } from './rng.js';
import { Runtime, type RuntimeEvent } from './runtime.js';
import { type SkillDocument, loadAllSkills, loadSkill, skillDirectory } from './skills.js';
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
  worldWidth: 24,
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

async function loadSkills(opts: CliOptions): Promise<SkillDocument[]> {
  const loaded: SkillDocument[] = [];
  if (opts.skillPaths.length > 0) {
    for (const p of opts.skillPaths) loaded.push(await loadSkill(p));
  } else {
    const all = await loadAllSkills(opts.agentsDir);
    loaded.push(...all);
  }
  if (opts.include) {
    const wanted = new Set(opts.include);
    return loaded.filter((s) => wanted.has(s.id));
  }
  return loaded;
}

function layoutPositions(
  count: number,
  width: number,
  height: number,
): Array<{ x: number; y: number }> {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const gx = Math.floor(width / (cols + 1));
  const gy = Math.floor(height / (rows + 1));
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ x: (c + 1) * gx, y: (r + 1) * gy });
  }
  return out;
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
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const skills = await loadSkills(opts);
  if (skills.length === 0) {
    console.error(
      `no personas found. Checked ${resolve(opts.agentsDir)}${
        opts.include ? ` with filter [${opts.include.join(', ')}]` : ''
      }`,
    );
    process.exit(1);
  }

  const positionRng = seededRng(`positions:${opts.seed}`);
  const positions = layoutPositions(skills.length, opts.worldWidth, opts.worldHeight);

  const clock = new SimulationClock({
    mode: 'stepped',
    speed: 60,
    tickHz: 1000 / opts.tickMs,
  });
  const world = new World({ width: opts.worldWidth, height: opts.worldHeight, clock });

  const runtimeAgents = skills.map((skill, i) => {
    const basePos = positions[i]!;
    const jitter = {
      x: Math.floor(positionRng() * 3) - 1,
      y: Math.floor(positionRng() * 3) - 1,
    };
    return {
      skill,
      memory: new ParaMemory({ root: `${skillDirectory(skill)}/memory` }),
      initial: {
        position: {
          x: clamp(basePos.x + jitter.x, 0, opts.worldWidth - 1),
          y: clamp(basePos.y + jitter.y, 0, opts.worldHeight - 1),
        },
      },
    };
  });

  const events: RuntimeEvent[] = [];
  const emit = (event: RuntimeEvent) => {
    events.push(event);
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
      `[tina] map ${opts.worldWidth}x${opts.worldHeight}  personas: ${skills.map((s) => s.id).join(', ')}`,
    );
  }

  await runtime.runTicks(opts.ticks);

  if (!opts.json) {
    const actions = events.filter((e) => e.kind === 'action').length;
    const speeches = events.filter((e) => e.kind === 'action' && e.action.kind === 'speak').length;
    const moves = events.filter((e) => e.kind === 'action' && e.action.kind === 'move_to').length;
    const remembers = events.filter(
      (e) => e.kind === 'action' && e.action.kind === 'remember',
    ).length;
    console.log(
      `[tina] done: ${opts.ticks} ticks, ${actions} actions (${moves} moves, ${speeches} speeches, ${remembers} remembered)`,
    );
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
