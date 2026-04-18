import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SkillFrontmatter {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SkillDocument {
  id: string;
  displayName: string;
  description: string;
  metadata: Record<string, string>;
  body: string;
  path: string;
  raw: SkillFrontmatter;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export function parseSkillSource(source: string, path: string): SkillDocument {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`SKILL.md at ${path} is missing YAML frontmatter`);
  }
  const fm = parseYaml(match[1] ?? '') as SkillFrontmatter | null;
  if (!fm || typeof fm !== 'object') {
    throw new Error(`SKILL.md at ${path} has invalid frontmatter`);
  }
  if (typeof fm.name !== 'string' || fm.name.length === 0) {
    throw new Error(`SKILL.md at ${path} must define a string "name" in frontmatter`);
  }
  const body = (match[2] ?? '').trimEnd();
  const displayName = extractFirstHeading(body) ?? toTitleCase(fm.name);
  const metadata = flattenMetadata(fm.metadata);

  return {
    id: fm.name,
    displayName,
    description: typeof fm.description === 'string' ? fm.description : '',
    metadata,
    body,
    path,
    raw: fm,
  };
}

export async function loadSkill(path: string): Promise<SkillDocument> {
  const absolute = resolve(path);
  const source = await readFile(absolute, 'utf8');
  return parseSkillSource(source, absolute);
}

export async function loadAllSkills(dir: string): Promise<SkillDocument[]> {
  const absolute = resolve(dir);
  const entries = await readdir(absolute, { withFileTypes: true });
  const docs: SkillDocument[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(absolute, entry.name, 'SKILL.md');
    try {
      docs.push(await loadSkill(skillPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  docs.sort((a, b) => a.id.localeCompare(b.id));
  return docs;
}

export function skillDirectory(doc: SkillDocument): string {
  return dirname(doc.path);
}

export function skillSlugFromPath(path: string): string {
  return basename(dirname(path));
}

function extractFirstHeading(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) return trimmed.slice(2).trim();
  }
  return null;
}

function toTitleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

function flattenMetadata(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}
