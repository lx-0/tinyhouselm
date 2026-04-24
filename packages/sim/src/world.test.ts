import { describe, expect, it } from 'vitest';
import { Agent } from './agent.js';
import { SimulationClock } from './clock.js';
import { World } from './world.js';

describe('World', () => {
  it('emits a tick delta and a spawn delta', () => {
    const clock = new SimulationClock({ mode: 'stepped', speed: 60 });
    const world = new World({ width: 8, height: 8, clock });
    const agent = new Agent(
      { id: 'a', name: 'A', description: 'x', body: '', metadata: {} },
      { position: { x: 0, y: 0 } },
    );
    world.addAgent(agent);
    const deltas = world.tick(100);
    const kinds = deltas.map((d) => d.kind);
    expect(kinds).toContain('agent_spawn');
    expect(kinds).toContain('tick');
  });

  it('move_to updates position and status', () => {
    const a = new Agent(
      { id: 'a', name: 'A', description: 'x', body: '', metadata: {} },
      { position: { x: 0, y: 0 } },
    );
    a.apply({ kind: 'move_to', to: { x: 3, y: 4 } });
    expect(a.state.position).toEqual({ x: 3, y: 4 });
    expect(a.state.currentAction).toContain('moving');
  });

  it('zoneAt reports the covering zone', () => {
    const world = new World({
      width: 16,
      height: 16,
      zones: [
        { name: 'cafe', x: 1, y: 1, width: 4, height: 4 },
        { name: 'park', x: 10, y: 10, width: 4, height: 4 },
      ],
    });
    expect(world.zoneAt({ x: 2, y: 2 })).toBe('cafe');
    expect(world.zoneAt({ x: 12, y: 12 })).toBe('park');
    expect(world.zoneAt({ x: 7, y: 7 })).toBeNull();
  });

  it('stamps the zone on spawning agents', () => {
    const world = new World({
      width: 16,
      height: 16,
      zones: [{ name: 'cafe', x: 1, y: 1, width: 4, height: 4 }],
    });
    const agent = new Agent(
      { id: 'a', name: 'A', description: 'x', body: '', metadata: {} },
      { position: { x: 2, y: 2 } },
    );
    world.addAgent(agent);
    expect(agent.state.zone).toBe('cafe');
  });

  it('goto updates agent state target', () => {
    const a = new Agent({ id: 'a', name: 'A', description: 'x', body: '', metadata: {} });
    a.apply({ kind: 'goto', target: { x: 5, y: 5 }, label: 'park' });
    expect(a.state.gotoTarget).toEqual({ x: 5, y: 5 });
    expect(a.state.gotoLabel).toBe('park');
    expect(a.state.currentAction).toContain('park');
  });

  it('addObject and restoreObjects roundtrip the affordance field (TINA-416)', () => {
    const world = new World({ width: 8, height: 8 });
    const stored = world.addObject({
      id: 'b1',
      label: 'park bench',
      pos: { x: 1, y: 1 },
      zone: null,
      droppedAtSim: 10,
      affordance: 'bench',
    });
    expect(stored.affordance).toBe('bench');
    expect(world.listObjects()[0]!.affordance).toBe('bench');

    const fresh = new World({ width: 8, height: 8 });
    fresh.restoreObjects(world.listObjects());
    expect(fresh.getObject('b1')?.affordance).toBe('bench');
  });
});
