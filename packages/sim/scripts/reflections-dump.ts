import { readdir } from 'node:fs/promises';
/**
 * reflections-dump — print every reflection an agent has written.
 *
 * Reads the on-disk para-memory store under world/agents/<slug>/memory and
 * walks the items.yaml fact list, filtering for category=reflection.
 *
 * Usage:
 *   pnpm reflections-dump --agent <slug>
 *   pnpm reflections-dump --agents-dir world/agents --all
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type MemoryFact, ParaMemory } from '../src/memory.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Opts {
  agentsDir: string;
  agentSlugs: string[];
  all: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    agentsDir: resolve(REPO_ROOT, 'world', 'agents'),
    agentSlugs: [],
    all: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? '';
    if (a === '--agent' || a === '-a') opts.agentSlugs.push(next());
    else if (a === '--agents-dir') opts.agentsDir = next();
    else if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') {
      console.log(`reflections-dump — print reflections for one or more agents

Flags:
  --agent <slug>     agent to dump (repeatable)
  --agents-dir <dir> root agents dir (default world/agents)
  --all              dump every agent in --agents-dir
  --json             emit one JSON object per reflection
  --help             this message
`);
      process.exit(0);
    }
  }
  return opts;
}

async function listAgentSlugs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function fmtReflection(slug: string, f: MemoryFact): string {
  const sources =
    f.derived_from && f.derived_from.length > 0
      ? ` from ${f.derived_from.length} raw facts (${f.derived_from.slice(0, 3).join(', ')}${
          f.derived_from.length > 3 ? '…' : ''
        })`
      : '';
  const entities = f.related_entities.length > 0 ? `  [${f.related_entities.join(', ')}]` : '';
  return `[${f.timestamp}] ${slug.padEnd(20)} imp=${f.importance}${sources}${entities}\n  ${f.fact}`;
}

async function dumpAgent(slug: string, agentsDir: string, json: boolean): Promise<number> {
  const root = resolve(agentsDir, slug, 'memory');
  const memory = new ParaMemory({ root });
  const reflections = await memory.recentReflections(1000);
  if (reflections.length === 0) {
    if (!json) console.log(`# ${slug}: no reflections yet`);
    return 0;
  }
  if (!json) console.log(`# ${slug}: ${reflections.length} reflection(s)`);
  for (const r of reflections) {
    if (json) console.log(JSON.stringify({ agent: slug, ...r }));
    else console.log(fmtReflection(slug, r));
  }
  if (!json) console.log('');
  return reflections.length;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let slugs = opts.agentSlugs;
  if (opts.all || slugs.length === 0) {
    slugs = await listAgentSlugs(opts.agentsDir);
    if (slugs.length === 0) {
      console.error(`no agents found in ${opts.agentsDir}`);
      process.exit(1);
    }
  }
  let total = 0;
  for (const slug of slugs) {
    total += await dumpAgent(slug, opts.agentsDir, opts.json);
  }
  if (!opts.json) console.log(`# total reflections across ${slugs.length} agent(s): ${total}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
