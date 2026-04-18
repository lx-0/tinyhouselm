import type { Delta, SimTime, Vec2, Zone } from '@tina/shared';
import type { Agent } from './agent.js';
import { SimulationClock } from './clock.js';

export interface WorldOptions {
  width: number;
  height: number;
  clock?: SimulationClock;
  zones?: Zone[];
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly clock: SimulationClock;
  readonly zones: Zone[];
  private agents: Map<string, Agent> = new Map();
  private deltas: Delta[] = [];

  constructor(opts: WorldOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.clock = opts.clock ?? new SimulationClock();
    this.zones = opts.zones ? [...opts.zones] : [];
  }

  addAgent(agent: Agent): void {
    agent.state.zone = this.zoneAt(agent.state.position);
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

  zoneAt(pos: Vec2): string | null {
    for (const zone of this.zones) {
      if (
        pos.x >= zone.x &&
        pos.x < zone.x + zone.width &&
        pos.y >= zone.y &&
        pos.y < zone.y + zone.height
      ) {
        return zone.name;
      }
    }
    return null;
  }

  zoneCenter(name: string): Vec2 | null {
    const zone = this.zones.find((z) => z.name === name);
    if (!zone) return null;
    return {
      x: Math.floor(zone.x + zone.width / 2),
      y: Math.floor(zone.y + zone.height / 2),
    };
  }
}
