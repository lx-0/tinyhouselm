import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type FactCategory = 'relationship' | 'milestone' | 'status' | 'preference' | 'observation';

export interface MemoryFact {
  id: string;
  fact: string;
  category: FactCategory;
  timestamp: string;
  source: string;
  status: 'active' | 'superseded';
  superseded_by: string | null;
  related_entities: string[];
  last_accessed: string;
  access_count: number;
}

export interface AddFactInput {
  fact: string;
  category?: FactCategory;
  related_entities?: string[];
  source?: string;
}

export interface ParaMemoryOptions {
  root: string;
  entity?: string;
  now?: () => Date;
}

export class ParaMemory {
  readonly root: string;
  readonly entity: string;
  private now: () => Date;

  constructor(opts: ParaMemoryOptions) {
    this.root = opts.root;
    this.entity = opts.entity ?? 'self';
    this.now = opts.now ?? (() => new Date());
  }

  private itemsPath(): string {
    return join(this.root, 'life', 'areas', this.entity, 'items.yaml');
  }

  private summaryPath(): string {
    return join(this.root, 'life', 'areas', this.entity, 'summary.md');
  }

  private dailyPath(date: string): string {
    return join(this.root, 'memory', `${date}.md`);
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  async readFacts(): Promise<MemoryFact[]> {
    const raw = await readFileOrEmpty(this.itemsPath());
    if (!raw) return [];
    const parsed = parseYaml(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as MemoryFact[];
  }

  async writeFacts(facts: MemoryFact[]): Promise<void> {
    await ensureDir(dirname(this.itemsPath()));
    const body = facts.length === 0 ? '[]\n' : stringifyYaml(facts);
    await writeFile(this.itemsPath(), body, 'utf8');
  }

  async addFact(input: AddFactInput): Promise<MemoryFact> {
    const facts = await this.readFacts();
    const date = this.today();
    const id = `${this.entity}-${facts.length + 1}`;
    const fact: MemoryFact = {
      id,
      fact: input.fact,
      category: input.category ?? 'observation',
      timestamp: date,
      source: input.source ?? date,
      status: 'active',
      superseded_by: null,
      related_entities: input.related_entities ?? [],
      last_accessed: date,
      access_count: 0,
    };
    facts.push(fact);
    await this.writeFacts(facts);
    return fact;
  }

  async recentActiveFacts(limit: number): Promise<MemoryFact[]> {
    const facts = await this.readFacts();
    return facts.filter((f) => f.status === 'active').slice(-limit);
  }

  async supersede(factId: string, replacement: MemoryFact): Promise<void> {
    const facts = await this.readFacts();
    const existing = facts.find((f) => f.id === factId);
    if (!existing) throw new Error(`fact ${factId} not found`);
    existing.status = 'superseded';
    existing.superseded_by = replacement.id;
    facts.push(replacement);
    await this.writeFacts(facts);
  }

  async appendDailyNote(text: string, date?: string): Promise<void> {
    const day = date ?? this.today();
    const path = this.dailyPath(day);
    await ensureDir(dirname(path));
    const existing = (await readFileOrEmpty(path)) ?? '';
    const header = existing ? '' : `# ${day}\n\n`;
    await writeFile(path, `${existing}${header}- ${text}\n`, 'utf8');
  }

  async readSummary(): Promise<string> {
    return (await readFileOrEmpty(this.summaryPath())) ?? '';
  }

  async writeSummary(text: string): Promise<void> {
    await ensureDir(dirname(this.summaryPath()));
    await writeFile(this.summaryPath(), text, 'utf8');
  }

  async seedFromTraits(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const facts = await this.readFacts();
    if (facts.length > 0) return;
    for (const line of lines) {
      await this.addFact({ fact: line, category: 'preference' });
    }
  }
}

async function readFileOrEmpty(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
