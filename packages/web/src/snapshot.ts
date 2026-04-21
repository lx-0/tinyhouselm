import { type Snapshot, deriveWorldClock } from '@tina/shared';
import type { World } from '@tina/sim';

export function buildSnapshot(world: World): Snapshot {
  return {
    kind: 'snapshot',
    simTime: world.simTime,
    speed: world.clock.speed,
    clock: deriveWorldClock(world.simTime, world.clock.speed),
    map: {
      width: world.width,
      height: world.height,
      tiles: [],
      zones: [...world.zones],
    },
    agents: world.listAgents().map((a) => a.snapshot()),
  };
}
