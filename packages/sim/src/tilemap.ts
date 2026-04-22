import type { Affordance, Location, Tile, TileMap, Vec2 } from '@tina/shared';

export function tileIndex(map: { width: number }, x: number, y: number): number {
  return y * map.width + x;
}

export function tileAt(map: TileMap, x: number, y: number): Tile | null {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  return map.tiles[tileIndex(map, x, y)] ?? null;
}

export function isWalkable(map: TileMap, x: number, y: number): boolean {
  const t = tileAt(map, x, y);
  return !!t && t.walkable;
}

export function locationById(map: TileMap, id: string): Location | null {
  return map.locations.find((l) => l.id === id) ?? null;
}

export function locationsByAffordance(map: TileMap, affordance: Affordance): Location[] {
  return map.locations.filter((l) => l.affordances.includes(affordance));
}

export function locationsInArea(map: TileMap, area: string): Location[] {
  return map.locations.filter((l) => l.area === area);
}

/**
 * Resolve a request for "an area name and/or an affordance" to a single
 * location anchor. Used by the planner when its block says "preferredZone:cafe"
 * — we look for a cafe location, prefer one with the requested affordance.
 */
export function resolveLocation(
  map: TileMap,
  args: { area?: string | null; affordance?: Affordance | null; preferId?: string | null },
): Location | null {
  if (args.preferId) {
    const direct = locationById(map, args.preferId);
    if (direct) return direct;
  }
  const area = args.area ?? null;
  const aff = args.affordance ?? null;
  let pool = map.locations;
  if (area) pool = pool.filter((l) => l.area === area);
  if (aff) {
    const withAff = pool.filter((l) => l.affordances.includes(aff));
    if (withAff.length > 0) return withAff[0]!;
  }
  return pool[0] ?? null;
}

/**
 * Pick a "home" anchor for an agent so the three houses fill evenly. Hashes
 * the agent id across all locations exposing the `sleep` affordance.
 */
export function homeForAgent(map: TileMap, agentId: string): Location | null {
  const beds = locationsByAffordance(map, 'sleep');
  if (beds.length === 0) return null;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return beds[h % beds.length] ?? null;
}

export function makeTile(kind: Tile['kind']): Tile {
  switch (kind) {
    case 'wall':
    case 'water':
      return { kind, walkable: false };
    default:
      return { kind, walkable: true };
  }
}

export function blankMap(width: number, height: number, fill: Tile['kind'] = 'grass'): TileMap {
  const tiles: Tile[] = new Array(width * height);
  for (let i = 0; i < tiles.length; i++) tiles[i] = makeTile(fill);
  return { width, height, tiles, locations: [], areas: [] };
}

export function setTile(map: TileMap, x: number, y: number, tile: Tile): void {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return;
  map.tiles[tileIndex(map, x, y)] = tile;
}

export function fillRect(
  map: TileMap,
  rect: { x: number; y: number; width: number; height: number },
  kind: Tile['kind'],
): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) setTile(map, x, y, makeTile(kind));
  }
}

export function strokeRect(
  map: TileMap,
  rect: { x: number; y: number; width: number; height: number },
  kind: Tile['kind'],
): void {
  for (let x = rect.x; x < rect.x + rect.width; x++) {
    setTile(map, x, rect.y, makeTile(kind));
    setTile(map, x, rect.y + rect.height - 1, makeTile(kind));
  }
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    setTile(map, rect.x, y, makeTile(kind));
    setTile(map, rect.x + rect.width - 1, y, makeTile(kind));
  }
}

export function nearestWalkable(map: TileMap, target: Vec2, radius = 4): Vec2 | null {
  if (isWalkable(map, target.x, target.y)) return target;
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = target.x + dx;
        const ny = target.y + dy;
        if (isWalkable(map, nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  return null;
}
