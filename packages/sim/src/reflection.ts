import type { SimTime } from '@tina/shared';
import type { MemoryFact, ParaMemory } from './memory.js';
import { simDay } from './plan.js';

export type ReflectionTrigger = 'day_rollover' | 'importance_budget' | 'manual';

export interface ReflectionEngineOptions {
  /**
   * Cumulative importance of new raw facts that triggers a reflection even
   * mid-day. Default 30 — roughly ten observations of importance 3 each.
   */
  importanceBudget?: number;
  /**
   * Hard floor on raw facts considered. Below this we skip — there isn't
   * enough signal to consolidate.
   */
  minFacts?: number;
  /**
   * Cap on raw facts looked at during synthesis. Default 25.
   */
  windowSize?: number;
}

export interface ReflectionResult {
  reflection: MemoryFact;
  trigger: ReflectionTrigger;
  sourceFactIds: string[];
}

interface InternalState {
  lastReflectedFactCount: number;
  lastReflectedDay: number | null;
  importanceSinceLast: number;
}

/**
 * Periodically compresses recent raw memory into a higher-order reflection
 * fact, written back into the same ParaMemory store. Retrieval naturally
 * prefers reflections because of their importance score.
 *
 * Synthesis is deterministic: it picks out the most-mentioned people, the
 * most-frequent zones, the dominant activity verbs, and any standout
 * milestones from the window. An LLM-backed synthesizer can plug into the
 * same `summarize()` seam later.
 */
export class ReflectionEngine {
  private readonly importanceBudget: number;
  private readonly minFacts: number;
  private readonly windowSize: number;
  private readonly state: InternalState = {
    lastReflectedFactCount: 0,
    lastReflectedDay: null,
    importanceSinceLast: 0,
  };

  constructor(opts: ReflectionEngineOptions = {}) {
    this.importanceBudget = opts.importanceBudget ?? 30;
    this.minFacts = opts.minFacts ?? 5;
    this.windowSize = opts.windowSize ?? 25;
  }

  /**
   * Call when a new raw fact lands. Tracks budget for the next mid-day reflection.
   */
  noteNewFact(fact: MemoryFact): void {
    if (fact.category === 'reflection') return;
    this.state.importanceSinceLast += fact.importance;
  }

  /**
   * Decide whether to consolidate, and if so, write a reflection fact.
   * Returns `null` when the trigger doesn't fire or there isn't enough signal.
   */
  async maybeReflect(args: {
    memory: ParaMemory;
    simTime: SimTime;
    trigger?: ReflectionTrigger;
  }): Promise<ReflectionResult | null> {
    const { memory, simTime } = args;
    const day = simDay(simTime);

    const facts = await memory.readFacts();
    const rawFacts = facts.filter((f) => f.status === 'active' && f.category !== 'reflection');
    const totalRaw = rawFacts.length;

    let trigger: ReflectionTrigger | null = args.trigger ?? null;
    if (trigger === undefined || trigger === null) {
      if (this.state.lastReflectedDay !== null && day > this.state.lastReflectedDay) {
        trigger = 'day_rollover';
      } else if (this.state.importanceSinceLast >= this.importanceBudget) {
        trigger = 'importance_budget';
      }
    }
    // First-ever call: only fire on day_rollover or budget; otherwise just bookmark.
    if (trigger === null) {
      if (this.state.lastReflectedDay === null) this.state.lastReflectedDay = day;
      return null;
    }

    const newRaw = rawFacts.slice(this.state.lastReflectedFactCount);
    if (newRaw.length < this.minFacts) {
      // Not enough signal yet — don't produce noise reflections.
      this.state.lastReflectedDay = day;
      this.state.importanceSinceLast = 0;
      return null;
    }

    const window = newRaw.slice(-this.windowSize);
    const summary = synthesize(window);
    if (!summary.text) {
      this.state.lastReflectedDay = day;
      this.state.importanceSinceLast = 0;
      return null;
    }

    const reflection = await memory.addFact({
      fact: summary.text,
      category: 'reflection',
      related_entities: summary.entities,
      source: `reflection:${trigger}:day-${day}`,
      importance: summary.importance,
      derived_from: window.map((f) => f.id),
    });

    this.state.lastReflectedFactCount = totalRaw;
    this.state.lastReflectedDay = day;
    this.state.importanceSinceLast = 0;

    return { reflection, trigger, sourceFactIds: window.map((f) => f.id) };
  }

  /** Test/diagnostic accessor for the internal counters. */
  debugState(): InternalState {
    return { ...this.state };
  }
}

interface Synthesis {
  text: string;
  entities: string[];
  importance: number;
}

const STOPWORDS = new Set([
  'the',
  'and',
  'with',
  'from',
  'that',
  'this',
  'into',
  'have',
  'had',
  'has',
  'was',
  'were',
  'are',
  'for',
  'her',
  'his',
  'him',
  'she',
  'they',
  'them',
  'their',
  'about',
  'over',
  'just',
  'still',
  'then',
  'than',
  'some',
  'said',
  'told',
  'felt',
  'feel',
  'went',
  'where',
  'when',
  'what',
  'who',
  'how',
  'time',
  'day',
  'today',
  'morning',
  'evening',
  'night',
  'afternoon',
  'midday',
  'dawn',
  'shared',
  'space',
  'overheard',
  'committed',
  'heard',
  'saw',
  'after',
  'before',
  'noon',
  'around',
  'near',
  'next',
  'last',
]);

function synthesize(facts: MemoryFact[]): Synthesis {
  if (facts.length === 0) return { text: '', entities: [], importance: 5 };

  const entityCounts = new Map<string, number>();
  const wordCounts = new Map<string, number>();
  const milestones: string[] = [];
  const relationships: string[] = [];

  for (const f of facts) {
    for (const e of f.related_entities) {
      entityCounts.set(e, (entityCounts.get(e) ?? 0) + 1);
    }
    for (const w of f.fact.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length < 4 || STOPWORDS.has(w)) continue;
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
    if (f.category === 'milestone') milestones.push(f.fact);
    if (f.category === 'relationship') relationships.push(f.fact);
  }

  const topEntities = [...entityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([e]) => e);
  const topWords = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w);

  const parts: string[] = [];
  if (relationships.length > 0 && topEntities.length > 0) {
    parts.push(`spent time with ${topEntities.join(', ')}`);
  } else if (topEntities.length > 0) {
    parts.push(`crossed paths with ${topEntities.join(', ')}`);
  }
  if (topWords.length > 0) {
    parts.push(`themes: ${topWords.join(', ')}`);
  }
  if (milestones.length > 0) {
    parts.push(`notable: ${milestones[0]!.slice(0, 80)}`);
  }

  if (parts.length === 0) {
    // Fall back to a frequency-only summary so we never write empty reflections.
    parts.push(`recurring activity across ${facts.length} recent moments`);
  }

  // Importance scales with how much signal we found — more relationships and
  // milestones means a denser reflection that retrieval should prefer.
  const baseImportance = 7;
  const bump = Math.min(2, Math.floor((relationships.length + milestones.length * 2) / 3));
  const importance = Math.min(10, baseImportance + bump);

  return {
    text: parts.join(' · '),
    entities: topEntities,
    importance,
  };
}
