import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type AddFactInput, type FactCategory, ParaMemory } from './memory.js';
import { type SkillDocument, loadAllSkills, parseSkillSource, skillDirectory } from './skills.js';

const FACT_CATEGORIES: FactCategory[] = [
  'relationship',
  'milestone',
  'status',
  'preference',
  'observation',
  'reflection',
];

export interface NamedPersonaGlyph {
  /** Body color used by the renderer. Hex like `#d8a0cc`. */
  color: string;
  /** Accent color used for the star ring / highlight. Hex. */
  accent: string;
}

export interface NamedPersonaSeedMemory {
  fact: string;
  category?: FactCategory;
  importance?: number;
  related_entities?: string[];
}

export interface NamedPersonaManifest {
  id: string;
  name: string;
  bio: string;
  archetype: string;
  glyph: NamedPersonaGlyph;
  traits: string[];
  routines: string[];
  voice: string;
  seedMemories: NamedPersonaSeedMemory[];
  age?: number;
  occupation?: string;
}

export interface NamedPersona {
  manifest: NamedPersonaManifest;
  skill: SkillDocument;
  /** Absolute path to the memory directory for this persona. */
  memoryRoot: string;
  /** Absolute path to the manifest file it was read from. */
  manifestPath: string;
}

export interface LoadNamedPersonasOptions {
  /** Directory containing `<id>.yaml` manifests. */
  manifestDir: string;
  /**
   * Directory that holds per-persona memory subdirs. A persona's memory lives
   * at `<memoryRootDir>/<id>/memory`. Defaults to `world/agents`.
   */
  memoryRootDir: string;
}

/**
 * Load all named persona manifests from `manifestDir`. The resulting
 * documents are sorted by id (stable ordering across boots).
 */
export async function loadNamedPersonas(opts: LoadNamedPersonasOptions): Promise<NamedPersona[]> {
  const manifestDir = resolve(opts.manifestDir);
  const entries = await readdirOrEmpty(manifestDir);

  const out: NamedPersona[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') continue;
    const manifestPath = join(manifestDir, entry.name);
    const manifest = await readManifest(manifestPath);
    const memoryRoot = join(resolve(opts.memoryRootDir), manifest.id, 'memory');
    const skill = manifestToSkill(manifest, manifestPath);
    out.push({ manifest, skill, memoryRoot, manifestPath });
  }

  const seenIds = new Set<string>();
  for (const p of out) {
    if (seenIds.has(p.manifest.id)) {
      throw new Error(`duplicate named persona id "${p.manifest.id}" in ${manifestDir}`);
    }
    seenIds.add(p.manifest.id);
  }

  out.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return out;
}

/**
 * Write each manifest's `seedMemories` into the persona's items.yaml, but only
 * when there are no facts yet (fresh install / first boot). Safe to call every
 * boot — no-op once a persona has any facts.
 *
 * Returns the ids of personas that were actually seeded this call.
 */
export async function seedNamedPersonaMemories(
  personas: NamedPersona[],
  now: () => Date = () => new Date(),
): Promise<string[]> {
  const seeded: string[] = [];
  for (const p of personas) {
    if (p.manifest.seedMemories.length === 0) continue;
    const mem = new ParaMemory({ root: p.memoryRoot, now, flushMode: 'eager' });
    const existing = await mem.readFacts();
    if (existing.length > 0) continue;
    for (const seed of p.manifest.seedMemories) {
      const input: AddFactInput = {
        fact: seed.fact,
        category: seed.category ?? 'preference',
        importance: seed.importance,
        related_entities: seed.related_entities,
        source: 'seed',
      };
      await mem.addFact(input);
    }
    seeded.push(p.manifest.id);
  }
  return seeded;
}

export interface LoadAllPersonasOptions {
  /** Directory containing `<id>.yaml` named persona manifests. */
  namedManifestDir: string;
  /** Directory of procedural `<slug>/SKILL.md` personas (e.g. `world/agents`). */
  proceduralDir: string;
  /**
   * Memory root for named personas. Named persona memory lives at
   * `<memoryRootDir>/<id>/memory`. Defaults to `proceduralDir` so named
   * + procedural personas share the same filesystem layout.
   */
  memoryRootDir?: string;
  /**
   * Hard cap on total personas after the merge. Named personas are never
   * dropped; procedural fills are trimmed from the end of the sorted list.
   * Set to 0 or undefined to include everything available.
   */
  cap?: number;
}

export interface LoadedPersonas {
  /**
   * All personas, named first (sorted by id) then procedural fills (sorted
   * by id), deduped by id. Safe to feed straight into `Runtime`.
   */
  skills: SkillDocument[];
  /** Just the named-persona entries, if callers need manifest / bio / glyph. */
  named: NamedPersona[];
  /** Skills dropped to satisfy `cap`. */
  dropped: SkillDocument[];
  /** Returns the canonical memory root path for any loaded persona id. */
  memoryRootFor(id: string): string;
}

/**
 * Single entry point for the web server and the CLI runner. Named personas
 * always land first and are never capped out; procedural personas (from
 * `proceduralDir`) fill the remaining slots and are skipped when their id
 * collides with a named persona.
 */
export async function loadAllPersonas(opts: LoadAllPersonasOptions): Promise<LoadedPersonas> {
  const memoryRootDir = resolve(opts.memoryRootDir ?? opts.proceduralDir);
  const named = await loadNamedPersonas({
    manifestDir: opts.namedManifestDir,
    memoryRootDir,
  });
  const namedIds = new Set(named.map((p) => p.manifest.id));

  const procedural = (await loadAllSkills(opts.proceduralDir)).filter((s) => !namedIds.has(s.id));

  const merged: SkillDocument[] = [...named.map((p) => p.skill), ...procedural];
  let dropped: SkillDocument[] = [];
  if (opts.cap && opts.cap > 0 && merged.length > opts.cap) {
    // Honor "named personas always present" from TINA-27: when the cap is
    // smaller than the named roster, keep every named persona and drop only
    // procedural fills from the tail. Callers that set an explicit cap below
    // named.length still get all named — the cap is a soft bound on fills,
    // not a ceiling on authored characters.
    const keep = Math.max(opts.cap, named.length);
    dropped = merged.slice(keep);
    merged.length = keep;
  }

  const namedMemoryById = new Map<string, string>();
  for (const p of named) namedMemoryById.set(p.manifest.id, p.memoryRoot);

  return {
    skills: merged,
    named,
    dropped,
    memoryRootFor(id: string): string {
      const nm = namedMemoryById.get(id);
      if (nm) return nm;
      const skill = merged.find((s) => s.id === id);
      if (skill) return join(skillDirectory(skill), 'memory');
      return join(memoryRootDir, id, 'memory');
    },
  };
}

async function readManifest(path: string): Promise<NamedPersonaManifest> {
  const source = await readFile(path, 'utf8');
  const raw = parseYaml(source);
  return validateManifest(raw, path);
}

function validateManifest(raw: unknown, path: string): NamedPersonaManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`named persona manifest ${path} must be a YAML mapping`);
  }
  const r = raw as Record<string, unknown>;
  const id = requireString(r.id, 'id', path);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      `named persona manifest ${path} has invalid id "${id}" (use lowercase-hyphenated)`,
    );
  }
  const name = requireString(r.name, 'name', path);
  const bio = requireString(r.bio, 'bio', path);
  const archetype = requireString(r.archetype, 'archetype', path);
  const voice = requireString(r.voice, 'voice', path);
  const glyph = validateGlyph(r.glyph, path);
  const traits = requireStringArray(r.traits, 'traits', path);
  const routines = requireStringArray(r.routines, 'routines', path);
  const seedMemories = validateSeedMemories(r.seedMemories, path);
  return {
    id,
    name,
    bio,
    archetype,
    glyph,
    traits,
    routines,
    voice,
    seedMemories,
    age: typeof r.age === 'number' ? r.age : undefined,
    occupation: typeof r.occupation === 'string' ? r.occupation : undefined,
  };
}

function validateGlyph(raw: unknown, path: string): NamedPersonaGlyph {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`named persona manifest ${path} is missing glyph`);
  }
  const g = raw as Record<string, unknown>;
  const color = requireString(g.color, 'glyph.color', path);
  const accent = requireString(g.accent, 'glyph.accent', path);
  if (!isHexColor(color) || !isHexColor(accent)) {
    throw new Error(`named persona manifest ${path} glyph colors must be hex (e.g. #a1b2c3)`);
  }
  return { color, accent };
}

function validateSeedMemories(raw: unknown, path: string): NamedPersonaSeedMemory[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`named persona manifest ${path} seedMemories must be a list`);
  }
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`named persona manifest ${path} seedMemories[${i}] must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    const fact = requireString(e.fact, `seedMemories[${i}].fact`, path);
    let category: FactCategory | undefined;
    if (typeof e.category === 'string') {
      if (!FACT_CATEGORIES.includes(e.category as FactCategory)) {
        throw new Error(
          `named persona manifest ${path} seedMemories[${i}].category "${e.category}" not in ${FACT_CATEGORIES.join(
            ',',
          )}`,
        );
      }
      category = e.category as FactCategory;
    }
    const importance = typeof e.importance === 'number' ? e.importance : undefined;
    const related = Array.isArray(e.related_entities)
      ? e.related_entities.filter((x): x is string => typeof x === 'string')
      : undefined;
    return { fact, category, importance, related_entities: related };
  });
}

function requireString(v: unknown, field: string, path: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`named persona manifest ${path} missing string field "${field}"`);
  }
  return v;
}

function requireStringArray(v: unknown, field: string, path: string): string[] {
  if (!Array.isArray(v)) {
    throw new Error(`named persona manifest ${path} field "${field}" must be a list`);
  }
  return v.map((x, i) => {
    if (typeof x !== 'string') {
      throw new Error(`named persona manifest ${path} "${field}[${i}]" must be a string`);
    }
    return x;
  });
}

function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s) || /^#[0-9a-fA-F]{3}$/.test(s);
}

async function readdirOrEmpty(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Synthesize a SkillDocument from a manifest so the existing heartbeat /
 * schedule / reflection pipelines don't need to know anything about named
 * personas. The body is shaped like a hand-written SKILL.md so
 * `inferPersonaSchedule` and `inferPersonaHints` keep working verbatim.
 */
export function manifestToSkill(
  manifest: NamedPersonaManifest,
  manifestPath: string,
): SkillDocument {
  const metadata: Record<string, unknown> = {
    persona_version: '1',
    named: 'true',
    archetype: manifest.archetype,
    glyph_color: manifest.glyph.color,
    glyph_accent: manifest.glyph.accent,
    bio: manifest.bio,
  };
  if (manifest.age !== undefined) metadata.age = String(manifest.age);
  if (manifest.occupation) metadata.occupation = manifest.occupation;

  const metadataYaml = Object.entries(metadata)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  const traitLines = manifest.traits.map((t) => `- ${t}`).join('\n');
  const routineLines = manifest.routines.map((r) => `- ${r}`).join('\n');

  const source = [
    '---',
    `name: ${manifest.id}`,
    `description: ${JSON.stringify(manifest.bio)}`,
    'metadata:',
    metadataYaml,
    '---',
    '',
    `# ${manifest.name}`,
    '',
    '## Traits',
    traitLines,
    '',
    '## Routines',
    routineLines,
    '',
    '## Voice',
    manifest.voice,
    '',
  ].join('\n');

  const doc = parseSkillSource(source, manifestPath);
  return doc;
}
