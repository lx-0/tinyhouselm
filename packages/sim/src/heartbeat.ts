import type { Affordance, AgentAction, ObjectAffordance, Vec2, WorldObject } from '@tina/shared';
import type { ParaMemory } from './memory.js';
import type { Perception } from './perception.js';
import type { DayPlan, PlanActivity, PlanBlock } from './plan.js';
import { activeBlock, simHour } from './plan.js';
import { type Rng, pick, seededRng } from './rng.js';
import type { SkillDocument } from './skills.js';

export interface HeartbeatContext {
  persona: SkillDocument;
  perception: Perception;
  memory: ParaMemory;
  rng: Rng;
  plan?: DayPlan | null;
  suspended?: string | null;
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
    const { persona, perception, rng, plan, suspended } = ctx;
    const hints = inferPersonaHints(persona);
    const actions: AgentAction[] = [];
    const hasGoto = !!perception.self.gotoTarget;

    if (perception.tick === 0) {
      const goalText = plan
        ? plan.summary.slice(0, 80)
        : persona.description || 'exist in the world';
      actions.push({ kind: 'set_goal', goal: goalText });
    }

    // Suspension takes over — the agent is engaged in something that
    // overrides the plan for this tick (e.g. mid-conversation).
    if (suspended === 'conversation') {
      const heardFromNearby = perception.recentSpeech.find((s) =>
        perception.nearby.some((n) => n.id === s.speakerId),
      );
      if (heardFromNearby) {
        const text = pick(rng, hints.replies) ?? 'mhm.';
        actions.push({ kind: 'speak', to: heardFromNearby.speakerId, text });
      } else if (perception.nearby.length > 0) {
        const text = pick(rng, hints.replies) ?? 'yeah.';
        actions.push({ kind: 'speak', to: perception.nearby[0]!.id, text });
      } else {
        actions.push({ kind: 'wait', seconds: 1 });
      }
      return actions;
    }

    const block = plan ? activeBlock(plan, simHour(perception.simTime)) : null;

    if (block && !hasGoto) {
      const zoneTarget = planZoneTarget(block, perception);
      if (zoneTarget) {
        const here = perception.self.position;
        const atTarget = here.x === zoneTarget.target.x && here.y === zoneTarget.target.y;
        const wrongZone =
          block.preferredZone !== null && perception.self.zone !== block.preferredZone;
        // Route if the agent isn't already standing on the chosen tile, or if
        // the plan has a preferred zone the agent hasn't reached yet. Free-zone
        // affordance pulls (block.preferredZone === null, TINA-416) only need
        // the position check — they don't care about zone membership.
        if (!atTarget && (wrongZone || block.preferredZone === null)) {
          actions.push({ kind: 'goto', target: zoneTarget.target, label: zoneTarget.label });
          if (perception.tick === 0) {
            actions.push({ kind: 'remember', fact: `committed: ${block.intent}` });
          }
          return actions;
        }
      }
    }

    const heardFromNearby = perception.recentSpeech.find((s) =>
      perception.nearby.some((n) => n.id === s.speakerId),
    );
    const speakingBias = block?.activity === 'socialize' ? 0.25 : 0;
    if (heardFromNearby) {
      if (rng() < hints.talkativeness + 0.3) {
        const text = pick(rng, hints.replies) ?? 'mhm.';
        actions.push({ kind: 'speak', to: heardFromNearby.speakerId, text });
      }
    } else if (perception.nearby.length > 0) {
      if (rng() < hints.talkativeness + speakingBias) {
        const text = pick(rng, hints.greetings) ?? 'hey.';
        actions.push({ kind: 'speak', to: perception.nearby[0]!.id, text });
      }
    } else if (rng() < hints.talkativeness * 0.25) {
      const text = pick(rng, hints.musings) ?? 'hm.';
      actions.push({ kind: 'speak', to: null, text });
    }

    // Plan-shaped in-zone behavior when the agent has arrived.
    if (block && !hasGoto && block.preferredZone && perception.self.zone === block.preferredZone) {
      const activityAction = inZoneAction(block, perception, rng);
      if (activityAction) actions.push(activityAction);
    }

    if (!hasGoto && !block && perception.nearby.length === 0 && perception.zones.length > 0) {
      if (rng() < hints.restlessness * 0.5) {
        // Leisure-affordance pull (TINA-416): if a viewer dropped a bench/music
        // somewhere the agent can see, route there instead of to a random
        // zone center. Untyped objects + work-only affordances are skipped.
        const aff = pickAffordanceTarget(['bench', 'music'], perception);
        if (aff) {
          actions.push({ kind: 'goto', target: { ...aff.pos }, label: aff.label });
        } else {
          const zone = pickLeisureZone(rng, perception);
          if (zone) {
            const cx = Math.floor(zone.x + zone.width / 2);
            const cy = Math.floor(zone.y + zone.height / 2);
            actions.push({ kind: 'goto', target: { x: cx, y: cy }, label: zone.name });
          }
        }
      }
    }

    const wanderAllowed = !block || block.activity === 'wander' || block.preferredZone === null;
    if (!hasGoto && wanderAllowed && rng() < hints.restlessness) {
      const next = wanderStep(perception.self.position, perception, rng);
      if (next) actions.push({ kind: 'move_to', to: next });
    }

    if (rng() < 0.08) {
      const note = observationNote(perception, block);
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

/**
 * Weighted zone pick for the leisure-hour wander path. Falls back to a
 * uniform pick when no affinity hints are attached (procedural agents, or
 * named agents with no known pairs yet). Hints are aggregate per-zone
 * affinity from the caller's named-character pair state (TINA-207).
 * High-affinity zones get ~1.5× the weight of neutral zones; strongly
 * negative pairs push the weight down to ~0.5× but never to zero — the
 * sim still needs a non-zero chance of unexpected encounters for drama.
 */
export function pickLeisureZone(
  rng: Rng,
  perception: Perception,
): Perception['zones'][number] | null {
  const zones = perception.zones;
  if (zones.length === 0) return null;
  const hints = perception.zoneAffinityHints;
  if (!hints || hints.size === 0) return pick(rng, zones) ?? null;
  const weights: number[] = [];
  let total = 0;
  for (const z of zones) {
    const hint = hints.get(z.name) ?? 0;
    // Map aggregate affinity into a multiplicative factor in [0.5, 1.5].
    // hint > 0 (friends here) → boost; hint < 0 (sour pairs) → mild avoid.
    const w = Math.max(0.5, Math.min(1.5, 1 + hint * 0.5));
    weights.push(w);
    total += w;
  }
  if (total <= 0) return pick(rng, zones) ?? null;
  let r = rng() * total;
  for (let i = 0; i < zones.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return zones[i]!;
  }
  return zones[zones.length - 1] ?? null;
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

function observationNote(perception: Perception, block: PlanBlock | null): string | null {
  const intent = block ? ` [${block.intent}]` : '';
  if (perception.nearby.length > 0) {
    const names = perception.nearby.map((n) => n.name).join(', ');
    return `${perception.timeOfDay}${intent}: shared space with ${names}`;
  }
  if (perception.recentSpeech.length > 0) {
    const last = perception.recentSpeech[perception.recentSpeech.length - 1]!;
    return `${perception.timeOfDay}${intent}: overheard ${last.speakerName} say "${last.text}"`;
  }
  return null;
}

function affordanceForActivity(activity: PlanActivity): Affordance | null {
  switch (activity) {
    case 'work':
      return 'work';
    case 'eat':
      return 'food';
    case 'rest':
      return 'sleep';
    case 'socialize':
      return 'social';
    case 'wander':
      return 'leisure';
  }
}

/**
 * Object-affordance preferences per plan activity (TINA-416). Distinct from
 * the static `Affordance` map above (which keys location anchors): these
 * names track typed dropped objects via `WorldObject.affordance`.
 *
 * `socialize` and `wander` overlap on bench/music — those are the leisure
 * hooks viewers will most often drop. `rest` favors a bench. `eat` only
 * matches `food`. `work` deliberately has none — work blocks should still
 * route to the desk anchor, not be hijacked by a viewer dropping a bench
 * in the office.
 */
export const OBJECT_AFFORDANCES_FOR_ACTIVITY: Readonly<
  Record<PlanActivity, readonly ObjectAffordance[]>
> = {
  work: [],
  eat: ['food'],
  rest: ['bench'],
  socialize: ['bench', 'music'],
  wander: ['bench', 'music'],
};

/**
 * Pick the closest dropped affordance object whose type matches one of
 * `wanted`. Deterministic: ties on chebyshev distance broken by lexicographic
 * id so two replays of the same tick produce the same target. Returns `null`
 * when no matching affordance is in the perception set.
 *
 * Pass `zoneFilter` to require the object live inside a specific zone (useful
 * when the plan block has a preferred zone). Omit it for free-roam leisure.
 */
export function pickAffordanceTarget(
  wanted: readonly ObjectAffordance[],
  perception: Perception,
  zoneFilter?: string | null,
): WorldObject | null {
  if (wanted.length === 0) return null;
  if (perception.affordanceObjects.length === 0) return null;
  const self = perception.self.position;
  let best: WorldObject | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const obj of perception.affordanceObjects) {
    if (!obj.affordance || !wanted.includes(obj.affordance)) continue;
    if (zoneFilter !== undefined && obj.zone !== zoneFilter) continue;
    const dx = Math.abs(obj.pos.x - self.x);
    const dy = Math.abs(obj.pos.y - self.y);
    const d = dx > dy ? dx : dy;
    if (d < bestDist) {
      best = obj;
      bestDist = d;
    } else if (d === bestDist && best && obj.id < best.id) {
      best = obj;
    }
  }
  return best;
}

function planZoneTarget(
  block: PlanBlock,
  perception: Perception,
): { target: Vec2; label: string } | null {
  const wantedObjects = OBJECT_AFFORDANCES_FOR_ACTIVITY[block.activity];
  if (!block.preferredZone) {
    // No fixed zone — let a typed dropped affordance pull the agent (TINA-416).
    // This is the leisure / free-wander entry point that lets viewers drop a
    // bench in Kitchen and have a named character actually route there.
    const obj = pickAffordanceTarget(wantedObjects, perception);
    if (obj) return { target: { ...obj.pos }, label: obj.label };
    return null;
  }
  // Preferred zone is set: a matching dropped affordance inside that zone
  // wins over the location anchor. Falls through to the existing
  // location-anchor / zone-center path when nothing matches.
  const obj = pickAffordanceTarget(wantedObjects, perception, block.preferredZone);
  if (obj) return { target: { ...obj.pos }, label: obj.label };
  // Prefer a location in the area whose affordance matches the activity.
  const wantAff = affordanceForActivity(block.activity);
  const inArea = perception.locations.filter((l) => l.area === block.preferredZone);
  if (inArea.length > 0) {
    const matching = wantAff ? inArea.find((l) => l.affordances.includes(wantAff)) : null;
    const chosen = matching ?? inArea[0]!;
    return { target: { ...chosen.anchor }, label: chosen.name };
  }
  // Fall back to the zone center for back-compat with mapless tests.
  const zone = perception.zones.find((z) => z.name === block.preferredZone);
  if (!zone) return null;
  return {
    target: {
      x: Math.floor(zone.x + zone.width / 2),
      y: Math.floor(zone.y + zone.height / 2),
    },
    label: zone.name,
  };
}

function inZoneAction(block: PlanBlock, perception: Perception, rng: Rng): AgentAction | null {
  switch (block.activity) {
    case 'work':
      if (rng() < 0.2) {
        return {
          kind: 'remember',
          fact: `focused on work at ${block.preferredZone ?? 'the desk'}`,
        };
      }
      return { kind: 'wait', seconds: 2 };
    case 'rest':
      return { kind: 'wait', seconds: 2 };
    case 'eat':
      if (rng() < 0.25) {
        return { kind: 'remember', fact: `ate at ${block.preferredZone ?? 'the spot'}` };
      }
      return { kind: 'wait', seconds: 1 };
    case 'socialize':
      if (perception.nearby.length === 0 && rng() < 0.3) {
        return { kind: 'wait', seconds: 1 };
      }
      return null;
    case 'wander':
      return null;
  }
}
