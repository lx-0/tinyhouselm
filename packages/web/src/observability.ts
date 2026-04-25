import type { ConversationTurn, SimTime } from '@tina/shared';

/**
 * In-memory observability store for the admin dashboard. Holds a rolling
 * history of conversations and plan/reflection events so a late-connecting
 * admin client can bootstrap without a fresh boot, plus an undirected
 * relationship graph derived from conversation closes.
 *
 * Bounded by entry count — this is not a historical record, just what the
 * dashboard needs to render "recent" activity.
 */

export interface ObservabilityConversation {
  sessionId: string;
  participants: string[];
  participantNames: string[];
  transcript: ConversationTurn[];
  openedAt: SimTime;
  closedAt: SimTime;
  reason: 'drifted' | 'idle' | 'aged';
}

export interface ObservabilityPlanEvent {
  kind: 'plan_committed' | 'plan_replan' | 'plan_resume';
  id: string;
  name: string;
  simTime: SimTime;
  detail: string;
}

export interface ObservabilityReflectionEvent {
  id: string;
  name: string;
  reflectionId: string;
  summary: string;
  sourceCount: number;
  trigger: 'day_rollover' | 'importance_budget' | 'manual';
  simTime: SimTime;
}

export interface RelationEdge {
  a: string;
  b: string;
  conversations: number;
  turns: number;
  lastAt: SimTime;
}

/**
 * One typed-affordance use (TINA-416). Recorded into a per-agent ring buffer
 * so the per-character profile (TINA-482) can render the last N uses without
 * a fresh disk read. Capped per-agent — see `ObservabilityStoreOptions`.
 */
export interface ObservabilityAffordanceEvent {
  agentId: string;
  agentName: string;
  objectId: string;
  label: string;
  affordance: string;
  zone: string | null;
  simTime: SimTime;
}

export interface ObservabilityBootstrap {
  conversations: ObservabilityConversation[];
  planEvents: ObservabilityPlanEvent[];
  reflections: ObservabilityReflectionEvent[];
  relations: RelationEdge[];
}

export interface ObservabilityStoreOptions {
  maxConversations?: number;
  maxPlanEvents?: number;
  maxReflections?: number;
  /**
   * Per-agent ring-buffer cap for affordance uses (TINA-482). Default 30 —
   * comfortably above the 10-event slice the character profile renders, while
   * still bounded so a long-lived process can't accumulate forever.
   */
  maxAffordancesPerAgent?: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class ObservabilityStore {
  private conversations: ObservabilityConversation[] = [];
  private planEvents: ObservabilityPlanEvent[] = [];
  private reflections: ObservabilityReflectionEvent[] = [];
  private relations = new Map<string, RelationEdge>();
  private affordancesByAgent = new Map<string, ObservabilityAffordanceEvent[]>();
  private readonly maxConversations: number;
  private readonly maxPlanEvents: number;
  private readonly maxReflections: number;
  private readonly maxAffordancesPerAgent: number;

  constructor(opts: ObservabilityStoreOptions = {}) {
    this.maxConversations = opts.maxConversations ?? 60;
    this.maxPlanEvents = opts.maxPlanEvents ?? 120;
    this.maxReflections = opts.maxReflections ?? 40;
    this.maxAffordancesPerAgent = Math.max(1, opts.maxAffordancesPerAgent ?? 30);
  }

  recordConversation(entry: ObservabilityConversation): void {
    this.conversations.unshift(entry);
    if (this.conversations.length > this.maxConversations) {
      this.conversations.length = this.maxConversations;
    }
    this.updateRelations(entry);
  }

  recordPlanEvent(entry: ObservabilityPlanEvent): void {
    this.planEvents.unshift(entry);
    if (this.planEvents.length > this.maxPlanEvents) {
      this.planEvents.length = this.maxPlanEvents;
    }
  }

  recordReflection(entry: ObservabilityReflectionEvent): void {
    this.reflections.unshift(entry);
    if (this.reflections.length > this.maxReflections) {
      this.reflections.length = this.maxReflections;
    }
  }

  /**
   * Push one typed-affordance use into the per-agent ring buffer (TINA-482).
   * Called from the server's `object_used` handler. Newest first, capped per
   * agent — so the character profile page can read the slice without paying
   * a disk hit and the buffer can't grow without bound.
   */
  recordAffordanceEvent(entry: ObservabilityAffordanceEvent): void {
    let ring = this.affordancesByAgent.get(entry.agentId);
    if (!ring) {
      ring = [];
      this.affordancesByAgent.set(entry.agentId, ring);
    }
    ring.unshift(entry);
    if (ring.length > this.maxAffordancesPerAgent) {
      ring.length = this.maxAffordancesPerAgent;
    }
  }

  /**
   * Most recent affordance uses for one agent, newest first. Returns at most
   * `limit` entries (default 10). Returns an empty array for unknown agents.
   */
  recentAffordancesFor(agentId: string, limit = 10): ObservabilityAffordanceEvent[] {
    const ring = this.affordancesByAgent.get(agentId);
    if (!ring || ring.length === 0) return [];
    return ring.slice(0, Math.max(0, limit));
  }

  private updateRelations(entry: ObservabilityConversation): void {
    const turnsPerSpeaker = new Map<string, number>();
    for (const t of entry.transcript) {
      turnsPerSpeaker.set(t.speakerId, (turnsPerSpeaker.get(t.speakerId) ?? 0) + 1);
    }
    const participants = [...entry.participants];
    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        const a = participants[i]!;
        const b = participants[j]!;
        const key = pairKey(a, b);
        const existing = this.relations.get(key);
        const turns = (turnsPerSpeaker.get(a) ?? 0) + (turnsPerSpeaker.get(b) ?? 0);
        if (existing) {
          existing.conversations += 1;
          existing.turns += turns;
          existing.lastAt = Math.max(existing.lastAt, entry.closedAt);
        } else {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          this.relations.set(key, {
            a: lo,
            b: hi,
            conversations: 1,
            turns,
            lastAt: entry.closedAt,
          });
        }
      }
    }
  }

  bootstrap(): ObservabilityBootstrap {
    return {
      conversations: [...this.conversations],
      planEvents: [...this.planEvents],
      reflections: [...this.reflections],
      relations: [...this.relations.values()].sort((x, y) => y.conversations - x.conversations),
    };
  }

  relationsList(): RelationEdge[] {
    return [...this.relations.values()];
  }
}
