import {
  type Delta,
  type Location,
  type SimTime,
  type TileMap,
  type Vec2,
  type WorldObject,
  type Zone,
  deriveWorldClock,
} from '@tina/shared';
import type { Agent } from './agent.js';
import { SimulationClock } from './clock.js';
import { isWalkable } from './tilemap.js';

export interface WorldOptions {
  width: number;
  height: number;
  clock?: SimulationClock;
  zones?: Zone[];
  tileMap?: TileMap;
}

export class World {
  readonly width: number;
  readonly height: number;
  readonly clock: SimulationClock;
  readonly zones: Zone[];
  readonly tileMap: TileMap | null;
  private agents: Map<string, Agent> = new Map();
  private deltas: Delta[] = [];
  private readonly objects: Map<string, WorldObject> = new Map();

  constructor(opts: WorldOptions) {
    if (opts.tileMap) {
      this.tileMap = opts.tileMap;
      this.width = opts.tileMap.width;
      this.height = opts.tileMap.height;
      this.zones = opts.zones ? [...opts.zones] : [...opts.tileMap.areas];
    } else {
      this.tileMap = null;
      this.width = opts.width;
      this.height = opts.height;
      this.zones = opts.zones ? [...opts.zones] : [];
    }
    this.clock = opts.clock ?? new SimulationClock();
  }

  get locations(): Location[] {
    return this.tileMap ? [...this.tileMap.locations] : [];
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
    const simTime = this.clock.simTime;
    this.deltas.push({
      kind: 'tick',
      simTime,
      clock: deriveWorldClock(simTime, this.clock.speed),
    });
    const flushed = this.deltas;
    this.deltas = [];
    return flushed;
  }

  emit(delta: Delta): void {
    this.deltas.push(delta);
  }

  drainDeltas(): Delta[] {
    const flushed = this.deltas;
    this.deltas = [];
    return flushed;
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

  /**
   * True if a tile is walkable (or always true when no tilemap is loaded —
   * keeps the bare-bones tests working without forcing every caller to ship a
   * map).
   */
  walkableAt(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    if (!this.tileMap) return true;
    return isWalkable(this.tileMap, x, y);
  }

  listObjects(): WorldObject[] {
    return [...this.objects.values()];
  }

  getObject(id: string): WorldObject | null {
    return this.objects.get(id) ?? null;
  }

  addObject(obj: WorldObject): WorldObject {
    const stored: WorldObject = { ...obj, zone: obj.zone ?? this.zoneAt(obj.pos) };
    this.objects.set(stored.id, stored);
    this.deltas.push({ kind: 'object_add', object: stored, simTime: this.simTime });
    return stored;
  }

  removeObject(id: string): WorldObject | null {
    const existing = this.objects.get(id);
    if (!existing) return null;
    this.objects.delete(id);
    this.deltas.push({
      kind: 'object_remove',
      id: existing.id,
      label: existing.label,
      simTime: this.simTime,
    });
    return existing;
  }
}
