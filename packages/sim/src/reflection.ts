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
  /**
   * How the engine turns raw facts into bullet reflections. Defaults to a
   * deterministic word-frequency summarizer; swap for an LLM-backed one
   * (see `createLlmSynthesizer`) when an API key + budget are available.
   */
  synthesizer?: ReflectionSynthesizer;
  /**
   * Optional label recorded with each reflection so it's obvious which
   * synthesizer produced a given bullet (useful when the LLM path falls
   * back to deterministic mid-run).
   */
  entity?: string;
}

export interface ReflectionResult {
  /** The primary reflection — kept for API compat. Same as `reflections[0]`. */
  reflection: MemoryFact;
  /** All reflection facts written in this pass. LLM synth can return 2-3. */
  reflections: MemoryFact[];
  trigger: ReflectionTrigger;
  sourceFactIds: string[];
}

export interface ReflectionBullet {
  text: string;
  entities: string[];
  importance: number;
  /** Optional per-bullet evidence pointers. Empty = defaults to the full window. */
  sourceFactIds?: string[];
}

export interface SynthesisContext {
  /** Entity the reflections are being written for. */
  entity: string;
  /** Trigger that caused the pass — synthesizer may tailor tone. */
  trigger: ReflectionTrigger;
  /** Simulated day on which the reflection is being written. */
  day: number;
}

export interface ReflectionSynthesizer {
  readonly label: string;
  synthesize(facts: MemoryFact[], ctx: SynthesisContext): Promise<ReflectionBullet[]>;
}

interface InternalState {
  lastReflectedFactCount: number;
  lastReflectedDay: number | null;
  importanceSinceLast: number;
}

/**
 * Periodically compresses recent raw memory into higher-order reflection
 * facts, written back into the same ParaMemory store. Retrieval naturally
 * prefers reflections because of their importance score.
 *
 * Synthesis is pluggable: the default is a deterministic keyword summarizer
 * that never makes network calls. Use `createLlmSynthesizer` for an
 * Anthropic-backed synthesizer that returns multiple bullets with per-bullet
 * evidence pointers; that synthesizer respects an injected spend budget and
 * automatically falls back to the deterministic summarizer when exhausted.
 */
export class ReflectionEngine {
  private readonly importanceBudget: number;
  private readonly minFacts: number;
  private readonly windowSize: number;
  private readonly synthesizer: ReflectionSynthesizer;
  private readonly state: InternalState = {
    lastReflectedFactCount: 0,
    lastReflectedDay: null,
    importanceSinceLast: 0,
  };

  constructor(opts: ReflectionEngineOptions = {}) {
    this.importanceBudget = opts.importanceBudget ?? 30;
    this.minFacts = opts.minFacts ?? 5;
    this.windowSize = opts.windowSize ?? 25;
    this.synthesizer = opts.synthesizer ?? deterministicSynthesizer();
  }

  /**
   * Call when a new raw fact lands. Tracks budget for the next mid-day reflection.
   */
  noteNewFact(fact: MemoryFact): void {
    if (fact.category === 'reflection') return;
    this.state.importanceSinceLast += fact.importance;
  }

  /**
   * Decide whether to consolidate, and if so, write reflection fact(s).
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
    const bullets = await this.synthesizer.synthesize(window, {
      entity: memory.entity,
      trigger,
      day,
    });
    const kept = bullets.filter((b) => b.text.trim().length > 0);
    if (kept.length === 0) {
      this.state.lastReflectedDay = day;
      this.state.importanceSinceLast = 0;
      return null;
    }

    const allWindowIds = window.map((f) => f.id);
    const written: MemoryFact[] = [];
    for (const b of kept) {
      const sourceIds =
        b.sourceFactIds && b.sourceFactIds.length > 0 ? b.sourceFactIds : allWindowIds;
      const fact = await memory.addFact({
        fact: b.text.trim(),
        category: 'reflection',
        related_entities: b.entities,
        source: `reflection:${trigger}:day-${day}:${this.synthesizer.label}`,
        importance: b.importance,
        derived_from: sourceIds,
      });
      written.push(fact);
    }

    this.state.lastReflectedFactCount = totalRaw;
    this.state.lastReflectedDay = day;
    this.state.importanceSinceLast = 0;

    return {
      reflection: written[0]!,
      reflections: written,
      trigger,
      sourceFactIds: allWindowIds,
    };
  }

  /** Test/diagnostic accessor for the internal counters. */
  debugState(): InternalState {
    return { ...this.state };
  }
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

/**
 * Deterministic, zero-LLM synthesizer. Identical behavior to the original
 * TINA-9 reflection logic — returns a single summary bullet derived from
 * top entities, top content words, and any standout milestones in the
 * window. Used as the default and as the fallback path when the LLM
 * synthesizer is disabled or out of budget.
 */
export function deterministicSynthesizer(): ReflectionSynthesizer {
  return {
    label: 'deterministic',
    async synthesize(facts: MemoryFact[]): Promise<ReflectionBullet[]> {
      if (facts.length === 0) return [];

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
        parts.push(`recurring activity across ${facts.length} recent moments`);
      }

      const baseImportance = 7;
      const bump = Math.min(2, Math.floor((relationships.length + milestones.length * 2) / 3));
      const importance = Math.min(10, baseImportance + bump);

      return [
        {
          text: parts.join(' · '),
          entities: topEntities,
          importance,
          sourceFactIds: facts.map((f) => f.id),
        },
      ];
    },
  };
}
