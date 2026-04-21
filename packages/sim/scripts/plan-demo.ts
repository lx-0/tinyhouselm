/**
 * Plan-demo — TINA-7 deliverable.
 *
 * An agent wakes, commits to a plan like "work at the cafe this morning",
 * heads there, and is interrupted by a passing conversation partner. The
 * runtime fires plan_replan, the agent suspends its movement to reply, and
 * resumes once the partner drifts away.
 *
 * Output is a chronological event log written to stdout (and optionally a
 * file via --out).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAction, Zone } from '@tina/shared';
import { SimulationClock } from '../src/clock.js';
import type { HeartbeatPolicy } from '../src/heartbeat.js';
import { DefaultHeartbeatPolicy } from '../src/heartbeat.js';
import { ParaMemory } from '../src/memory.js';
import { describeAction } from '../src/perception.js';
import { Runtime, type RuntimeEvent } from '../src/runtime.js';
import { parseSkillSource } from '../src/skills.js';
import { World } from '../src/world.js';

interface Opts {
  ticks: number;
  seed: number;
  tickMs: number;
  speed: number;
  startHour: number;
  out: string | null;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    ticks: 80,
    seed: 13,
    tickMs: 100,
    speed: 600,
    startHour: 6,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--ticks' || a === '-t') opts.ticks = Number.parseInt(next() ?? '', 10);
    else if (a === '--seed') opts.seed = Number.parseInt(next() ?? '', 10);
    else if (a === '--tick-ms') opts.tickMs = Number.parseInt(next() ?? '', 10);
    else if (a === '--speed') opts.speed = Number.parseInt(next() ?? '', 10);
    else if (a === '--start-hour') opts.startHour = Number.parseInt(next() ?? '', 10);
    else if (a === '--out') opts.out = next() ?? null;
  }
  return opts;
}

const ZONES: Zone[] = [
  { name: 'cafe', x: 1, y: 1, width: 4, height: 4 },
  { name: 'park', x: 14, y: 1, width: 4, height: 4 },
  { name: 'home', x: 9, y: 14, width: 4, height: 4 },
];

const BRUNO_SKILL = parseSkillSource(
  '---\nname: bruno-costa\ndescription: energetic extrovert who loves morning work at the cafe, chatty and social\n---\n\n# Bruno Costa\n\nBarista-trained programmer. Mornings at the cafe, evenings at the park.\n',
  '/virtual/bruno-costa/SKILL.md',
);

const PRIYA_SKILL = parseSkillSource(
  '---\nname: priya-shah\ndescription: curious introvert who tends to wander the town in the mornings before her afternoon shift\n---\n\n# Priya Shah\n\nWalks slowly through town in the mornings.\n',
  '/virtual/priya-shah/SKILL.md',
);

function makeSteeredPolicy(base: HeartbeatPolicy): HeartbeatPolicy {
  // Priya isn't plan-driven for this demo — she walks towards Bruno on the
  // way to the cafe to produce a deterministic interruption, then drifts
  // back towards the park. This is the "scripted NPC" you'd otherwise see
  // from an LLM deciding to approach the protagonist.
  return {
    async decide(ctx) {
      if (ctx.persona.id !== 'priya-shah') return base.decide(ctx);
      const tick = ctx.perception.tick;
      if (tick === 0) {
        return [
          { kind: 'set_goal', goal: 'walk through town' },
          { kind: 'goto', target: { x: 4, y: 3 }, label: 'cafe_approach' },
        ] satisfies AgentAction[];
      }
      if (tick === 10) {
        return [
          { kind: 'speak', to: null, text: 'hey Bruno — got a sec?' },
        ] satisfies AgentAction[];
      }
      if (tick === 13) {
        return [
          { kind: 'speak', to: null, text: 'thanks — catch you later.' },
          { kind: 'goto', target: { x: 16, y: 3 }, label: 'park' },
        ] satisfies AgentAction[];
      }
      return [{ kind: 'wait', seconds: 1 }] satisfies AgentAction[];
    },
  };
}

function formatEvent(event: RuntimeEvent): string {
  const t = event.kind === 'spawn' ? '   --' : event.simTime.toFixed(1).padStart(6);
  const tick = event.kind === 'spawn' ? '   ' : String(event.tick).padStart(3);
  const tag = `t=${t}s tick=${tick}`;
  switch (event.kind) {
    case 'spawn':
      return `${tag}  SPAWN        ${event.agentId.padEnd(16)} (${event.name})`;
    case 'tick':
      return `${tag}  TICK`;
    case 'plan_committed':
      return `${tag}  PLAN_COMMIT  ${event.agentId.padEnd(16)} day=${event.day} ${event.summary}`;
    case 'plan_replan':
      return `${tag}  PLAN_REPLAN  ${event.agentId.padEnd(16)} reason=${event.reason} ${event.detail}`;
    case 'plan_resume':
      return `${tag}  PLAN_RESUME  ${event.agentId.padEnd(16)} reason=${event.reason}`;
    case 'conversation_open':
      return `${tag}  CONV_OPEN    ${event.sessionId} [${event.participants.join(', ')}]`;
    case 'conversation_close':
      return `${tag}  CONV_CLOSE   ${event.sessionId} [${event.participants.join(', ')}] turns=${event.transcript.length} reason=${event.reason}`;
    case 'action': {
      const heard =
        event.action.kind === 'speak' && event.heardBy && event.heardBy.length > 0
          ? ` heardBy=${event.heardBy.join(',')}`
          : '';
      return `${tag}  ACTION       ${event.agentId.padEnd(16)} ${describeAction(event.action)}${heard}`;
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const lines: string[] = [];
  const events: RuntimeEvent[] = [];
  const log = (line: string) => {
    lines.push(line);
    console.log(line);
  };

  const clock = new SimulationClock({
    mode: 'stepped',
    speed: opts.speed,
    tickHz: 1000 / opts.tickMs,
    startSimTime: opts.startHour * 3600,
  });
  const world = new World({ width: 24, height: 24, clock, zones: ZONES });

  const brunoRoot = mkdtempSync(join(tmpdir(), 'tina-plan-demo-bruno-'));
  const priyaRoot = mkdtempSync(join(tmpdir(), 'tina-plan-demo-priya-'));

  const runtime = new Runtime({
    world,
    policy: makeSteeredPolicy(new DefaultHeartbeatPolicy()),
    agents: [
      {
        skill: BRUNO_SKILL,
        memory: new ParaMemory({
          root: brunoRoot,
          now: () => new Date('2026-04-21T06:00:00Z'),
        }),
        initial: { position: { x: 12, y: 14 } },
      },
      {
        skill: PRIYA_SKILL,
        memory: new ParaMemory({
          root: priyaRoot,
          now: () => new Date('2026-04-21T06:00:00Z'),
        }),
        initial: { position: { x: 20, y: 20 } },
      },
    ],
    tickMs: opts.tickMs,
    seed: opts.seed,
    speechTtlMs: 2500,
    conversationIdleMs: 12000,
    onEvent: (e) => {
      events.push(e);
      log(formatEvent(e));
    },
  });

  log(
    `# plan-demo | seed=${opts.seed} tickMs=${opts.tickMs} speed=${opts.speed} startHour=${opts.startHour}`,
  );
  log('#');
  log('# Bruno wakes at home with an extrovert/energetic persona. His plan puts');
  log('# him at the cafe for morning work. Priya is scripted to approach him');
  log('# and speak, then drift away. Watch for PLAN_REPLAN / PLAN_RESUME.');
  log('#');

  await runtime.runTicks(opts.ticks);
  await runtime.flushConversations();

  log('#');
  log('# --- event summary ---');
  log(
    `# commits=${events.filter((e) => e.kind === 'plan_committed').length}  ` +
      `replans=${events.filter((e) => e.kind === 'plan_replan').length}  ` +
      `resumes=${events.filter((e) => e.kind === 'plan_resume').length}  ` +
      `conv_open=${events.filter((e) => e.kind === 'conversation_open').length}  ` +
      `conv_close=${events.filter((e) => e.kind === 'conversation_close').length}`,
  );

  const bruno = runtime.listAgents().find((a) => a.def.id === 'bruno-costa')!;
  const plan = runtime.planRuntime.getPlan('bruno-costa');
  log(
    `# bruno final pos=(${bruno.state.position.x},${bruno.state.position.y}) zone=${bruno.state.zone ?? 'none'}`,
  );
  log(`# bruno plan summary: ${plan?.summary ?? '(none)'}`);
  log(`# bruno replan log: ${JSON.stringify(plan?.replanLog ?? [])}`);

  if (opts.out) {
    writeFileSync(opts.out, `${lines.join('\n')}\n`, 'utf8');
    console.error(`wrote ${lines.length} lines to ${opts.out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
