import type { SimTime, Zone } from '@tina/shared';
import { inferPersonaHints } from './heartbeat.js';
import type { ParaMemory } from './memory.js';
import type { SkillDocument } from './skills.js';

export type PlanActivity = 'work' | 'socialize' | 'rest' | 'wander' | 'eat';

export type WeekendMode = 'off' | 'light' | 'same';

export interface PersonaSchedule {
  wakeHour: number;
  sleepHour: number;
  workStart: number;
  workEnd: number;
  workZone: 'cafe' | 'park' | 'home' | null;
  workActivity: PlanActivity;
  afternoonZone: 'cafe' | 'park' | 'home' | null;
  afternoonActivity: PlanActivity;
  lunchZone: 'cafe' | 'park' | 'home';
  eveningZone: 'cafe' | 'park' | 'home';
  weekendMode: WeekendMode;
  label: string;
}

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

function resolveZone(zones: Zone[], keyword: 'cafe' | 'park' | 'home' | null): string | null {
  if (!keyword) return null;
  return findZone(zones, keyword);
}

export function inferPersonaSchedule(persona: SkillDocument): PersonaSchedule {
  const hints = inferPersonaHints(persona);
  const haystack = [persona.description, persona.body, ...Object.values(persona.metadata ?? {})]
    .join('\n')
    .toLowerCase();

  let wakeHour = 7;
  let sleepHour = 22;
  if (/night owl|late sleeper|sleeps too little|insomnia/.test(haystack)) {
    wakeHour = 10;
    sleepHour = 26;
  } else if (/early bird|opens the caf|runs at dawn|up at dawn|early riser/.test(haystack)) {
    wakeHour = 5.5;
    sleepHour = 21;
  }

  const openMatch = haystack.match(/opens the caf[eé] at (\d{1,2}):(\d{2})/);
  if (openMatch) {
    const h = Number(openMatch[1]);
    const m = Number(openMatch[2]);
    wakeHour = Math.max(4, h - 1 + m / 60);
  }

  let workZone: PersonaSchedule['workZone'] = null;
  let workActivity: PlanActivity = 'work';
  if (/barista|caf[eé]|coffee shop/.test(haystack)) {
    workZone = 'cafe';
  } else if (
    /musician|busker|park ranger|gardener|athlete|runner|coach|trainer|skater|skate/.test(haystack)
  ) {
    workZone = 'park';
    workActivity = /musician|busker/.test(haystack) ? 'wander' : 'work';
  } else if (
    /painter|writer|freelanc|remote|nurse|school|consultant|developer|engineer|programmer|cook|homebody/.test(
      haystack,
    )
  ) {
    workZone = 'home';
  } else if (hints.restlessness >= 0.5) {
    workZone = 'cafe';
  } else {
    workZone = 'home';
    workActivity = 'rest';
  }

  let workStart = Math.max(wakeHour + 1, 8);
  let workEnd = 17;
  if (workZone === 'cafe' && /opens the caf/.test(haystack)) {
    workStart = Math.max(wakeHour + 0.25, 6);
    workEnd = 14;
  }
  if (workZone === 'park' && /musician|busker/.test(haystack)) {
    workStart = 11;
    workEnd = 19;
  }
  if (/paints.*(10pm|after 22|after 10pm)/.test(haystack) || /paints from 10pm/.test(haystack)) {
    // evening-studio personas still have a daytime schedule, but sleep later
    sleepHour = Math.max(sleepHour, 26);
  }

  const afternoonActivity: PlanActivity = hints.talkativeness >= 0.5 ? 'socialize' : 'wander';
  const afternoonZone: PersonaSchedule['afternoonZone'] =
    afternoonActivity === 'socialize' ? 'cafe' : null;

  const lunchZone: PersonaSchedule['lunchZone'] = workZone === 'park' ? 'cafe' : 'park';
  const eveningZone: PersonaSchedule['eveningZone'] = 'home';

  const weekendMode: WeekendMode = /on call|rotating shifts|24\/7/.test(haystack)
    ? 'same'
    : 'light';

  const labelParts = [
    wakeHour <= 6 ? 'early bird' : wakeHour >= 9 ? 'night owl' : 'balanced',
    workZone ? `works at ${workZone}` : 'no fixed work',
  ];

  return {
    wakeHour,
    sleepHour,
    workStart,
    workEnd,
    workZone,
    workActivity,
    afternoonZone,
    afternoonActivity,
    lunchZone,
    eveningZone,
    weekendMode,
    label: labelParts.join(' · '),
  };
}

export interface GeneratePlanInput {
  persona: SkillDocument;
  zones: Zone[];
  day: number;
  simTime: SimTime;
}

export function generateDayPlan(input: GeneratePlanInput): DayPlan {
  const { persona, zones, day, simTime } = input;
  const schedule = inferPersonaSchedule(persona);
  const dayOfWeek = ((day % 7) + 7) % 7;
  const isWeekend = dayOfWeek === 5 || dayOfWeek === 6;

  const cafe = findZone(zones, 'cafe');
  const park = findZone(zones, 'park');
  const home = findZone(zones, 'home');
  const resolve = (k: PersonaSchedule['workZone']) => resolveZone(zones, k) ?? home;

  const lunchStart = 12;
  const lunchEnd = 13;

  const morningZone = resolve(schedule.workZone ?? 'home');
  const morningActivity: PlanActivity =
    isWeekend && schedule.weekendMode !== 'same' ? 'rest' : schedule.workActivity;
  const morningIntent =
    isWeekend && schedule.weekendMode !== 'same'
      ? `slow ${dayOfWeek === 5 ? 'saturday' : 'sunday'} morning at ${home ?? 'home'}`
      : morningActivity === 'work'
        ? `work at ${morningZone ?? 'the cafe'} this morning`
        : morningActivity === 'wander'
          ? `play at ${morningZone ?? 'the park'} this morning`
          : `ease into the morning at ${home ?? 'home'}`;

  const lunchZoneName = resolve(schedule.lunchZone);
  const afternoonActivity: PlanActivity =
    isWeekend && schedule.weekendMode !== 'same' ? 'socialize' : schedule.afternoonActivity;
  const afternoonZoneName =
    afternoonActivity === 'socialize'
      ? (resolveZone(zones, schedule.afternoonZone ?? 'cafe') ?? cafe ?? home)
      : afternoonActivity === 'wander'
        ? null
        : resolve(schedule.afternoonZone ?? schedule.workZone);
  const afternoonIntent =
    afternoonActivity === 'socialize'
      ? `catch up with folks at ${afternoonZoneName ?? cafe ?? 'the cafe'}`
      : afternoonActivity === 'work'
        ? `keep working at ${afternoonZoneName ?? 'the cafe'}`
        : 'drift around town this afternoon';

  const eveningZoneName = resolve(schedule.eveningZone);

  const morningStart = Math.max(schedule.wakeHour, 0);
  const afternoonStart = Math.max(lunchEnd + 1, schedule.workStart);
  const eveningStart = Math.max(17, schedule.workEnd, afternoonStart + 2);
  const nightStart = Math.max(schedule.sleepHour, eveningStart + 1);
  const nightEnd = Math.max(nightStart + 1, 30);

  // Keep legacy default boundaries (6,12,14,18,22) when the schedule inference
  // produces a balanced weekday archetype so existing planner expectations hold.
  const useLegacyBoundaries =
    !isWeekend &&
    schedule.workStart >= 8 &&
    schedule.workEnd === 17 &&
    schedule.wakeHour === 7 &&
    schedule.sleepHour === 22;

  const legacyMorningStart = 6;
  const legacyAfternoonStart = 14;
  const legacyEveningStart = 18;
  const legacyNightStart = 22;

  const blocks: PlanBlock[] = [
    {
      id: 'morning',
      startHour: useLegacyBoundaries ? legacyMorningStart : morningStart,
      endHour: lunchStart,
      intent: morningIntent,
      preferredZone: morningZone,
      activity: morningActivity,
    },
    {
      id: 'midday',
      startHour: lunchStart,
      endHour: useLegacyBoundaries ? legacyAfternoonStart : afternoonStart,
      intent: `lunch at ${lunchZoneName ?? park ?? 'the park'}`,
      preferredZone: lunchZoneName,
      activity: 'eat',
    },
    {
      id: 'afternoon',
      startHour: useLegacyBoundaries ? legacyAfternoonStart : afternoonStart,
      endHour: useLegacyBoundaries ? legacyEveningStart : eveningStart,
      intent: afternoonIntent,
      preferredZone: afternoonZoneName,
      activity: afternoonActivity,
    },
    {
      id: 'evening',
      startHour: useLegacyBoundaries ? legacyEveningStart : eveningStart,
      endHour: useLegacyBoundaries ? legacyNightStart : nightStart,
      intent: `wind down at ${eveningZoneName ?? home ?? 'home'}`,
      preferredZone: eveningZoneName,
      activity: 'rest',
    },
    {
      id: 'night',
      startHour: useLegacyBoundaries ? legacyNightStart : nightStart,
      endHour: useLegacyBoundaries ? 30 : nightEnd,
      intent: `sleep at ${home ?? 'home'}`,
      preferredZone: home,
      activity: 'rest',
    },
  ];

  const label = persona.displayName || persona.id;
  const dayLabel = isWeekend
    ? dayOfWeek === 5
      ? 'sat'
      : 'sun'
    : (['mon', 'tue', 'wed', 'thu', 'fri'][dayOfWeek] ?? `d${dayOfWeek}`);
  const summary = `${label} day ${day} (${dayLabel}): ${blocks.map((b) => b.intent).join(' → ')}`;

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
