/**
 * reflection-plan-demo — TINA-16 worked example.
 *
 * Shows the reflection → plan linkage end-to-end, in < 1s of wall time:
 *
 *   1. Generate a baseline plan for a barista on day 0 (no reflections).
 *   2. Seed memory with a reflection:
 *        "I feel anxious around bruno-costa in the cafe during the morning rush"
 *   3. Generate the day-1 plan via PlanRuntime.ensurePlan, which pulls recent
 *      reflections from memory, carries them into `plan.carriedReflections`,
 *      detects `cafe` as an avoidance, and steers the morning block out of
 *      the cafe.
 *
 * Stdout diff shows the barista's morning preferredZone moving `cafe → home`,
 * the avoidance note baked into the block intent, and the reflection text
 * carried into the plan summary. Used by TINA-16 PR as the worked example.
 *
 * Usage:
 *   pnpm reflection-plan-demo
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Zone } from '@tina/shared';
import { ParaMemory } from '../src/memory.js';
import { type DayPlan, PlanRuntime, generateDayPlan } from '../src/plan.js';
import { parseSkillSource } from '../src/skills.js';

const ZONES: Zone[] = [
  { name: 'cafe', x: 1, y: 1, width: 5, height: 5 },
  { name: 'park', x: 14, y: 1, width: 5, height: 5 },
  { name: 'home', x: 9, y: 14, width: 5, height: 5 },
];

function fmtPlan(label: string, plan: DayPlan): void {
  console.log(`## ${label}`);
  console.log(`summary: ${plan.summary}`);
  console.log(
    `avoidances: [${plan.avoidances.join(', ')}]  ·  carried: ${plan.carriedReflections.length}`,
  );
  for (const r of plan.carriedReflections) {
    console.log(`  · carried[${r.id} imp=${r.importance}]: ${r.text}`);
  }
  for (const b of plan.blocks) {
    const zone = b.preferredZone ?? '—';
    console.log(
      `  ${b.startHour.toFixed(0).padStart(2, ' ')}..${b.endHour
        .toFixed(0)
        .padStart(
          2,
          ' ',
        )}  ${b.id.padEnd(9)} ${b.activity.padEnd(10)} @ ${zone.padEnd(10)} — ${b.intent}`,
    );
  }
  console.log('');
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'tina-refl-plan-'));
  const memory = new ParaMemory({
    root,
    entity: 'mei-tanaka',
    now: () => new Date('2026-04-21T06:00:00Z'),
  });
  const persona = parseSkillSource(
    [
      '---',
      'name: mei-tanaka',
      'description: extrovert barista, opens the cafe at 6:30, chatty',
      '---',
      '',
      '# Mei Tanaka',
      '',
      'Extrovert barista who opens the cafe at 06:30.',
    ].join('\n'),
    '/virtual/mei-tanaka/SKILL.md',
  );
  const planner = new PlanRuntime();

  console.log('# TINA-16 worked example — reflection → next-day plan');
  console.log('# persona: mei-tanaka (barista, cafe)');
  console.log('');

  // Day 0: baseline plan, no reflections yet.
  const day0 = await planner.ensurePlan({
    agentId: persona.id,
    persona,
    zones: ZONES,
    memory,
    simTime: 6 * 3600,
  });
  fmtPlan('day 0 plan (no reflections)', day0.plan);

  // Write a reflection. In production this comes from ReflectionEngine; here
  // we seed one directly so the demo is deterministic and LLM-independent.
  const reflection = await memory.addFact({
    fact: 'I feel anxious around bruno-costa in the cafe during the morning rush',
    category: 'reflection',
    importance: 9,
    related_entities: ['bruno-costa'],
    source: 'reflection:day_rollover:day-0:llm',
    derived_from: ['mei-tanaka-1', 'mei-tanaka-2', 'mei-tanaka-3'],
  });
  console.log(`# reflection written: [${reflection.id}] ${reflection.fact}`);
  console.log('');

  // Day 1: planner pulls the reflection from memory, avoidance overlay kicks in.
  const day1 = await planner.ensurePlan({
    agentId: persona.id,
    persona,
    zones: ZONES,
    memory,
    simTime: 86400 + 6 * 3600,
  });
  fmtPlan('day 1 plan (with reflection)', day1.plan);

  const day0Morning = day0.plan.blocks.find((b) => b.id === 'morning')!;
  const day1Morning = day1.plan.blocks.find((b) => b.id === 'morning')!;
  console.log('# diff:');
  console.log(
    `#   morning.preferredZone: ${day0Morning.preferredZone ?? '—'} → ${day1Morning.preferredZone ?? '—'}`,
  );
  console.log(`#   morning.activity:      ${day0Morning.activity} → ${day1Morning.activity}`);
  console.log(`#   avoidances:            [] → [${day1.plan.avoidances.join(', ')}]`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Re-export for potential programmatic use (and to satisfy the 'unused import'
// lint on generateDayPlan in stricter tsconfigs).
void generateDayPlan;
