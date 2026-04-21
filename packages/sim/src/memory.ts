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

export type MemoryFlushMode = 'eager' | 'deferred';

export interface ParaMemoryOptions {
  root: string;
  entity?: string;
  now?: () => Date;
  /**
   * eager (default): every addFact / appendDailyNote writes to disk immediately.
   * deferred: writes are batched in-memory and only persisted on flush().
   * Use deferred when the caller drives its own flush cadence (e.g. Runtime).
   */
  flushMode?: MemoryFlushMode;
}

export class ParaMemory {
  readonly root: string;
  readonly entity: string;
  private now: () => Date;
  private flushMode: MemoryFlushMode;

  private facts: MemoryFact[] | null = null;
  private factsDirty = false;

  private dailyBuffers = new Map<string, string>();
  private dailyLoaded = new Set<string>();
  private dailyDirty = new Set<string>();

  constructor(opts: ParaMemoryOptions) {
    this.root = opts.root;
    this.entity = opts.entity ?? 'self';
    this.now = opts.now ?? (() => new Date());
    this.flushMode = opts.flushMode ?? 'eager';
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

  private planPath(day: number): string {
    return join(this.root, 'life', 'areas', this.entity, 'plans', `day-${day}.yaml`);
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private async loadFacts(): Promise<MemoryFact[]> {
    if (this.facts !== null) return this.facts;
    const raw = await readFileOrEmpty(this.itemsPath());
    if (!raw) {
      this.facts = [];
      return this.facts;
    }
    const parsed = parseYaml(raw);
    this.facts = Array.isArray(parsed) ? (parsed as MemoryFact[]) : [];
    return this.facts;
  }

  private async writeFactsNow(): Promise<void> {
    if (this.facts === null) return;
    await ensureDir(dirname(this.itemsPath()));
    const body = this.facts.length === 0 ? '[]\n' : stringifyYaml(this.facts);
    await writeFile(this.itemsPath(), body, 'utf8');
    this.factsDirty = false;
  }

  private async loadDaily(day: string): Promise<string> {
    if (this.dailyLoaded.has(day)) return this.dailyBuffers.get(day) ?? '';
    const existing = (await readFileOrEmpty(this.dailyPath(day))) ?? '';
    this.dailyBuffers.set(day, existing);
    this.dailyLoaded.add(day);
    return existing;
  }

  private async writeDailyNow(day: string): Promise<void> {
    const body = this.dailyBuffers.get(day);
    if (body === undefined) return;
    await ensureDir(dirname(this.dailyPath(day)));
    await writeFile(this.dailyPath(day), body, 'utf8');
    this.dailyDirty.delete(day);
  }

  async readFacts(): Promise<MemoryFact[]> {
    return [...(await this.loadFacts())];
  }

  async writeFacts(facts: MemoryFact[]): Promise<void> {
    this.facts = [...facts];
    this.factsDirty = true;
    if (this.flushMode === 'eager') await this.writeFactsNow();
  }

  async addFact(input: AddFactInput): Promise<MemoryFact> {
    const facts = await this.loadFacts();
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
    this.factsDirty = true;
    if (this.flushMode === 'eager') await this.writeFactsNow();
    return fact;
  }

  async recentActiveFacts(limit: number): Promise<MemoryFact[]> {
    const facts = await this.loadFacts();
    return facts.filter((f) => f.status === 'active').slice(-limit);
  }

  async supersede(factId: string, replacement: MemoryFact): Promise<void> {
    const facts = await this.loadFacts();
    const existing = facts.find((f) => f.id === factId);
    if (!existing) throw new Error(`fact ${factId} not found`);
    existing.status = 'superseded';
    existing.superseded_by = replacement.id;
    facts.push(replacement);
    this.factsDirty = true;
    if (this.flushMode === 'eager') await this.writeFactsNow();
  }

  async appendDailyNote(text: string, date?: string): Promise<void> {
    const day = date ?? this.today();
    const existing = await this.loadDaily(day);
    const header = existing ? '' : `# ${day}\n\n`;
    const updated = `${existing}${header}- ${text}\n`;
    this.dailyBuffers.set(day, updated);
    this.dailyDirty.add(day);
    if (this.flushMode === 'eager') await this.writeDailyNow(day);
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
    const facts = await this.loadFacts();
    if (facts.length > 0) return;
    for (const line of lines) {
      await this.addFact({ fact: line, category: 'preference' });
    }
  }

  async readPlanRaw(day: number): Promise<unknown | null> {
    const raw = await readFileOrEmpty(this.planPath(day));
    if (!raw) return null;
    return parseYaml(raw);
  }

  async writePlanRaw(day: number, plan: unknown): Promise<void> {
    await ensureDir(dirname(this.planPath(day)));
    await writeFile(this.planPath(day), stringifyYaml(plan), 'utf8');
  }

  /** Persist any buffered writes. Safe to call repeatedly; no-op when clean. */
  async flush(): Promise<void> {
    const pending: Promise<void>[] = [];
    if (this.factsDirty) pending.push(this.writeFactsNow());
    for (const day of this.dailyDirty) pending.push(this.writeDailyNow(day));
    if (pending.length > 0) await Promise.all(pending);
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
