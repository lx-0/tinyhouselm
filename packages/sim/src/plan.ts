import type { SimTime, Zone } from '@tina/shared';
import { inferPersonaHints } from './heartbeat.js';
import type { ParaMemory } from './memory.js';
import type { SkillDocument } from './skills.js';

export type PlanActivity = 'work' | 'socialize' | 'rest' | 'wander' | 'eat';

export interface PlanBlock {
  id: string;
  startHour: number;
  endHour: number;
  intent: string;
  preferredZone: string | null;
  activity: PlanActivity;
}

export interface HourPlan {
  blockId: string;
  steps: string[];
}

export interface ReplanEntry {
  at: SimTime;
  reason: string;
  detail: string;
}

export interface DayPlan {
  day: number;
  generatedAt: SimTime;
  persona: string;
  personaName: string;
  summary: string;
  blocks: PlanBlock[];
  hourPlans: Record<string, HourPlan>;
  replanLog: ReplanEntry[];
}

const SECONDS_PER_DAY = 86400;
const SECONDS_PER_HOUR = 3600;

export function simDay(simTime: SimTime): number {
  return Math.floor(simTime / SECONDS_PER_DAY);
}

export function simHour(simTime: SimTime): number {
  const seconds = ((simTime % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  return seconds / SECONDS_PER_HOUR;
}

export function activeBlock(plan: DayPlan, hour: number): PlanBlock | null {
  for (const block of plan.blocks) {
    if (hour >= block.startHour && hour < block.endHour) return block;
  }
  return plan.blocks[plan.blocks.length - 1] ?? null;
}

function findZone(zones: Zone[], keyword: string): string | null {
  const z = zones.find((zone) => zone.name.toLowerCase().includes(keyword));
  return z?.name ?? null;
}

export interface GeneratePlanInput {
  persona: SkillDocument;
  zones: Zone[];
  day: number;
  simTime: SimTime;
}

export function generateDayPlan(input: GeneratePlanInput): DayPlan {
  const { persona, zones, day, simTime } = input;
  const hints = inferPersonaHints(persona);
  const cafe = findZone(zones, 'cafe');
  const park = findZone(zones, 'park');
  const home = findZone(zones, 'home');

  const morningActivity: PlanActivity = hints.restlessness >= 0.5 ? 'work' : 'rest';
  const morningZone = morningActivity === 'work' ? (cafe ?? home) : home;
  const morningIntent =
    morningActivity === 'work'
      ? `work at ${cafe ?? 'the cafe'} this morning`
      : `take a slow morning at ${home ?? 'home'}`;

  const afternoonSocial = hints.talkativeness >= 0.5;
  const afternoonIntent = afternoonSocial
    ? `catch up with folks at ${cafe ?? 'the cafe'}`
    : 'drift around town this afternoon';
  const afternoonZone = afternoonSocial ? cafe : null;
  const afternoonActivity: PlanActivity = afternoonSocial ? 'socialize' : 'wander';

  const blocks: PlanBlock[] = [
    {
      id: 'morning',
      startHour: 6,
      endHour: 12,
      intent: morningIntent,
      preferredZone: morningZone,
      activity: morningActivity,
    },
    {
      id: 'midday',
      startHour: 12,
      endHour: 14,
      intent: `lunch at ${park ?? 'the park'}`,
      preferredZone: park,
      activity: 'eat',
    },
    {
      id: 'afternoon',
      startHour: 14,
      endHour: 18,
      intent: afternoonIntent,
      preferredZone: afternoonZone,
      activity: afternoonActivity,
    },
    {
      id: 'evening',
      startHour: 18,
      endHour: 22,
      intent: `wind down at ${home ?? 'home'}`,
      preferredZone: home,
      activity: 'rest',
    },
    {
      id: 'night',
      startHour: 22,
      endHour: 30,
      intent: `sleep at ${home ?? 'home'}`,
      preferredZone: home,
      activity: 'rest',
    },
  ];

  const label = persona.displayName || persona.id;
  const summary = `${label} day ${day}: ${blocks.map((b) => b.intent).join(' → ')}`;

  return {
    day,
    generatedAt: simTime,
    persona: persona.id,
    personaName: label,
    summary,
    blocks,
    hourPlans: {},
    replanLog: [],
  };
}

export function expandBlock(block: PlanBlock): HourPlan {
  const steps: string[] = [];
  if (block.preferredZone) steps.push(`go to ${block.preferredZone}`);
  switch (block.activity) {
    case 'work':
      steps.push('settle in', 'focus on work', 'short break', 'continue work');
      break;
    case 'socialize':
      steps.push('greet nearby', 'chat', 'listen');
      break;
    case 'eat':
      steps.push('find a spot', 'eat', 'people-watch');
      break;
    case 'rest':
      steps.push('wind down', 'rest');
      break;
    case 'wander':
      steps.push('stroll', 'look around');
      break;
  }
  return { blockId: block.id, steps };
}

export interface ReplanOutcome {
  plan: DayPlan;
  entry: ReplanEntry;
}

export function replanForSurprise(
  plan: DayPlan,
  simTime: SimTime,
  reason: string,
  detail: string,
): ReplanOutcome {
  const entry: ReplanEntry = { at: simTime, reason, detail };
  return {
    plan: { ...plan, replanLog: [...plan.replanLog, entry] },
    entry,
  };
}

/**
 * Owns per-agent plan state across ticks. Keeps a hot cache, lazily loads
 * from para-memory, and persists whenever a new day is committed or a
 * surprise patches the replan log.
 */
export class PlanRuntime {
  private plans = new Map<string, DayPlan>();
  private suspensions = new Map<string, string>();
  private loaded = new Set<string>();

  async ensurePlan(args: {
    agentId: string;
    persona: SkillDocument;
    zones: Zone[];
    memory: ParaMemory;
    simTime: SimTime;
  }): Promise<{ plan: DayPlan; committed: boolean }> {
    const { agentId, persona, zones, memory, simTime } = args;
    const day = simDay(simTime);
    let plan = this.plans.get(agentId);

    if (!plan && !this.loaded.has(agentId)) {
      this.loaded.add(agentId);
      const persisted = await memory.readPlanRaw(day);
      if (persisted && typeof persisted === 'object' && (persisted as DayPlan).day === day) {
        plan = persisted as DayPlan;
        this.plans.set(agentId, plan);
        return { plan, committed: false };
      }
    }

    if (plan && plan.day === day) return { plan, committed: false };

    plan = generateDayPlan({ persona, zones, day, simTime });
    this.plans.set(agentId, plan);
    await memory.writePlanRaw(day, plan);
    return { plan, committed: true };
  }

  getPlan(agentId: string): DayPlan | null {
    return this.plans.get(agentId) ?? null;
  }

  async recordReplan(args: {
    agentId: string;
    memory: ParaMemory;
    simTime: SimTime;
    reason: string;
    detail: string;
  }): Promise<{ plan: DayPlan; entry: ReplanEntry } | null> {
    const { agentId, memory, simTime, reason, detail } = args;
    const plan = this.plans.get(agentId);
    if (!plan) return null;
    const outcome = replanForSurprise(plan, simTime, reason, detail);
    this.plans.set(agentId, outcome.plan);
    await memory.writePlanRaw(outcome.plan.day, outcome.plan);
    return { plan: outcome.plan, entry: outcome.entry };
  }

  suspend(agentId: string, reason: string): void {
    this.suspensions.set(agentId, reason);
  }

  resume(agentId: string): boolean {
    return this.suspensions.delete(agentId);
  }

  suspension(agentId: string): string | null {
    return this.suspensions.get(agentId) ?? null;
  }
}
