import {
  type AgentAction,
  type AgentMood,
  type ConversationTurn,
  type Delta,
  type InterventionKind,
  type PlanContext,
  type SimTime,
  type Vec2,
  WORLD_STATE_SNAPSHOT_VERSION,
  type WorldObject,
  type WorldStateSnapshot,
} from '@tina/shared';
import { Agent, type AgentState } from './agent.js';
import { SimulationClock } from './clock.js';
import {
  type CloseReason,
  ConversationRegistry,
  type ConversationSession,
} from './conversation.js';
import type { HeartbeatPolicy } from './heartbeat.js';
import { DefaultHeartbeatPolicy, makeRngForAgent } from './heartbeat.js';
import type { MemoryFact, ParaMemory } from './memory.js';
import { findPath } from './path.js';
import {
  type HeardSpeech,
  type ObservedEvent,
  type Perception,
  chebyshevDistance,
  nearbyAgents,
  timeOfDay,
} from './perception.js';
import { type DayPlan, PlanRuntime, activeBlock, simHour } from './plan.js';
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
  /**
   * Per-session age cap in wall-ms (converted to sim-seconds). Force-closes
   * conversations that exceed it, so persistence + reflection eventually run
   * even under continuous chatter. Default 60_000 ms wall (= 30 sim-min at
   * 30× speed).
   */
  conversationMaxAgeMs?: number;
  /**
   * Fractional jitter (0–0.5) on `conversationMaxAgeMs` to spread close
   * events across many ticks instead of stampeding the same tick. Default 0.3.
   */
  conversationMaxAgeJitter?: number;
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
      reason: CloseReason;
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
    }
  | {
      kind: 'intervention';
      tick: number;
      simTime: SimTime;
      type: InterventionKind;
      summary: string;
      target: string | null;
      zone: string | null;
      affected: string[];
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

interface PendingWhisper {
  targetId: string;
  heard: HeardSpeech;
  expireAt: SimTime;
}

interface PendingObservation {
  targetId: string;
  observed: ObservedEvent;
  expireAt: SimTime;
}

export interface InterventionWhisperInput {
  agentId: string;
  text: string;
}

export interface InterventionEventInput {
  text: string;
  zone?: string | null;
  agentIds?: string[];
}

export interface InterventionDropObjectInput {
  id?: string;
  label: string;
  pos?: Vec2;
  zone?: string | null;
}

export interface InterventionRemoveObjectInput {
  id: string;
}

export interface InterventionResult {
  simTime: SimTime;
  affected: string[];
  summary: string;
}

export interface InterventionDropResult extends InterventionResult {
  object: WorldObject;
}

export class Runtime {
  readonly world: World;
  readonly clock: SimulationClock;
  readonly seed: number;
  private readonly policy: HeartbeatPolicy;
  private readonly tickMs: number;
  private readonly perceptionRadius: number;
  private readonly speechRadius: number;
  private readonly speechTtlMs: number;
  private onEventCb?: (event: RuntimeEvent) => void;
  private readonly agents: Agent[] = [];
  private readonly memories = new Map<string, ParaMemory>();
  private readonly skills = new Map<string, SkillDocument>();
  private readonly recent: Recent = { speech: [] };
  private readonly pendingWhispers: PendingWhisper[] = [];
  private readonly pendingObservations: PendingObservation[] = [];
  private interventionSeq = 0;
  private readonly conversations: ConversationRegistry;
  private readonly memoryFlushEveryTicks: number;
  readonly telemetry: TelemetryCollector;
  readonly planRuntime: PlanRuntime;
  private readonly reflectionEngines = new Map<string, ReflectionEngine>();
  private readonly reflectionsEnabled: boolean;
  private readonly reflectionOpts: ReflectionEngineOptions;
  /**
   * Agents with a reflection synthesis in flight. Reflections call the LLM
   * gateway, which can take seconds; awaiting them inside `tickOnce` stalls
   * the whole sim (see TINA-21). We fire-and-forget and skip re-entry for
   * the same agent while a call is still pending.
   */
  private readonly reflectionInFlight = new Set<string>();
  /** Outstanding reflection promises, tracked so tests can await completion. */
  private readonly reflectionPromises = new Map<string, Promise<void>>();
  /**
   * Outstanding `persistConversation` promises. Same rationale as reflections
   * (TINA-21): a mass-close burst (e.g. 1900 sessions all hitting maxAgeSim
   * on the same tick) would otherwise await thousands of disk writes inside
   * `tickOnce`, stalling the sim. See TINA-22.
   */
  private readonly persistPromises = new Set<Promise<void>>();
  private readonly recallLimit: number;
  private _tickIndex = 0;
  private flushInFlight: Promise<void> | null = null;

  get tickIndex(): number {
    return this._tickIndex;
  }

  constructor(opts: RuntimeOptions) {
    this.tickMs = opts.tickMs ?? 100;
    this.perceptionRadius = opts.perceptionRadius ?? 5;
    this.speechRadius = opts.speechRadius ?? 4;
    this.speechTtlMs = opts.speechTtlMs ?? 2000;
    const conversationIdleMs = opts.conversationIdleMs ?? this.speechTtlMs * 4;
    this.seed = opts.seed ?? 0;
    this.policy = opts.policy ?? new DefaultHeartbeatPolicy();
    this.onEventCb = opts.onEvent;
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
    const conversationMaxAgeMs = opts.conversationMaxAgeMs ?? 60_000;
    this.conversations = new ConversationRegistry({
      speechRadius: this.speechRadius,
      idleTtlSim: (conversationIdleMs / 1000) * this.clock.speed,
      maxAgeSim: (conversationMaxAgeMs / 1000) * this.clock.speed,
      maxAgeJitter: opts.conversationMaxAgeJitter ?? 0.3,
    });
    this.planRuntime = new PlanRuntime();

    for (const entry of opts.agents) {
      this.spawn(entry);
    }
  }

  private spawn(entry: RuntimeAgent): Agent {
    const meta = entry.skill.metadata;
    const named = meta.named === 'true';
    const agent = new Agent(
      {
        id: entry.skill.id,
        name: entry.skill.displayName,
        description: entry.skill.description,
        body: entry.skill.body,
        metadata: meta,
        named,
        color: named ? (meta.glyph_color ?? null) : null,
        accent: named ? (meta.glyph_accent ?? null) : null,
        bio: named ? (meta.bio ?? null) : null,
      },
      entry.initial ?? {},
    );
    this.agents.push(agent);
    this.memories.set(agent.def.id, entry.memory);
    this.skills.set(agent.def.id, entry.skill);
    if (this.reflectionsEnabled) {
      this.reflectionEngines.set(
        agent.def.id,
        new ReflectionEngine({ ...this.reflectionOpts, entity: agent.def.id }),
      );
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
    this.onEventCb?.(event);
  }

  /** Subscribe (or replace) the runtime event observer. */
  setOnEvent(cb: ((event: RuntimeEvent) => void) | undefined): void {
    this.onEventCb = cb;
  }

  /**
   * Derive a lightweight observability snapshot for one agent: current mood and
   * the active plan block. Used by admin dashboards — no-op for agents we've
   * never seen a plan for.
   */
  agentContext(agentId: string): { mood: AgentMood; plan: PlanContext | null } {
    const plan = this.planRuntime.getPlan(agentId);
    const agent = this.agents.find((a) => a.def.id === agentId);
    const suspended = this.planRuntime.suspension(agentId);
    if (!plan || !agent) return { mood: 'idle', plan: null };
    const hour = simHour(this.world.simTime);
    const block = activeBlock(plan, hour);
    const ctx: PlanContext = {
      day: plan.day,
      summary: plan.summary,
      blockId: block?.id ?? 'idle',
      blockIntent: block?.intent ?? 'no active block',
      blockActivity: block?.activity ?? 'rest',
      preferredZone: block?.preferredZone ?? null,
      suspendedReason: suspended,
    };
    return { mood: deriveMood(block?.activity, suspended, agent.state.currentAction), plan: ctx };
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

      this.maybeReflectAgent(agent.def.id, simTime, tick);
    }

    this.sweepConversations(tick, simTime);
    this._tickIndex += 1;
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
    const pending: Array<{ session: ConversationSession; reason: CloseReason }> = [];
    this.conversations.drain({
      onClose: (session, reason) => pending.push({ session, reason }),
    });
    for (const { session, reason } of pending) {
      this.handleConversationClose(session, reason, tick, simTime);
    }
    await this.awaitConversationPersists();
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

    // Interventions fire independently of conversation suspend/resume: they
    // push a plan_replan + memory fact, but leave the existing suspension
    // state alone so they stack cleanly with a live conversation.
    await this.handleInterventions(agent, perception, tick, simTime);

    const existing = this.planRuntime.suspension(agent.def.id);

    const heardNearby = perception.recentSpeech.find(
      (s) => s.source !== 'intervention' && perception.nearby.some((n) => n.id === s.speakerId),
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

  private async handleInterventions(
    agent: Agent,
    perception: Perception,
    tick: number,
    simTime: SimTime,
  ): Promise<void> {
    const memory = this.memories.get(agent.def.id)!;
    for (const heard of perception.recentSpeech) {
      if (heard.source !== 'intervention') continue;
      const detail = `whisper: "${heard.text}"`;
      await this.planRuntime.recordReplan({
        agentId: agent.def.id,
        memory,
        simTime,
        reason: 'whisper',
        detail,
      });
      this.emit({
        kind: 'plan_replan',
        tick,
        simTime,
        agentId: agent.def.id,
        reason: 'whisper',
        detail,
      });
      const fact = await memory.addFact({
        fact: heard.text,
        category: 'observation',
        importance: 6,
        source: 'intervention:whisper',
      });
      this.reflectionEngines.get(agent.def.id)?.noteNewFact(fact);
      await memory.appendDailyNote(`t=${simTime.toFixed(1)}s whisper: "${heard.text}"`);
    }
    for (const obs of perception.recentObservations) {
      if (obs.source !== 'intervention') continue;
      const reason = `intervention:${obs.kind}`;
      await this.planRuntime.recordReplan({
        agentId: agent.def.id,
        memory,
        simTime,
        reason,
        detail: obs.text,
      });
      this.emit({
        kind: 'plan_replan',
        tick,
        simTime,
        agentId: agent.def.id,
        reason,
        detail: obs.text,
      });
      const importance = obs.kind === 'world_event' ? 5 : 4;
      const fact = await memory.addFact({
        fact: obs.text,
        category: 'observation',
        importance,
        source: `intervention:${obs.kind}`,
      });
      this.reflectionEngines.get(agent.def.id)?.noteNewFact(fact);
      await memory.appendDailyNote(`t=${simTime.toFixed(1)}s ${obs.text}`);
    }
  }

  /**
   * Queue a whisper intervention for a single agent. Delivered on the next
   * tick via perception.recentSpeech (source: intervention).
   */
  injectWhisper(input: InterventionWhisperInput): InterventionResult {
    const text = (input.text ?? '').trim();
    if (!text) throw new Error('whisper text must be non-empty');
    const target = this.agents.find((a) => a.def.id === input.agentId);
    if (!target) throw new Error(`unknown agent id: ${input.agentId}`);
    const simTime = this.world.simTime;
    const tick = this.tickIndex;
    // Keep the whisper alive for a few ticks so it survives perception even
    // if the agent doesn't run immediately.
    const expireAt = simTime + Math.max(1, (this.speechTtlMs / 1000) * this.clock.speed);
    this.pendingWhispers.push({
      targetId: target.def.id,
      heard: {
        speakerId: 'intervention',
        speakerName: 'viewer',
        text,
        at: simTime,
        source: 'intervention',
      },
      expireAt,
    });
    this.emit({
      kind: 'intervention',
      tick,
      simTime,
      type: 'whisper',
      summary: text,
      target: target.def.id,
      zone: null,
      affected: [target.def.id],
    });
    this.world.emit({
      kind: 'intervention',
      type: 'whisper',
      summary: text,
      target: target.def.id,
      zone: null,
      affected: [target.def.id],
      simTime,
    });
    return { simTime, affected: [target.def.id], summary: text };
  }

  /**
   * Queue a world-event observation for every agent in `zone` (or the agents
   * named in `agentIds`, or all agents). Delivered on the next tick via
   * perception.recentObservations (source: intervention, kind: world_event).
   */
  injectWorldEvent(input: InterventionEventInput): InterventionResult {
    const text = (input.text ?? '').trim();
    if (!text) throw new Error('event text must be non-empty');
    const zone = input.zone ?? null;
    const affected: string[] = [];
    const targetIds = input.agentIds && input.agentIds.length > 0 ? new Set(input.agentIds) : null;
    for (const agent of this.agents) {
      if (targetIds && !targetIds.has(agent.def.id)) continue;
      if (zone && this.world.zoneAt(agent.state.position) !== zone) continue;
      affected.push(agent.def.id);
    }
    const simTime = this.world.simTime;
    const tick = this.tickIndex;
    const expireAt = simTime + Math.max(1, (this.speechTtlMs / 1000) * this.clock.speed);
    for (const id of affected) {
      this.pendingObservations.push({
        targetId: id,
        observed: { kind: 'world_event', source: 'intervention', text, zone, at: simTime },
        expireAt,
      });
    }
    this.emit({
      kind: 'intervention',
      tick,
      simTime,
      type: 'world_event',
      summary: text,
      target: null,
      zone,
      affected,
    });
    this.world.emit({
      kind: 'intervention',
      type: 'world_event',
      summary: text,
      target: null,
      zone,
      affected,
      simTime,
    });
    return { simTime, affected, summary: text };
  }

  /**
   * Drop a new object into the world. Nearby agents (perception radius, or
   * agents in the same zone if `zone` is set) get a world_event observation
   * phrased as "noticed <label> appear".
   */
  dropObject(input: InterventionDropObjectInput): InterventionDropResult {
    const label = (input.label ?? '').trim();
    if (!label) throw new Error('object label must be non-empty');
    const simTime = this.world.simTime;
    const tick = this.tickIndex;
    const id = input.id ?? this.nextInterventionId('obj');
    if (this.world.getObject(id)) throw new Error(`object id already exists: ${id}`);
    let pos = input.pos ?? null;
    if (!pos && input.zone) {
      pos = this.world.zoneCenter(input.zone);
    }
    if (!pos) {
      pos = { x: Math.floor(this.world.width / 2), y: Math.floor(this.world.height / 2) };
    }
    const zone = input.zone ?? this.world.zoneAt(pos);
    const object = this.world.addObject({
      id,
      label,
      pos: { ...pos },
      zone,
      droppedAtSim: simTime,
    });
    const text = zone ? `a ${label} appeared at ${zone}` : `a ${label} appeared`;
    const expireAt = simTime + Math.max(1, (this.speechTtlMs / 1000) * this.clock.speed);
    const affected: string[] = [];
    for (const agent of this.agents) {
      const inZone = zone && this.world.zoneAt(agent.state.position) === zone;
      const nearby = chebyshevDistance(agent.state.position, object.pos) <= this.perceptionRadius;
      if (!inZone && !nearby) continue;
      affected.push(agent.def.id);
      this.pendingObservations.push({
        targetId: agent.def.id,
        observed: { kind: 'object_drop', source: 'intervention', text, zone, at: simTime },
        expireAt,
      });
    }
    this.emit({
      kind: 'intervention',
      tick,
      simTime,
      type: 'object_drop',
      summary: text,
      target: null,
      zone,
      affected,
    });
    this.world.emit({
      kind: 'intervention',
      type: 'object_drop',
      summary: text,
      target: null,
      zone,
      affected,
      simTime,
    });
    return { simTime, affected, summary: text, object };
  }

  /**
   * Remove an existing object. Agents previously near it (perception radius,
   * or zone match) get an object_remove observation.
   */
  removeObject(input: InterventionRemoveObjectInput): InterventionResult {
    const existing = this.world.getObject(input.id);
    if (!existing) throw new Error(`unknown object id: ${input.id}`);
    const simTime = this.world.simTime;
    const tick = this.tickIndex;
    const text = existing.zone
      ? `the ${existing.label} at ${existing.zone} is gone`
      : `the ${existing.label} is gone`;
    const expireAt = simTime + Math.max(1, (this.speechTtlMs / 1000) * this.clock.speed);
    const affected: string[] = [];
    for (const agent of this.agents) {
      const inZone = existing.zone && this.world.zoneAt(agent.state.position) === existing.zone;
      const nearby = chebyshevDistance(agent.state.position, existing.pos) <= this.perceptionRadius;
      if (!inZone && !nearby) continue;
      affected.push(agent.def.id);
      this.pendingObservations.push({
        targetId: agent.def.id,
        observed: {
          kind: 'object_remove',
          source: 'intervention',
          text,
          zone: existing.zone,
          at: simTime,
        },
        expireAt,
      });
    }
    this.world.removeObject(existing.id);
    this.emit({
      kind: 'intervention',
      tick,
      simTime,
      type: 'object_remove',
      summary: text,
      target: null,
      zone: existing.zone,
      affected,
    });
    this.world.emit({
      kind: 'intervention',
      type: 'object_remove',
      summary: text,
      target: null,
      zone: existing.zone,
      affected,
      simTime,
    });
    return { simTime, affected, summary: text };
  }

  private nextInterventionId(prefix: string): string {
    this.interventionSeq += 1;
    return `${prefix}-${this.tickIndex}-${this.interventionSeq}`;
  }

  private async stepGoto(agent: Agent, tick: number, simTime: SimTime): Promise<void> {
    const target = agent.state.gotoTarget;
    if (!target) return;
    const pos = agent.state.position;
    const label = agent.state.gotoLabel;
    if (pos.x === target.x && pos.y === target.y) {
      agent.state.gotoTarget = null;
      agent.state.gotoLabel = null;
      agent.state.path = [];
      agent.state.pathPlannedAtTick = -1;
      agent.state.currentAction = label ? `arrived at ${label}` : 'idle';
      return;
    }

    // (Re)plan the path if we don't have one cached. We also replan if the
    // first step of the cached path is no longer adjacent to us — happens
    // when something kicked the agent off-course.
    let path = agent.state.path;
    const head = path[0];
    const headValid = head && Math.abs(head.x - pos.x) + Math.abs(head.y - pos.y) === 1;
    const tail = path[path.length - 1];
    const tailValid = tail && tail.x === target.x && tail.y === target.y;
    if (path.length === 0 || !headValid || !tailValid) {
      const planned = findPath(
        pos,
        target,
        (x, y) => this.world.walkableAt(x, y),
        { width: this.world.width, height: this.world.height },
        { goalAlwaysReachable: true },
      );
      if (!planned || planned.length === 0) {
        // No route — abandon the goto so the policy can pick something else.
        agent.state.gotoTarget = null;
        agent.state.gotoLabel = null;
        agent.state.path = [];
        agent.state.pathPlannedAtTick = -1;
        agent.state.currentAction = label ? `gave up on ${label}` : 'idle';
        return;
      }
      path = planned;
      agent.state.path = path;
      agent.state.pathPlannedAtTick = tick;
    }

    const next = path[0]!;
    if (!this.world.walkableAt(next.x, next.y)) {
      // Tile became impassable mid-route — drop the cache and try once more
      // next tick.
      agent.state.path = [];
      return;
    }
    agent.state.path = path.slice(1);
    const move: AgentAction = { kind: 'move_to', to: next };
    await this.applyAction(agent, move, tick, simTime);
    if (next.x === target.x && next.y === target.y) {
      agent.state.gotoTarget = null;
      agent.state.gotoLabel = null;
      agent.state.path = [];
      agent.state.pathPlannedAtTick = -1;
      agent.state.currentAction = label ? `arrived at ${label}` : 'idle';
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

  private sweepConversations(tick: number, simTime: SimTime): void {
    const positions = new Map<string, Vec2>();
    for (const agent of this.agents) positions.set(agent.def.id, agent.state.position);
    const pending: Array<{ session: ConversationSession; reason: CloseReason }> = [];
    this.conversations.sweep(positions, simTime, {
      onClose: (session, reason) => pending.push({ session, reason }),
    });
    for (const { session, reason } of pending) {
      this.handleConversationClose(session, reason, tick, simTime);
    }
  }

  private handleConversationClose(
    session: ConversationSession,
    reason: CloseReason,
    tick: number,
    simTime: SimTime,
  ): void {
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
    // Fire-and-forget: a mass-close burst would otherwise stall the tick on
    // thousands of awaited disk writes (TINA-22). Errors are swallowed so the
    // sim keeps ticking; persistence is best-effort observability.
    const promise = this.persistConversation(session, participants).catch((err) => {
      process.stderr.write(
        `${JSON.stringify({
          level: 'warn',
          event: 'conversation.persist.failure',
          sessionId: session.id,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    });
    this.persistPromises.add(promise);
    promise.finally(() => this.persistPromises.delete(promise));
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
    const now = this.world.simTime;
    const naturalSpeech: HeardSpeech[] = this.recent.speech
      .filter((s) => s.speakerId !== agent.def.id)
      .filter((s) => {
        const speaker = this.agents.find((a) => a.def.id === s.speakerId);
        if (!speaker) return false;
        return chebyshevDistance(agent.state.position, speaker.state.position) <= this.speechRadius;
      })
      .map((s) => ({
        speakerId: s.speakerId,
        speakerName: s.speakerName,
        text: s.text,
        at: s.at,
        source: 'natural' as const,
      }));
    // Drain any whisper interventions targeted at this agent. One-shot —
    // buildPerception consumes them so a whisper lands on exactly one tick.
    const whispers: HeardSpeech[] = [];
    for (let i = this.pendingWhispers.length - 1; i >= 0; i--) {
      const entry = this.pendingWhispers[i]!;
      if (entry.expireAt < now) {
        this.pendingWhispers.splice(i, 1);
        continue;
      }
      if (entry.targetId !== agent.def.id) continue;
      whispers.push(entry.heard);
      this.pendingWhispers.splice(i, 1);
    }
    const recentObservations: ObservedEvent[] = [];
    for (let i = this.pendingObservations.length - 1; i >= 0; i--) {
      const entry = this.pendingObservations[i]!;
      if (entry.expireAt < now) {
        this.pendingObservations.splice(i, 1);
        continue;
      }
      if (entry.targetId !== agent.def.id) continue;
      recentObservations.push(entry.observed);
      this.pendingObservations.splice(i, 1);
    }
    const recentSpeech = [...naturalSpeech, ...whispers];
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
      recentObservations,
      worldBounds: { width: this.world.width, height: this.world.height },
      zones: [...this.world.zones],
      locations: this.world.locations,
    };
  }

  /**
   * Fire-and-forget reflection trigger. We intentionally do NOT await the
   * underlying call because synthesis may hit the LLM gateway over the
   * network, and stalling the tick loop on I/O is what caused TINA-21. If
   * a reflection is already in flight for this agent, we skip — the next
   * tick will try again once the previous call resolves.
   */
  private maybeReflectAgent(agentId: string, simTime: SimTime, tick: number): void {
    const engine = this.reflectionEngines.get(agentId);
    if (!engine) return;
    const memory = this.memories.get(agentId);
    if (!memory) return;
    if (this.reflectionInFlight.has(agentId)) return;
    this.reflectionInFlight.add(agentId);
    const promise = (async () => {
      try {
        const result = await engine.maybeReflect({ memory, simTime });
        if (!result) return;
        for (const r of result.reflections) {
          this.emit({
            kind: 'reflection_written',
            tick,
            simTime,
            agentId,
            trigger: result.trigger,
            reflectionId: r.id,
            summary: r.fact,
            sourceCount: r.derived_from?.length ?? result.sourceFactIds.length,
          });
        }
      } catch (err) {
        // Never let a reflection error bubble — the sim must keep ticking.
        process.stderr.write(
          `${JSON.stringify({
            level: 'warn',
            event: 'reflection.error',
            agentId,
            message: err instanceof Error ? err.message : String(err),
          })}\n`,
        );
      } finally {
        this.reflectionInFlight.delete(agentId);
        this.reflectionPromises.delete(agentId);
      }
    })();
    this.reflectionPromises.set(agentId, promise);
  }

  /**
   * Serialize the live runtime state for durable save/resume. Static config
   * (tilemap, zones, personas) is NOT included — those are reloaded from
   * source on boot.
   */
  toStateSnapshot(): WorldStateSnapshot {
    return {
      version: WORLD_STATE_SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      seed: this.seed,
      tickIndex: this.tickIndex,
      interventionSeq: this.interventionSeq,
      clock: {
        simTime: this.clock.simTime,
        ticks: this.clock.ticks,
        speed: this.clock.speed,
      },
      world: {
        width: this.world.width,
        height: this.world.height,
        objects: this.world.listObjects().map((o) => ({ ...o, pos: { ...o.pos } })),
      },
      agents: this.agents.map((a) => ({
        id: a.def.id,
        position: { ...a.state.position },
        facing: a.state.facing,
        currentAction: a.state.currentAction,
        zone: a.state.zone,
      })),
    };
  }

  /**
   * Apply a previously-saved snapshot. Must be called before the first tick —
   * the underlying clock refuses to be rewound once it has advanced.
   *
   * Validates schema version + world dimensions. On any mismatch, throws so
   * the caller can log + fall back to cold start rather than silently land
   * agents in the wrong town.
   */
  restoreStateSnapshot(snap: WorldStateSnapshot): void {
    if (snap.version !== WORLD_STATE_SNAPSHOT_VERSION) {
      throw new Error(
        `snapshot version ${snap.version} != current ${WORLD_STATE_SNAPSHOT_VERSION}`,
      );
    }
    if (snap.world.width !== this.world.width || snap.world.height !== this.world.height) {
      throw new Error(
        `snapshot dims ${snap.world.width}x${snap.world.height} != runtime ${this.world.width}x${this.world.height}`,
      );
    }
    if (this.tickIndex !== 0) {
      throw new Error('Runtime.restoreStateSnapshot() called after ticks have advanced');
    }
    this.clock.restore({
      simTime: snap.clock.simTime,
      ticks: snap.clock.ticks,
      speed: snap.clock.speed,
    });
    this._tickIndex = snap.tickIndex;
    this.interventionSeq = snap.interventionSeq;
    this.world.restoreObjects(snap.world.objects);
    const byId = new Map(snap.agents.map((a) => [a.id, a]));
    for (const agent of this.agents) {
      const saved = byId.get(agent.def.id);
      if (!saved) continue;
      agent.state.position = { ...saved.position };
      agent.state.facing = saved.facing;
      agent.state.currentAction = saved.currentAction;
      agent.state.zone = saved.zone;
      // Drop any cached routing — the next tick will replan from the new pos.
      agent.state.gotoTarget = null;
      agent.state.gotoLabel = null;
      agent.state.path = [];
      agent.state.pathPlannedAtTick = -1;
    }
  }

  /** Test/support hook: wait for any in-flight reflections to finish. */
  async awaitReflections(): Promise<void> {
    const pending = [...this.reflectionPromises.values()];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }

  /**
   * Test/support hook: wait for any in-flight `persistConversation` writes to
   * finish. Used by `flushConversations` and tests that need to assert the
   * "talked with …" facts have actually landed on disk.
   */
  async awaitConversationPersists(): Promise<void> {
    const pending = [...this.persistPromises];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }

  private pruneRecent(): void {
    const now = this.world.simTime;
    this.recent.speech = this.recent.speech.filter((s) => s.expireAt >= now);
  }
}

function deriveMood(
  activity: string | undefined,
  suspended: string | null,
  currentAction: string,
): AgentMood {
  if (suspended === 'conversation') return 'engaged';
  if (currentAction.startsWith('speaking')) return 'chatty';
  switch (activity) {
    case 'work':
      return 'focused';
    case 'socialize':
      return 'chatty';
    case 'eat':
      return 'relaxed';
    case 'wander':
      return 'restless';
    case 'rest':
      return 'drowsy';
    default:
      return 'idle';
  }
}
