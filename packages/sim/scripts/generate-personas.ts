/**
 * Generate N procedurally-distinct personas into world/agents/<slug>/SKILL.md,
 * agentskills.io compliant. Deterministic given a seed.
 *
 * Usage:
 *   pnpm gen-personas -- --count 100
 *   pnpm gen-personas -- --count 100 --dir world/agents --seed 7 --clean
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Rng, pick, seededRng } from '../src/rng.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

interface Opts {
  count: number;
  dir: string;
  seed: number;
  clean: boolean;
  prefix: string;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    count: 100,
    dir: resolve(REPO_ROOT, 'world', 'agents'),
    seed: 7,
    clean: false,
    prefix: 'p',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--count' || a === '-n') opts.count = Number.parseInt(next(), 10);
    else if (a === '--dir') opts.dir = resolve(next());
    else if (a === '--seed') opts.seed = Number.parseInt(next(), 10);
    else if (a === '--prefix') opts.prefix = next();
    else if (a === '--clean') opts.clean = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`tina-generate-personas — seed N synthetic personas

Usage:
  pnpm gen-personas -- [flags]

Flags:
  --count <N>        Number of personas to generate (default 100)
  --dir <path>       Output directory (default world/agents)
  --prefix <str>     Slug prefix for generated personas (default "p")
  --seed <N>         Deterministic RNG seed (default 7)
  --clean            Remove pre-existing personas with the same prefix first
  --help             Show this help
`);
}

/**
 * Name fragments. Deliberately broad, short, and culturally diverse so the
 * simulation reads like a neighborhood instead of a single city block.
 */
const FIRST_NAMES = [
  'Ava',
  'Bruno',
  'Cara',
  'Diego',
  'Elena',
  'Finn',
  'Gita',
  'Hugo',
  'Ines',
  'Jun',
  'Kenji',
  'Lena',
  'Marcus',
  'Mei',
  'Nina',
  'Omar',
  'Priya',
  'Quinn',
  'Rosa',
  'Sana',
  'Tomas',
  'Uma',
  'Viktor',
  'Wren',
  'Xiao',
  'Yasmin',
  'Zane',
  'Aiko',
  'Bodhi',
  'Cleo',
  'Dara',
  'Eitan',
  'Farah',
  'Goran',
  'Hana',
  'Idris',
  'Jade',
  'Kiran',
  'Luca',
  'Mira',
  'Nico',
  'Ola',
  'Pablo',
  'Raina',
  'Seren',
  'Taro',
  'Ulla',
  'Vesa',
  'Wei',
  'Yara',
];

const LAST_NAMES = [
  'Okafor',
  'Costa',
  'Tanaka',
  'Ramirez',
  'Brandt',
  'Li',
  'Arai',
  'Shah',
  'Hill',
  'Nilsson',
  'Kimura',
  'Ivanov',
  'Hassan',
  'Park',
  'Bauer',
  'Silva',
  'Jensen',
  'Rivera',
  'Chen',
  'Okoye',
  'Kowalski',
  'Park',
  'Mendes',
  'Fischer',
  'Patel',
  'Abbas',
  'Morales',
  'Sato',
  'Mbeki',
  'Cruz',
];

const OCCUPATIONS = [
  'part-time barista',
  'freelance illustrator',
  'museum guard',
  'data scientist',
  'bike mechanic',
  'grad student',
  'bookseller',
  'school nurse',
  'session drummer',
  'postal clerk',
  'indie game dev',
  'public librarian',
  'line cook',
  'florist',
  'bus driver',
  'arcade tech',
  'art gallery sitter',
  'record shop owner',
  'furniture restorer',
  'tai chi instructor',
  'pet-sitter',
  'copy editor',
  'urban gardener',
  'parkour coach',
  'sign-language interpreter',
  'coffee roaster',
  'tattoo artist',
  'vet tech',
  'bar back',
  'community organizer',
];

const PERSONALITY_AXES: Array<{ label: string; lo: string; hi: string }> = [
  { label: 'social', lo: 'quiet', hi: 'outgoing' },
  { label: 'energy', lo: 'slow-moving', hi: 'restless' },
  { label: 'mood', lo: 'wry', hi: 'earnest' },
  { label: 'curiosity', lo: 'set in ways', hi: 'endlessly curious' },
  { label: 'tidiness', lo: 'chaotic', hi: 'meticulous' },
];

const ROUTINES = [
  'opens the café at 06:30 on weekdays',
  'walks the park loop before breakfast',
  'paints at home after 22:00',
  'runs 5k three mornings a week',
  'reads at the library on Sundays',
  'practices guitar before bed',
  'meets friends for dim sum on Saturdays',
  'swims laps at dawn twice a week',
  'writes in a notebook with coffee every morning',
  'volunteers at the shelter Friday evenings',
  'bakes on Sunday afternoons',
  'skates the riverside after work',
  'stargazes from the roof on clear nights',
  'stretches for 20 minutes after waking',
  'plays chess at the park bench on Tuesdays',
];

const QUIRKS = [
  'always wearing one mismatched sock on purpose',
  'keeps a running count of dogs spotted each day',
  'never drinks coffee after noon',
  'collects city transit maps',
  'hums the same tune when thinking',
  'only uses lowercase in text messages',
  'can identify birds by call alone',
  'names houseplants after philosophers',
  'carries a pocket notebook everywhere',
  'insists on handwritten letters',
  'refuses elevators below the fifth floor',
  'has never owned a phone case',
];

const VOICE_STYLES = [
  'Short sentences. Lowercase most of the time. Sparing with emoji.',
  'Warm and musical; long run-on sentences when excited.',
  'Clipped and precise. Technical vocabulary bleeds into casual talk.',
  'Gentle, patient, pauses mid-sentence to pick the right word.',
  'Deadpan with sudden bursts of earnestness.',
  'Friendly and emoji-heavy. Interjects often.',
  'Formal vocabulary, casual tone, occasional foreign phrases.',
  'Observational; narrates small details of the room.',
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function pickN<T>(rng: Rng, arr: readonly T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]!);
  }
  return out;
}

function buildPersona(
  index: number,
  prefix: string,
  rng: Rng,
): {
  slug: string;
  skillMd: string;
} {
  const first = pick(rng, FIRST_NAMES)!;
  const last = pick(rng, LAST_NAMES)!;
  const full = `${first} ${last}`;
  const age = 18 + Math.floor(rng() * 55); // 18..72
  const occupation = pick(rng, OCCUPATIONS)!;

  // Pick 3 personality axes, each biased low/mid/high
  const chosenAxes = pickN(rng, PERSONALITY_AXES, 3);
  const traits = chosenAxes.map((axis) => {
    const roll = rng();
    if (roll < 0.33) return axis.lo;
    if (roll > 0.66) return axis.hi;
    return `balanced (${axis.lo}/${axis.hi})`;
  });
  const routines = pickN(rng, ROUTINES, 3);
  const quirk = pick(rng, QUIRKS)!;
  const voice = pick(rng, VOICE_STYLES)!;

  // deterministic, stable slug that won't collide between runs at same seed
  const baseSlug = slugify(full);
  const slug = `${prefix}-${String(index).padStart(3, '0')}-${baseSlug}`;

  const description = `${age}yo ${occupation}, ${traits.join(', ')}. Use when acting as ${first} in the simulation.`;
  const body = [
    `# ${full}`,
    '',
    '## Traits',
    ...traits.map((t) => `- ${t}`),
    `- ${quirk}`,
    '',
    '## Routines',
    ...routines.map((r) => `- ${r}`),
    '',
    '## Voice',
    voice,
    '',
  ].join('\n');

  const frontmatter = [
    '---',
    `name: ${slug}`,
    `description: ${JSON.stringify(description)}`,
    'metadata:',
    '  persona_version: "1"',
    `  age: "${age}"`,
    `  occupation: ${JSON.stringify(occupation)}`,
    '---',
    '',
  ].join('\n');

  return { slug, skillMd: frontmatter + body };
}

async function cleanPrefix(dir: string, prefix: string): Promise<number> {
  let removed = 0;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(`${prefix}-`)) continue;
    await rm(join(dir, entry.name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(opts.count) || opts.count < 1) {
    console.error('--count must be a positive integer');
    process.exit(1);
  }
  await mkdir(opts.dir, { recursive: true });
  if (opts.clean) {
    const removed = await cleanPrefix(opts.dir, opts.prefix);
    if (removed > 0)
      console.log(`[gen] cleaned ${removed} pre-existing "${opts.prefix}-*" personas`);
  }

  const rng = seededRng(`personas:${opts.seed}`);
  const created: string[] = [];
  for (let i = 0; i < opts.count; i++) {
    const { slug, skillMd } = buildPersona(i, opts.prefix, rng);
    const personaDir = join(opts.dir, slug);
    await mkdir(personaDir, { recursive: true });
    await writeFile(join(personaDir, 'SKILL.md'), skillMd, 'utf8');
    created.push(slug);
  }

  console.log(`[gen] wrote ${created.length} personas to ${opts.dir} (seed=${opts.seed})`);
  console.log(`[gen] first: ${created[0]}  last: ${created[created.length - 1]}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
