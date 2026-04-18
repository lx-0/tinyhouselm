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
});
