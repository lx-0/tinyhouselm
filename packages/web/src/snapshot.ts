import { type Snapshot, type Tile, deriveWorldClock } from '@tina/shared';
import type { World } from '@tina/sim';

export function buildSnapshot(world: World): Snapshot {
  const tiles: Tile[] = world.tileMap
    ? world.tileMap.tiles.map((t) => ({ ...t }))
    : new Array(world.width * world.height).fill({ kind: 'grass', walkable: true });
  return {
    kind: 'snapshot',
    simTime: world.simTime,
    speed: world.clock.speed,
    clock: deriveWorldClock(world.simTime, world.clock.speed),
    map: {
      width: world.width,
      height: world.height,
      tiles,
      zones: [...world.zones],
      locations: world.locations,
    },
    agents: world.listAgents().map((a) => a.snapshot()),
  };
}
