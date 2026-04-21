import type { AgentAction, ConversationTurn, Delta, SimTime, Vec2 } from '@tina/shared';
import { Agent, type AgentState } from './agent.js';
import { SimulationClock } from './clock.js';
import { ConversationRegistry, type ConversationSession } from './conversation.js';
import type { HeartbeatPolicy } from './heartbeat.js';
import { DefaultHeartbeatPolicy, makeRngForAgent } from './heartbeat.js';
import type { MemoryFact, ParaMemory } from './memory.js';
import {
  type Perception,
  chebyshevDistance,
  nearbyAgents,
  stepToward,
  timeOfDay,
} from './perception.js';
import { type DayPlan, PlanRuntime } from './plan.js';
import { ReflectionEngine, type ReflectionEngineOptions } from './reflection.js';
import type { SkillDocument } from './skills.js';
import { TelemetryCollector, type TelemetrySnapshot } from './telemetry.js';
import { World } from './world.js';

export interface RuntimeAgent {
  skill: SkillDocument;
  memory: ParaMemory;
  initial?: Partial<AgentState>;
}

export interface RuntimeOptions {
  agents: RuntimeAgent[];
  world?: World;
  policy?: HeartbeatPolicy;
  tickMs?: number;
  perceptionRadius?: number;
  speechRadius?: number;
  speechTtlMs?: number;
  conversationIdleMs?: number;
  seed?: number;
  onEvent?: (event: RuntimeEvent) => void;
  /**
   * Flush every agent's buffered memory to disk every N ticks. Default 10.
   * Set to 0 or a negative number to disable periodic flushing (callers must
   * drive flush themselves via flushMemories()).
   */
  memoryFlushEveryTicks?: number;
  telemetry?: TelemetryCollector;
  /**
   * Per-agent reflection engine config. Set to `false` to disable consolidation
   * entirely (useful for tiny test sims).
   */
  reflections?: ReflectionEngineOptions | false;
  /**
   * Cap on how many facts the runtime injects into Perception.recentFacts each
   * tick. Default 5 — keeps the seam small for an LLM-backed policy later.
   */
  recallLimit?: number;
}

export type RuntimeEvent =
  | { kind: 'tick'; tick: number; simTime: SimTime }
  | {
      kind: 'action';
      tick: number;
      simTime: SimTime;
      agentId: string;
      action: AgentAction;
      heardBy?: string[];
    }
  | { kind: 'spawn'; agentId: string; name: string }
  | {
      kind: 'conversation_open';
      tick: number;
      simTime: SimTime;
      sessionId: string;
      participants: string[];
    }
  | {
      kind: 'conversation_close';
      tick: number;
      simTime: SimTime;
      sessionId: string;
      participants: string[];
      transcript: ConversationTurn[];
      reason: 'drifted' | 'idle';
    }
  | {
      kind: 'plan_committed';
      tick: number;
      simTime: SimTime;
      agentId: string;
      summary: string;
      day: number;
    }
  | {
      kind: 'plan_replan';
      tick: number;
      simTime: SimTime;
      agentId: string;
      reason: string;
      detail: string;
    }
  | {
      kind: 'plan_resume';
      tick: number;
      simTime: SimTime;
      agentId: string;
      reason: string;
    }
  | {
      kind: 'reflection_written';
      tick: number;
      simTime: SimTime;
      agentId: string;
      trigger: 'day_rollover' | 'importance_budget' | 'manual';
      reflectionId: string;
      summary: string;
      sourceCount: number;
    };

interface Recent {
  speech: Array<{
    speakerId: string;
    speakerName: string;
    text: string;
    at: SimTime;
    expireAt: SimTime;
  }>;
}

export class Runtime {
  readonly world: World;
  readonly clock: SimulationClock;
  private readonly policy: HeartbeatPolicy;
  private readonly tickMs: number;
  private readonly perceptionRadius: number;
  private readonly speechRadius: number;
  private readonly speechTtlMs: number;
  private readonly seed: number;
  private readonly onEvent?: (event: RuntimeEvent) => void;
  private readonly agents: Agent[] = [];
  private readonly memories = new Map<string, ParaMemory>();
  private readonly skills = new Map<string, SkillDocument>();
  private readonly recent: Recent = { speech: [] };
  private readonly conversations: ConversationRegistry;
  private readonly memoryFlushEveryTicks: number;
  readonly telemetry: TelemetryCollector;
  readonly planRuntime: PlanRuntime;
  private readonly reflectionEngines = new Map<string, ReflectionEngine>();
  private readonly reflectionsEnabled: boolean;
  private readonly reflectionOpts: ReflectionEngineOptions;
  private readonly recallLimit: number;
  private tickIndex = 0;
  private flushInFlight: Promise<void> | null = null;

  constructor(opts: RuntimeOptions) {
    this.tickMs = opts.tickMs ?? 100;
    this.perceptionRadius = opts.perceptionRadius ?? 5;
    this.speechRadius = opts.speechRadius ?? 4;
    this.speechTtlMs = opts.speechTtlMs ?? 2000;
    const conversationIdleMs = opts.conversationIdleMs ?? this.speechTtlMs * 4;
    this.seed = opts.seed ?? 0;
    this.policy = opts.policy ?? new DefaultHeartbeatPolicy();
    this.onEvent = opts.onEvent;
    this.memoryFlushEveryTicks = opts.memoryFlushEveryTicks ?? 10;
    this.telemetry = opts.telemetry ?? new TelemetryCollector();
    this.reflectionsEnabled = opts.reflections !== false;
    this.reflectionOpts = opts.reflections ? opts.reflections : {};
    this.recallLimit = opts.recallLimit ?? 5;
    this.world =
      opts.world ??
      new World({
        width: 24,
        height: 24,
        clock: new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 }),
      });
    this.clock = this.world.clock;
    this.conversations = new ConversationRegistry({
      speechRadius: this.speechRadius,
      idleTtlSim: (conversationIdleMs / 1000) * this.clock.speed,
    });
    this.planRuntime = new PlanRuntime();

    for (const entry of opts.agents) {
      this.spawn(entry);
    }
  }

  private spawn(entry: RuntimeAgent): Agent {
    const agent = new Agent(
      {
        id: entry.skill.id,
        name: entry.skill.displayName,
        description: entry.skill.description,
        body: entry.skill.body,
        metadata: entry.skill.metadata,
      },
      entry.initial ?? {},
    );
    this.agents.push(agent);
    this.memories.set(agent.def.id, entry.memory);
    this.skills.set(agent.def.id, entry.skill);
    if (this.reflectionsEnabled) {
      this.reflectionEngines.set(agent.def.id, new ReflectionEngine(this.reflectionOpts));
    }
    this.world.addAgent(agent);
    this.emit({ kind: 'spawn', agentId: agent.def.id, name: agent.def.name });
    return agent;
  }

  listAgents(): Agent[] {
    return [...this.agents];
  }

  private emit(event: RuntimeEvent): void {
    this.telemetry.observe(event);
    this.onEvent?.(event);
  }

  async tickOnce(): Promise<Delta[]> {
    const tickStart = performance.now();
    const deltas = this.world.tick(this.tickMs);
    this.pruneRecent();
    const simTime = this.world.simTime;
    const tick = this.tickIndex;
    this.emit({ kind: 'tick', tick, simTime });

    for (const agent of this.agents) {
      await this.stepGoto(agent, tick, simTime);
    }

    for (const agent of this.agents) {
      const memory = this.memories.get(agent.def.id)!;
      const skill = this.skills.get(agent.def.id)!;

      const perception = await this.buildPerception(agent, tick, memory);

      const { plan, committed } = await this.planRuntime.ensurePlan({
        agentId: agent.def.id,
        persona: skill,
        zones: this.world.zones,
        memory,
        simTime,
      });

      if (committed) {
        this.emit({
          kind: 'plan_committed',
          tick,
          simTime,
          agentId: agent.def.id,
          summary: plan.summary,
          day: plan.day,
        });
        await memory.appendDailyNote(`wake: committed to ${plan.summary}`);
      }

      const suspended = await this.handleSurprises(agent, perception, plan, tick, simTime);

      const rng = makeRngForAgent(agent.def.id, this.seed, tick);
      const actions = await this.policy.decide({
        persona: skill,
        perception,
        memory,
        rng,
        plan,
        suspended,
      });

      for (const action of actions) {
        await this.applyAction(agent, action, tick, simTime);
      }
      agent.state.zone = this.world.zoneAt(agent.state.position);
      agent.state.lastHeartbeatAt = simTime;

      await this.maybeReflectAgent(agent.def.id, simTime, tick);
    }

    await this.sweepConversations(tick, simTime);
    this.tickIndex += 1;
    this.telemetry.setActiveConversations(this.conversations.activeCount());
    this.telemetry.recordTickDuration(performance.now() - tickStart);
    if (this.memoryFlushEveryTicks > 0 && this.tickIndex % this.memoryFlushEveryTicks === 0) {
      this.schedulePeriodicFlush();
    }
    return deltas;
  }

  /** Persist every agent's buffered memory to disk. */
  async flushMemories(): Promise<void> {
    if (this.flushInFlight) await this.flushInFlight;
    const pending: Promise<void>[] = [];
    for (const memory of this.memories.values()) pending.push(memory.flush());
    if (pending.length > 0) await Promise.all(pending);
  }

  /**
   * Kick off a periodic flush without blocking the tick loop. If a flush is
   * already in flight we skip this round — the next period will catch up.
   */
  private schedulePeriodicFlush(): void {
    if (this.flushInFlight) return;
    const pending: Promise<void>[] = [];
    for (const memory of this.memories.values()) pending.push(memory.flush());
    if (pending.length === 0) return;
    this.flushInFlight = Promise.all(pending)
      .then(() => {})
      .finally(() => {
        this.flushInFlight = null;
      });
  }

  telemetrySnapshot(): TelemetrySnapshot {
    this.telemetry.setActiveConversations(this.conversations.activeCount());
    return this.telemetry.snapshot();
  }

  async runTicks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await this.tickOnce();
  }

  /** Flush any still-open sessions and persist their transcripts. Also flushes memory. */
  async flushConversations(): Promise<void> {
    const simTime = this.world.simTime;
    const tick = this.tickIndex;
    const pending: Array<{ session: ConversationSession; reason: 'drifted' | 'idle' }> = [];
    this.conversations.drain({
      onClose: (session, reason) => pending.push({ session, reason }),
    });
    for (const { session, reason } of pending) {
      await this.handleConversationClose(session, reason, tick, simTime);
    }
    await this.flushMemories();
  }

  private async handleSurprises(
    agent: Agent,
    perception: Perception,
    plan: DayPlan,
    tick: number,
    simTime: SimTime,
  ): Promise<string | null> {
    const memory = this.memories.get(agent.def.id)!;
    const existing = this.planRuntime.suspension(agent.def.id);

    const heardNearby = perception.recentSpeech.find((s) =>
      perception.nearby.some((n) => n.id === s.speakerId),
    );

    if (!existing && heardNearby) {
      const detail = `heard ${heardNearby.speakerName}: "${heardNearby.text}"`;
      this.planRuntime.suspend(agent.def.id, 'conversation');
      await this.planRuntime.recordReplan({
        agentId: agent.def.id,
        memory,
        simTime,
        reason: 'conversation',
        detail,
      });
      this.emit({
        kind: 'plan_replan',
        tick,
        simTime,
        agentId: agent.def.id,
        reason: 'conversation',
        detail,
      });
      await memory.appendDailyNote(`t=${simTime.toFixed(1)}s replan: ${detail}`);
      // Hold position — drop any goto so the agent stays to converse.
      agent.state.gotoTarget = null;
      agent.state.gotoLabel = null;
      return 'conversation';
    }

    if (existing === 'conversation') {
      const stillEngaged = perception.nearby.length > 0 || perception.recentSpeech.length > 0;
      if (!stillEngaged) {
        this.planRuntime.resume(agent.def.id);
        this.emit({
          kind: 'plan_resume',
          tick,
          simTime,
          agentId: agent.def.id,
          reason: 'conversation_ended',
        });
        await memory.appendDailyNote(
          `t=${simTime.toFixed(1)}s resume: back to plan — ${plan.summary.slice(0, 80)}`,
        );
        return null;
      }
      return existing;
    }

    return existing;
  }

  private async stepGoto(agent: Agent, tick: number, simTime: SimTime): Promise<void> {
    const target = agent.state.gotoTarget;
    if (!target) return;
    const pos = agent.state.position;
    if (pos.x === target.x && pos.y === target.y) {
      agent.state.gotoTarget = null;
      agent.state.gotoLabel = null;
      agent.state.currentAction = agent.state.gotoLabel
        ? `arrived at ${agent.state.gotoLabel}`
        : 'idle';
      return;
    }
    const next = stepToward(pos, target);
    if (next.x === pos.x && next.y === pos.y) {
      agent.state.gotoTarget = null;
      agent.state.gotoLabel = null;
      return;
    }
    if (next.x < 0 || next.y < 0 || next.x >= this.world.width || next.y >= this.world.height) {
      agent.state.gotoTarget = null;
      agent.state.gotoLabel = null;
      return;
    }
    const move: AgentAction = { kind: 'move_to', to: next };
    await this.applyAction(agent, move, tick, simTime);
    if (next.x === target.x && next.y === target.y) {
      agent.state.gotoTarget = null;
      agent.state.gotoLabel = null;
      agent.state.currentAction = 'idle';
    }
  }

  private async applyAction(
    agent: Agent,
    action: AgentAction,
    tick: number,
    simTime: SimTime,
  ): Promise<void> {
    switch (action.kind) {
      case 'move_to': {
        const from = { ...agent.state.position };
        agent.apply(action);
        this.world.emit({
          kind: 'agent_move',
          id: agent.def.id,
          from,
          to: { ...action.to },
          durationMs: this.tickMs,
        });
        this.emit({ kind: 'action', tick, simTime, agentId: agent.def.id, action });
        return;
      }
      case 'goto': {
        agent.apply(action);
        this.world.emit({
          kind: 'agent_action',
          id: agent.def.id,
          action: agent.state.currentAction,
        });
        this.emit({ kind: 'action', tick, simTime, agentId: agent.def.id, action });
        return;
      }
      case 'speak': {
        agent.apply(action);
        const heardBy = this.agents
          .filter(
            (a) =>
              a.def.id !== agent.def.id &&
              chebyshevDistance(a.state.position, agent.state.position) <= this.speechRadius,
          )
          .map((a) => a.def.id);
        this.recent.speech.push({
          speakerId: agent.def.id,
          speakerName: agent.def.name,
          text: action.text,
          at: simTime,
          expireAt: simTime + (this.speechTtlMs / 1000) * this.clock.speed,
        });
        this.world.emit({
          kind: 'speech',
          id: agent.def.id,
          text: action.text,
          heardBy,
          ttlMs: this.speechTtlMs,
        });
        await this.recordListenerMemory(agent, action.text, heardBy, simTime);
        if (heardBy.length > 0) {
          this.conversations.recordSpeech(agent.def.id, action.text, simTime, heardBy, {
            onOpen: (session) => {
              this.world.emit({
                kind: 'conversation_open',
                sessionId: session.id,
                participants: [...session.participants],
                simTime,
              });
              this.emit({
                kind: 'conversation_open',
                tick,
                simTime,
                sessionId: session.id,
                participants: [...session.participants],
              });
            },
          });
        }
        this.emit({
          kind: 'action',
          tick,
          simTime,
          agentId: agent.def.id,
          action,
          heardBy,
        });
        return;
      }
      case 'remember': {
        agent.apply(action);
        const memory = this.memories.get(agent.def.id)!;
        const f = await memory.addFact({ fact: action.fact, category: 'observation' });
        this.reflectionEngines.get(agent.def.id)?.noteNewFact(f);
        await memory.appendDailyNote(`t=${simTime.toFixed(1)}s ${action.fact}`);
        this.emit({ kind: 'action', tick, simTime, agentId: agent.def.id, action });
        return;
      }
      case 'wait':
      case 'set_goal': {
        agent.apply(action);
        this.world.emit({
          kind: 'agent_action',
          id: agent.def.id,
          action: agent.state.currentAction,
        });
        this.emit({ kind: 'action', tick, simTime, agentId: agent.def.id, action });
        return;
      }
    }
  }

  private async sweepConversations(tick: number, simTime: SimTime): Promise<void> {
    const positions = new Map<string, Vec2>();
    for (const agent of this.agents) positions.set(agent.def.id, agent.state.position);
    const pending: Array<{ session: ConversationSession; reason: 'drifted' | 'idle' }> = [];
    this.conversations.sweep(positions, simTime, {
      onClose: (session, reason) => pending.push({ session, reason }),
    });
    for (const { session, reason } of pending) {
      await this.handleConversationClose(session, reason, tick, simTime);
    }
  }

  private async handleConversationClose(
    session: ConversationSession,
    reason: 'drifted' | 'idle',
    tick: number,
    simTime: SimTime,
  ): Promise<void> {
    const participants = [...session.participants];
    this.world.emit({
      kind: 'conversation_close',
      sessionId: session.id,
      participants,
      transcript: session.transcript,
      simTime,
      reason,
    });
    this.emit({
      kind: 'conversation_close',
      tick,
      simTime,
      sessionId: session.id,
      participants,
      transcript: session.transcript,
      reason,
    });
    await this.persistConversation(session, participants);
  }

  private async persistConversation(
    session: ConversationSession,
    participants: string[],
  ): Promise<void> {
    const nameById = new Map<string, string>();
    for (const agent of this.agents) nameById.set(agent.def.id, agent.def.name);
    const transcriptSummary = session.transcript
      .map((t) => `${nameById.get(t.speakerId) ?? t.speakerId}: ${t.text}`)
      .join(' | ');
    const openedAt = session.openedAt.toFixed(1);
    for (const id of participants) {
      const memory = this.memories.get(id);
      if (!memory) continue;
      const others = participants.filter((p) => p !== id).map((p) => nameById.get(p) ?? p);
      const label = others.length > 0 ? others.join(' & ') : 'someone';
      const fact = await memory.addFact({
        fact: `talked with ${label}: ${transcriptSummary}`,
        category: 'relationship',
        related_entities: participants.filter((p) => p !== id),
        source: `conversation:${session.id}`,
      });
      this.reflectionEngines.get(id)?.noteNewFact(fact);
      await memory.appendDailyNote(
        `t=${openedAt}s conversation with ${label} (${session.transcript.length} turns) — ${transcriptSummary}`,
      );
    }
  }

  private async recordListenerMemory(
    speaker: Agent,
    text: string,
    listenerIds: string[],
    simTime: SimTime,
  ): Promise<void> {
    if (listenerIds.length === 0) return;
    for (const id of listenerIds) {
      const memory = this.memories.get(id);
      if (!memory) continue;
      await memory.appendDailyNote(`t=${simTime.toFixed(1)}s heard ${speaker.def.name}: "${text}"`);
    }
  }

  private async buildPerception(
    agent: Agent,
    tick: number,
    memory: ParaMemory,
  ): Promise<Perception> {
    const others = this.agents.filter((a) => a.def.id !== agent.def.id);
    const recentSpeech = this.recent.speech
      .filter((s) => s.speakerId !== agent.def.id)
      .filter((s) => {
        const speaker = this.agents.find((a) => a.def.id === s.speakerId);
        if (!speaker) return false;
        return chebyshevDistance(agent.state.position, speaker.state.position) <= this.speechRadius;
      })
      .map((s) => ({ speakerId: s.speakerId, speakerName: s.speakerName, text: s.text, at: s.at }));
    const nearby = nearbyAgents(agent, others, this.perceptionRadius);
    let recentFacts: MemoryFact[] = [];
    if (this.recallLimit > 0) {
      const recalled = await memory.recallForDecision({
        limit: this.recallLimit,
        relatedTo: nearby.map((n) => n.id),
      });
      recentFacts = recalled.map((r) => r.fact);
    }
    return {
      tick,
      simTime: this.world.simTime,
      timeOfDay: timeOfDay(this.world.simTime),
      self: agent.snapshot(),
      nearby,
      recentSpeech,
      recentFacts,
      worldBounds: { width: this.world.width, height: this.world.height },
      zones: [...this.world.zones],
    };
  }

  private async maybeReflectAgent(agentId: string, simTime: SimTime, tick: number): Promise<void> {
    const engine = this.reflectionEngines.get(agentId);
    if (!engine) return;
    const memory = this.memories.get(agentId);
    if (!memory) return;
    const result = await engine.maybeReflect({ memory, simTime });
    if (!result) return;
    this.emit({
      kind: 'reflection_written',
      tick,
      simTime,
      agentId,
      trigger: result.trigger,
      reflectionId: result.reflection.id,
      summary: result.reflection.fact,
      sourceCount: result.sourceFactIds.length,
    });
  }

  private pruneRecent(): void {
    const now = this.world.simTime;
    this.recent.speech = this.recent.speech.filter((s) => s.expireAt >= now);
  }
}
