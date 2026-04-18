import type { AgentAction, Vec2 } from '@tina/shared';
import type { ParaMemory } from './memory.js';
import type { Perception } from './perception.js';
import { type Rng, pick, seededRng } from './rng.js';
import type { SkillDocument } from './skills.js';

export interface HeartbeatContext {
  persona: SkillDocument;
  perception: Perception;
  memory: ParaMemory;
  rng: Rng;
}

export interface HeartbeatPolicy {
  decide(ctx: HeartbeatContext): Promise<AgentAction[]>;
}

export interface PersonaHints {
  talkativeness: number;
  restlessness: number;
  greetings: string[];
  replies: string[];
  musings: string[];
}

const DEFAULT_GREETINGS = ['hey.', 'morning.', 'hi there.', 'yo.', 'heya.'];
const DEFAULT_REPLIES = ['yeah.', 'mhm.', 'for sure.', 'true.', 'same.'];
const DEFAULT_MUSINGS = [
  'nice light today.',
  'long day.',
  'coffee was rough.',
  'thinking.',
  'quiet out.',
];

export function inferPersonaHints(persona: SkillDocument): PersonaHints {
  const haystack = `${persona.description}\n${persona.body}`.toLowerCase();
  let talkativeness = 0.35;
  if (/introvert|shy|quiet|reserved/.test(haystack)) talkativeness -= 0.15;
  if (/extrovert|outgoing|social|chatty|loud/.test(haystack)) talkativeness += 0.3;
  talkativeness = clamp(talkativeness, 0.05, 0.95);

  let restlessness = 0.35;
  if (/lazy|still|slow|tired|sedentary/.test(haystack)) restlessness -= 0.2;
  if (/energetic|restless|fidgety|runner|athletic|active/.test(haystack)) restlessness += 0.25;
  restlessness = clamp(restlessness, 0.05, 0.95);

  const greetings = pullQuotedPhrases(haystack, 'greet') ?? DEFAULT_GREETINGS;
  const replies = pullQuotedPhrases(haystack, 'reply') ?? DEFAULT_REPLIES;
  const musings = pullQuotedPhrases(haystack, 'mus') ?? DEFAULT_MUSINGS;

  return { talkativeness, restlessness, greetings, replies, musings };
}

/**
 * Deterministic rule-based heartbeat policy. Each agent reasons over its
 * perception packet with a persona-seeded RNG so runs are reproducible.
 * Swap this for an LLM-backed policy later.
 */
export class DefaultHeartbeatPolicy implements HeartbeatPolicy {
  async decide(ctx: HeartbeatContext): Promise<AgentAction[]> {
    const { persona, perception, rng } = ctx;
    const hints = inferPersonaHints(persona);
    const actions: AgentAction[] = [];
    const hasGoto = !!perception.self.gotoTarget;

    if (perception.tick === 0) {
      actions.push({
        kind: 'set_goal',
        goal: persona.description || 'exist in the world',
      });
    }

    const heardFromNearby = perception.recentSpeech.find((s) =>
      perception.nearby.some((n) => n.id === s.speakerId),
    );
    if (heardFromNearby) {
      if (rng() < hints.talkativeness + 0.3) {
        const text = pick(rng, hints.replies) ?? 'mhm.';
        actions.push({ kind: 'speak', to: heardFromNearby.speakerId, text });
      }
    } else if (perception.nearby.length > 0) {
      if (rng() < hints.talkativeness) {
        const text = pick(rng, hints.greetings) ?? 'hey.';
        actions.push({ kind: 'speak', to: perception.nearby[0]!.id, text });
      }
    } else if (rng() < hints.talkativeness * 0.25) {
      const text = pick(rng, hints.musings) ?? 'hm.';
      actions.push({ kind: 'speak', to: null, text });
    }

    if (!hasGoto && perception.nearby.length === 0 && perception.zones.length > 0) {
      if (rng() < hints.restlessness * 0.5) {
        const zone = pick(rng, perception.zones);
        if (zone) {
          const cx = Math.floor(zone.x + zone.width / 2);
          const cy = Math.floor(zone.y + zone.height / 2);
          actions.push({ kind: 'goto', target: { x: cx, y: cy }, label: zone.name });
        }
      }
    }

    if (!hasGoto && rng() < hints.restlessness) {
      const next = wanderStep(perception.self.position, perception, rng);
      if (next) actions.push({ kind: 'move_to', to: next });
    }

    if (rng() < 0.08) {
      const note = observationNote(perception);
      if (note) actions.push({ kind: 'remember', fact: note });
    }

    if (actions.length === 0) {
      actions.push({ kind: 'wait', seconds: 1 });
    }
    return actions;
  }
}

export function makeRngForAgent(agentId: string, seed: number, tick: number): Rng {
  return seededRng(`${agentId}:${seed}:${tick}`);
}

function pullQuotedPhrases(_haystack: string, _hint: string): string[] | null {
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function wanderStep(from: Vec2, perception: Perception, rng: Rng): Vec2 | null {
  const target = perception.nearby[0];
  const bounds = perception.worldBounds;
  let dx = 0;
  let dy = 0;
  if (target && rng() < 0.5) {
    dx = Math.sign(target.position.x - from.x);
    dy = Math.sign(target.position.y - from.y);
    if (dx !== 0 && dy !== 0) {
      if (rng() < 0.5) dy = 0;
      else dx = 0;
    }
  } else {
    const dirs: Vec2[] = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ];
    const choice = pick(rng, dirs) ?? dirs[0]!;
    dx = choice.x;
    dy = choice.y;
  }
  const next = { x: from.x + dx, y: from.y + dy };
  if (next.x < 0 || next.x >= bounds.width) return null;
  if (next.y < 0 || next.y >= bounds.height) return null;
  if (next.x === from.x && next.y === from.y) return null;
  return next;
}

function observationNote(perception: Perception): string | null {
  if (perception.nearby.length > 0) {
    const names = perception.nearby.map((n) => n.name).join(', ');
    return `${perception.timeOfDay}: shared space with ${names}`;
  }
  if (perception.recentSpeech.length > 0) {
    const last = perception.recentSpeech[perception.recentSpeech.length - 1]!;
    return `${perception.timeOfDay}: overheard ${last.speakerName} say "${last.text}"`;
  }
  return null;
}
