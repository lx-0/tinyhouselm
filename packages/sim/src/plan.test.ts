import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Zone } from '@tina/shared';
import { describe, expect, it } from 'vitest';
import { ParaMemory } from './memory.js';
import {
  PlanRuntime,
  activeBlock,
  generateDayPlan,
  replanForSurprise,
  simDay,
  simHour,
} from './plan.js';
import { type SkillDocument, parseSkillSource } from './skills.js';

const zones: Zone[] = [
  { name: 'cafe', x: 0, y: 0, width: 4, height: 4 },
  { name: 'park', x: 6, y: 0, width: 4, height: 4 },
  { name: 'home', x: 0, y: 6, width: 4, height: 4 },
];

function skillFor(name: string, description: string): SkillDocument {
  return parseSkillSource(
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody\n`,
    `/virtual/${name}/SKILL.md`,
  );
}

describe('plan', () => {
  it('simDay / simHour convert sim seconds correctly', () => {
    expect(simDay(0)).toBe(0);
    expect(simDay(86400)).toBe(1);
    expect(simDay(86400 * 2 + 3600)).toBe(2);
    expect(simHour(0)).toBe(0);
    expect(simHour(3600)).toBe(1);
    expect(simHour(86400 + 3600 * 8)).toBe(8);
  });

  it('generateDayPlan tilts morning by restlessness and afternoon by talkativeness', () => {
    const extrovert = skillFor('alpha', 'extrovert, energetic, social');
    const introvert = skillFor('bravo', 'introvert, quiet, tired, sedentary');
    const ep = generateDayPlan({ persona: extrovert, zones, day: 0, simTime: 0 });
    const ip = generateDayPlan({ persona: introvert, zones, day: 0, simTime: 0 });

    const em = ep.blocks.find((b) => b.id === 'morning')!;
    const im = ip.blocks.find((b) => b.id === 'morning')!;
    expect(em.activity).toBe('work');
    expect(em.preferredZone).toBe('cafe');
    expect(im.activity).toBe('rest');
    expect(im.preferredZone).toBe('home');

    const ea = ep.blocks.find((b) => b.id === 'afternoon')!;
    const ia = ip.blocks.find((b) => b.id === 'afternoon')!;
    expect(ea.activity).toBe('socialize');
    expect(ia.activity).toBe('wander');
  });

  it('activeBlock finds the right block at hour boundaries', () => {
    const plan = generateDayPlan({
      persona: skillFor('x', 'energetic'),
      zones,
      day: 0,
      simTime: 0,
    });
    expect(activeBlock(plan, 8)?.id).toBe('morning');
    expect(activeBlock(plan, 12)?.id).toBe('midday');
    expect(activeBlock(plan, 13.9)?.id).toBe('midday');
    expect(activeBlock(plan, 14)?.id).toBe('afternoon');
    expect(activeBlock(plan, 22)?.id).toBe('night');
  });

  it('replanForSurprise keeps blocks intact and appends to the log', () => {
    const plan = generateDayPlan({
      persona: skillFor('x', 'energetic'),
      zones,
      day: 0,
      simTime: 0,
    });
    const { plan: patched, entry } = replanForSurprise(plan, 100, 'conversation', 'heard Bruno');
    expect(patched.blocks).toEqual(plan.blocks);
    expect(patched.replanLog).toHaveLength(1);
    expect(entry).toMatchObject({ at: 100, reason: 'conversation', detail: 'heard Bruno' });
  });

  it('PlanRuntime writes + reads plans through ParaMemory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tina-plan-'));
    const memory = new ParaMemory({ root, now: () => new Date('2026-04-18T00:00:00Z') });
    const planner = new PlanRuntime();
    const persona = skillFor('x', 'energetic social');

    const first = await planner.ensurePlan({
      agentId: persona.id,
      persona,
      zones,
      memory,
      simTime: 6 * 3600,
    });
    expect(first.committed).toBe(true);
    expect(first.plan.day).toBe(0);

    const again = await planner.ensurePlan({
      agentId: persona.id,
      persona,
      zones,
      memory,
      simTime: 10 * 3600,
    });
    expect(again.committed).toBe(false);
    expect(again.plan).toBe(first.plan);

    const nextDay = await planner.ensurePlan({
      agentId: persona.id,
      persona,
      zones,
      memory,
      simTime: 86400 + 6 * 3600,
    });
    expect(nextDay.committed).toBe(true);
    expect(nextDay.plan.day).toBe(1);

    const persisted = await memory.readPlanRaw(0);
    expect(persisted).toBeTruthy();
    expect((persisted as { day: number }).day).toBe(0);
  });

  it('PlanRuntime.recordReplan patches cached + persisted plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tina-replan-'));
    const memory = new ParaMemory({ root, now: () => new Date('2026-04-18T00:00:00Z') });
    const planner = new PlanRuntime();
    const persona = skillFor('y', 'energetic social');

    await planner.ensurePlan({
      agentId: 'agent-1',
      persona,
      zones,
      memory,
      simTime: 6 * 3600,
    });

    const outcome = await planner.recordReplan({
      agentId: 'agent-1',
      memory,
      simTime: 6 * 3600 + 120,
      reason: 'conversation',
      detail: 'heard Bruno',
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.plan.replanLog).toHaveLength(1);

    const reloaded = (await memory.readPlanRaw(0)) as { replanLog: Array<unknown> };
    expect(reloaded.replanLog).toHaveLength(1);
  });

  it('suspend / resume tracks per-agent state', () => {
    const planner = new PlanRuntime();
    planner.suspend('a', 'conversation');
    expect(planner.suspension('a')).toBe('conversation');
    expect(planner.suspension('b')).toBeNull();
    expect(planner.resume('a')).toBe(true);
    expect(planner.suspension('a')).toBeNull();
    expect(planner.resume('a')).toBe(false);
  });
});
