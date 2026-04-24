import type {
  AgentAction,
  AgentSnap,
  Location,
  SimTime,
  Vec2,
  WorldObject,
  Zone,
} from '@tina/shared';
import type { Agent } from './agent.js';
import type { MemoryFact } from './memory.js';

export type TimeOfDay = 'dawn' | 'morning' | 'midday' | 'afternoon' | 'evening' | 'night';

export type SpeechSource = 'natural' | 'intervention';

export interface HeardSpeech {
  speakerId: string;
  speakerName: string;
  text: string;
  at: SimTime;
  source?: SpeechSource;
}

export type ObservedEventKind =
  | 'world_event'
  | 'object_drop'
  | 'object_remove'
  | 'object_use'
  | 'relationship_nudge';

export interface ObservedEvent {
  kind: ObservedEventKind;
  source: 'intervention';
  text: string;
  zone: string | null;
  at: SimTime;
}

export interface Perception {
  tick: number;
  simTime: SimTime;
  timeOfDay: TimeOfDay;
  self: AgentSnap;
  nearby: AgentSnap[];
  recentSpeech: HeardSpeech[];
  recentFacts: MemoryFact[];
  recentObservations: ObservedEvent[];
  worldBounds: { width: number; height: number };
  zones: Zone[];
  locations: Location[];
  /**
   * Optional per-zone affinity weights, aggregated from the agent's pair
   * relationships with other agents currently in those zones (TINA-207).
   * Present for named characters when the runtime was configured with a
   * RelationshipStore; null/undefined otherwise. Heartbeat uses this to
   * softly bias leisure-hour zone picks toward high-affinity friends.
   */
  zoneAffinityHints?: Map<string, number> | null;
  /**
   * All currently-dropped affordance objects in the world (TINA-416). The
   * heartbeat policy reads this to deterministically bias named-character
   * routing toward matching objects (`bench`/`music` for leisure, `food` for
   * eat blocks). Untyped objects are excluded. Empty array when none exist.
   */
  affordanceObjects: WorldObject[];
}

const DAY_SECONDS = 86400;
const TIME_BANDS: Array<{ end: number; label: TimeOfDay }> = [
  { end: 6, label: 'dawn' },
  { end: 11, label: 'morning' },
  { end: 14, label: 'midday' },
  { end: 18, label: 'afternoon' },
  { end: 21, label: 'evening' },
  { end: 24, label: 'night' },
];

export function timeOfDay(simTime: SimTime): TimeOfDay {
  const seconds = ((simTime % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  const hours = seconds / 3600;
  for (const band of TIME_BANDS) {
    if (hours < band.end) return band.label;
  }
  return 'night';
}

export function chebyshevDistance(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function nearbyAgents(self: Agent, others: Agent[], radius: number): AgentSnap[] {
  const out: AgentSnap[] = [];
  for (const other of others) {
    if (other.def.id === self.def.id) continue;
    if (chebyshevDistance(self.state.position, other.state.position) <= radius) {
      out.push(other.snapshot());
    }
  }
  return out;
}

export function describeAction(action: AgentAction): string {
  switch (action.kind) {
    case 'move_to':
      return `move to (${action.to.x},${action.to.y})`;
    case 'goto':
      return action.label
        ? `goto ${action.label} (${action.target.x},${action.target.y})`
        : `goto (${action.target.x},${action.target.y})`;
    case 'speak':
      return `speak "${action.text}"`;
    case 'wait':
      return `wait ${action.seconds}s`;
    case 'set_goal':
      return `goal: ${action.goal}`;
    case 'remember':
      return `remember "${action.fact.slice(0, 60)}"`;
  }
}

export function stepToward(from: Vec2, to: Vec2): Vec2 {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  return { x: from.x + dx, y: from.y + dy };
}
