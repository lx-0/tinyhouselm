/**
 * Lightweight in-process telemetry for the tick loop. The runtime feeds
 * lifecycle events in; callers read an immutable snapshot. No external deps,
 * no sampling, no persistence — designed for "cheap enough to call every tick".
 */
import type { AgentAction, SimTime } from '@tina/shared';
import type { RuntimeEvent } from './runtime.js';

export interface TelemetrySnapshot {
  ticks: number;
  simTime: SimTime;
  agents: number;
  /** action kind -> count over the whole run */
  actions: Record<AgentAction['kind'], number>;
  /** conversations opened / closed over the whole run */
  conversationsOpened: number;
  conversationsClosed: number;
  /** reflections written across all agents over the whole run */
  reflectionsWritten: number;
  /** number of sessions currently open (set externally by the runtime) */
  activeConversations: number;
  /** per-tick wall duration samples, in ms, most recent last, capped */
  tickDurationSamples: number[];
  /** ms/tick summary over the sample window */
  tickDuration: {
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  /** conversations opened per minute of *real* wall time since the collector started */
  conversationsPerMinute: number;
  /** actions per real-time minute */
  actionsPerMinute: number;
  /** wall ms since the collector started */
  wallMs: number;
}

export interface TelemetryOptions {
  /** how many per-tick durations to retain for the summary (default 600 = 1m @ 100ms) */
  sampleWindow?: number;
  /** real wall-clock now in ms, injectable for tests */
  now?: () => number;
}

const EMPTY_ACTIONS: Record<AgentAction['kind'], number> = {
  move_to: 0,
  goto: 0,
  speak: 0,
  wait: 0,
  set_goal: 0,
  remember: 0,
};

export class TelemetryCollector {
  private sampleWindow: number;
  private now: () => number;
  private startedAt: number;
  private ticks = 0;
  private simTime: SimTime = 0;
  private agents = 0;
  private actions: Record<AgentAction['kind'], number> = { ...EMPTY_ACTIONS };
  private opened = 0;
  private closed = 0;
  private reflections = 0;
  private activeConversations = 0;
  private durations: number[] = [];

  constructor(opts: TelemetryOptions = {}) {
    this.sampleWindow = Math.max(1, opts.sampleWindow ?? 600);
    this.now = opts.now ?? (() => performance.now());
    this.startedAt = this.now();
  }

  observe(event: RuntimeEvent): void {
    switch (event.kind) {
      case 'tick':
        this.ticks++;
        this.simTime = event.simTime;
        return;
      case 'action':
        this.actions[event.action.kind] += 1;
        return;
      case 'conversation_open':
        this.opened += 1;
        return;
      case 'conversation_close':
        this.closed += 1;
        return;
      case 'spawn':
        this.agents += 1;
        return;
      case 'reflection_written':
        this.reflections += 1;
        return;
    }
  }

  /** Called by the runtime with the wall ms for the tick it just finished. */
  recordTickDuration(ms: number): void {
    if (this.durations.length >= this.sampleWindow) this.durations.shift();
    this.durations.push(ms);
  }

  setActiveConversations(n: number): void {
    this.activeConversations = n;
  }

  snapshot(): TelemetrySnapshot {
    const samples = [...this.durations];
    const sorted = [...samples].sort((a, b) => a - b);
    const wallMs = this.now() - this.startedAt;
    const minutes = wallMs / 60000;
    return {
      ticks: this.ticks,
      simTime: this.simTime,
      agents: this.agents,
      actions: { ...this.actions },
      conversationsOpened: this.opened,
      conversationsClosed: this.closed,
      reflectionsWritten: this.reflections,
      activeConversations: this.activeConversations,
      tickDurationSamples: samples,
      tickDuration: {
        mean: mean(samples),
        p50: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
        p99: quantile(sorted, 0.99),
        max: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
      },
      conversationsPerMinute: minutes > 0 ? this.opened / minutes : 0,
      actionsPerMinute: minutes > 0 ? sumRecord(this.actions) / minutes : 0,
      wallMs,
    };
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

function sumRecord(r: Record<string, number>): number {
  let s = 0;
  for (const k of Object.keys(r)) s += r[k]!;
  return s;
}
