import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type FactCategory =
  | 'relationship'
  | 'milestone'
  | 'status'
  | 'preference'
  | 'observation'
  | 'reflection';

export const DEFAULT_IMPORTANCE: Record<FactCategory, number> = {
  reflection: 7,
  milestone: 8,
  relationship: 6,
  preference: 5,
  status: 4,
  observation: 3,
};

export interface MemoryFact {
  id: string;
  fact: string;
  category: FactCategory;
  importance: number;
  timestamp: string;
  source: string;
  status: 'active' | 'superseded';
  superseded_by: string | null;
  related_entities: string[];
  last_accessed: string;
  access_count: number;
  /** Source fact ids the reflection was synthesized from. Empty for raw facts. */
  derived_from?: string[];
}

export interface AddFactInput {
  fact: string;
  category?: FactCategory;
  related_entities?: string[];
  source?: string;
  importance?: number;
  derived_from?: string[];
}

export interface RecallOptions {
  /** Optional free-text query. Lowercased and tokenized for relevance scoring. */
  query?: string;
  /** Optional related entity ids that boost relevance when they overlap. */
  relatedTo?: string[];
  /** Max number of facts to return. */
  limit: number;
  /** Reference time used for recency decay. Defaults to memory.now(). */
  now?: Date;
  /** Decay half-life in seconds for the recency factor. Default 6 hours of wall time. */
  recencyHalfLifeSec?: number;
}

export interface RecalledFact {
  fact: MemoryFact;
  score: number;
  recency: number;
  importance: number;
  relevance: number;
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
  /**
   * Hard cap on retained facts per entity. When exceeded, `addFact` trims:
   * superseded facts first, then oldest dispensable categories
   * (observation/status/relationship), then oldest non-reflection.
   * Reflections are preserved as long as possible. Default: 500.
   */
  maxFacts?: number;
  /**
   * Hard cap on buffered daily-note entries per day. When exceeded,
   * `appendDailyNote` drops the oldest *appended* entries but always keeps
   * the buffer's first element (the header / prior on-disk body). Default: 2000.
   */
  maxDailyLines?: number;
}

const DEFAULT_MAX_FACTS = 500;
const DEFAULT_MAX_DAILY_LINES = 2000;

export class ParaMemory {
  readonly root: string;
  readonly entity: string;
  private now: () => Date;
  private flushMode: MemoryFlushMode;
  private readonly maxFacts: number;
  private readonly maxDailyLines: number;

  private facts: MemoryFact[] | null = null;
  private factsDirty = false;

  // Array-backed to keep appendDailyNote O(1) amortized. Joining the chunks
  // only happens at flush time, so hot paths that fire hundreds of appends
  // per tick don't realloc a whole buffer per call.
  private dailyBuffers = new Map<string, string[]>();
  private dailyDirty = new Set<string>();

  constructor(opts: ParaMemoryOptions) {
    this.root = opts.root;
    this.entity = opts.entity ?? 'self';
    this.now = opts.now ?? (() => new Date());
    this.flushMode = opts.flushMode ?? 'eager';
    this.maxFacts = Math.max(1, Math.floor(opts.maxFacts ?? DEFAULT_MAX_FACTS));
    this.maxDailyLines = Math.max(2, Math.floor(opts.maxDailyLines ?? DEFAULT_MAX_DAILY_LINES));
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
    const list = Array.isArray(parsed) ? (parsed as MemoryFact[]) : [];
    // Backfill importance for facts written before the field existed.
    for (const f of list) {
      if (typeof f.importance !== 'number') {
        f.importance = DEFAULT_IMPORTANCE[f.category] ?? 3;
      }
    }
    this.facts = list;
    return this.facts;
  }

  private async writeFactsNow(): Promise<void> {
    if (this.facts === null) return;
    await ensureDir(dirname(this.itemsPath()));
    const body = this.facts.length === 0 ? '[]\n' : stringifyYaml(this.facts);
    await writeFile(this.itemsPath(), body, 'utf8');
    this.factsDirty = false;
  }

  private async loadDailyBuf(day: string): Promise<string[]> {
    const cached = this.dailyBuffers.get(day);
    if (cached) return cached;
    const existing = (await readFileOrEmpty(this.dailyPath(day))) ?? '';
    const buf: string[] = existing ? [existing] : [`# ${day}\n\n`];
    this.dailyBuffers.set(day, buf);
    return buf;
  }

  private async writeDailyNow(day: string): Promise<void> {
    const buf = this.dailyBuffers.get(day);
    if (buf === undefined) return;
    await ensureDir(dirname(this.dailyPath(day)));
    await writeFile(this.dailyPath(day), buf.join(''), 'utf8');
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
    const category = input.category ?? 'observation';
    const fact: MemoryFact = {
      id,
      fact: input.fact,
      category,
      importance: clampImportance(input.importance ?? DEFAULT_IMPORTANCE[category]),
      timestamp: date,
      source: input.source ?? date,
      status: 'active',
      superseded_by: null,
      related_entities: input.related_entities ?? [],
      last_accessed: date,
      access_count: 0,
      ...(input.derived_from && input.derived_from.length > 0
        ? { derived_from: input.derived_from }
        : {}),
    };
    facts.push(fact);
    if (facts.length > this.maxFacts) {
      this.facts = trimFacts(facts, this.maxFacts);
    }
    this.factsDirty = true;
    if (this.flushMode === 'eager') await this.writeFactsNow();
    return fact;
  }

  async recentActiveFacts(limit: number): Promise<MemoryFact[]> {
    const facts = await this.loadFacts();
    return facts.filter((f) => f.status === 'active').slice(-limit);
  }

  async recentReflections(limit: number): Promise<MemoryFact[]> {
    const facts = await this.loadFacts();
    return facts.filter((f) => f.status === 'active' && f.category === 'reflection').slice(-limit);
  }

  /**
   * Park et al.-style retrieval: rank active facts by recency × importance × relevance.
   * Reflections naturally outrank raw observations because they carry higher
   * default importance, so a long-lived agent can read top-K instead of dumping
   * its whole memory into the prompt.
   */
  async recallForDecision(opts: RecallOptions): Promise<RecalledFact[]> {
    const facts = await this.loadFacts();
    const active = facts.filter((f) => f.status === 'active');
    if (active.length === 0) return [];
    const now = (opts.now ?? this.now()).getTime();
    const halfLife = (opts.recencyHalfLifeSec ?? 6 * 3600) * 1000;
    const queryTokens = tokenize(opts.query ?? '');
    const relatedSet = new Set(opts.relatedTo ?? []);
    const scored = active.map((fact) => {
      const recency = recencyScore(fact, now, halfLife);
      const importance = fact.importance / 10;
      const relevance = relevanceScore(fact, queryTokens, relatedSet);
      const score = recency * 0.4 + importance * 0.4 + relevance * 0.2;
      return { fact, score, recency, importance, relevance };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit);
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
    const buf = await this.loadDailyBuf(day);
    buf.push(`- ${text}\n`);
    // Bound the in-memory buffer. `buf[0]` is the header or the prior on-disk
    // body; we always keep it so repeated rewrites stay idempotent. Drop only
    // oldest *appended* entries when over cap.
    if (buf.length > this.maxDailyLines) {
      buf.splice(1, buf.length - this.maxDailyLines);
    }
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

function clampImportance(n: number): number {
  if (Number.isNaN(n)) return 3;
  return Math.min(10, Math.max(1, Math.round(n)));
}

const DISPENSABLE_CATEGORIES: ReadonlySet<FactCategory> = new Set<FactCategory>([
  'observation',
  'status',
  'relationship',
]);

/**
 * Bound the retained fact set when it grows past `maxFacts`. Strategy,
 * in order until we're under cap:
 *   1. Drop superseded facts (dead weight — nothing active reads them).
 *   2. Drop oldest dispensable facts (observation / status / relationship).
 *      These dominate in dense simulations because every conversation close
 *      appends a `talked with X` relationship fact.
 *   3. If still over cap, drop oldest non-reflection facts.
 * Reflections are preserved as long as at least one non-reflection remains
 * above the cap — they carry Park et al.-style high-importance signal that
 * long-running agents rely on for decision-making.
 */
function trimFacts(facts: readonly MemoryFact[], maxFacts: number): MemoryFact[] {
  let out = facts.filter((f) => f.status !== 'superseded');
  if (out.length <= maxFacts) return [...out];

  let drop = out.length - maxFacts;
  const afterDispensable: MemoryFact[] = [];
  for (const f of out) {
    if (drop > 0 && DISPENSABLE_CATEGORIES.has(f.category)) {
      drop -= 1;
      continue;
    }
    afterDispensable.push(f);
  }
  out = afterDispensable;
  if (out.length <= maxFacts) return out;

  let extra = out.length - maxFacts;
  const afterNonReflection: MemoryFact[] = [];
  for (const f of out) {
    if (extra > 0 && f.category !== 'reflection') {
      extra -= 1;
      continue;
    }
    afterNonReflection.push(f);
  }
  return afterNonReflection;
}

function tokenize(s: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

function recencyScore(fact: MemoryFact, nowMs: number, halfLifeMs: number): number {
  const ts = Date.parse(fact.timestamp);
  if (Number.isNaN(ts)) return 0.1;
  const ageMs = Math.max(0, nowMs - ts);
  // Exponential decay: score halves every halfLifeMs.
  return 2 ** (-ageMs / halfLifeMs);
}

function relevanceScore(fact: MemoryFact, queryTokens: string[], relatedSet: Set<string>): number {
  if (queryTokens.length === 0 && relatedSet.size === 0) return 0.5;
  let score = 0;
  if (relatedSet.size > 0) {
    const overlap = fact.related_entities.filter((e) => relatedSet.has(e)).length;
    if (overlap > 0) score += Math.min(1, overlap / relatedSet.size);
  }
  if (queryTokens.length > 0) {
    const factTokens = new Set(tokenize(fact.fact));
    const hits = queryTokens.filter((t) => factTokens.has(t)).length;
    if (hits > 0) score += Math.min(1, hits / queryTokens.length);
  }
  return Math.min(1, score);
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
