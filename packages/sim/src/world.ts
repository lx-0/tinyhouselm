import type { Delta, SimTime } from '@tina/shared';
import type { Agent } from './agent.js';
import { SimulationClock } from './clock.js';

export interface WorldOptions {
  width: number;
  height: number;
  clock?: SimulationClock;
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly clock: SimulationClock;
  private agents: Map<string, Agent> = new Map();
  private deltas: Delta[] = [];

  constructor(opts: WorldOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.clock = opts.clock ?? new SimulationClock();
  }

  addAgent(agent: Agent): void {
    this.agents.set(agent.def.id, agent);
    this.deltas.push({ kind: 'agent_spawn', agent: agent.snapshot() });
  }

  listAgents(): Agent[] {
    return [...this.agents.values()];
  }

  get simTime(): SimTime {
    return this.clock.simTime;
  }

  tick(realMs: number): Delta[] {
    this.clock.advance(realMs);
    this.deltas.push({ kind: 'tick', simTime: this.clock.simTime });
    const flushed = this.deltas;
    this.deltas = [];
    return flushed;
  }

  emit(delta: Delta): void {
    this.deltas.push(delta);
  }
}
