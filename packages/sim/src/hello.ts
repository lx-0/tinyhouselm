import { Agent } from './agent.js';
import { SimulationClock } from './clock.js';
import { World } from './world.js';

const TICKS = 20;
const TICK_MS = 100;

const clock = new SimulationClock({ mode: 'stepped', speed: 60, tickHz: 10 });
const world = new World({ width: 16, height: 16, clock });

const ava = new Agent(
  {
    id: 'ava-okafor',
    name: 'Ava Okafor',
    description: '27yo part-time barista, amateur painter, introvert.',
    body: 'Quiet. Paints at night. Dry wit.',
    metadata: {},
  },
  { position: { x: 4, y: 4 }, facing: 'S', currentAction: 'idle' },
);

world.addAgent(ava);

console.log(`[tina] hello-world: ${TICKS} ticks @ ${TICK_MS}ms`);
console.log(`[tina] agent ${ava.def.id} at (${ava.state.position.x},${ava.state.position.y})`);

for (let i = 0; i < TICKS; i++) {
  const deltas = world.tick(TICK_MS);

  if (i === 5) {
    ava.apply({ kind: 'set_goal', goal: 'walk to the café' });
  }
  if (i === 10) {
    ava.apply({ kind: 'move_to', to: { x: 7, y: 4 } });
    world.emit({
      kind: 'agent_move',
      id: ava.def.id,
      from: { x: 4, y: 4 },
      to: { x: 7, y: 4 },
      durationMs: 300,
    });
  }
  if (i === 15) {
    ava.apply({ kind: 'speak', to: null, text: 'morning.' });
    world.emit({
      kind: 'speech',
      id: ava.def.id,
      text: 'morning.',
      heardBy: [],
      ttlMs: 2000,
    });
  }

  const t = world.simTime.toFixed(1).padStart(5);
  console.log(
    `  t=${t}s  tick=${i.toString().padStart(2)}  ${ava.def.name}: ${ava.state.currentAction}  deltas=${deltas.length}`,
  );
}

console.log('[tina] done');
