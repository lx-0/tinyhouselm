import { describe, expect, it } from 'vitest';
import {
  blankMap,
  fillRect,
  homeForAgent,
  isWalkable,
  locationsByAffordance,
  nearestWalkable,
  resolveLocation,
  setTile,
} from './tilemap.js';
import { buildStarterTown } from './town.js';

describe('tilemap helpers', () => {
  it('blankMap fills with walkable grass', () => {
    const m = blankMap(4, 4);
    expect(m.tiles).toHaveLength(16);
    expect(m.tiles.every((t) => t.kind === 'grass' && t.walkable)).toBe(true);
  });

  it('walls are not walkable', () => {
    const m = blankMap(3, 3);
    setTile(m, 1, 1, { kind: 'wall', walkable: false });
    expect(isWalkable(m, 1, 1)).toBe(false);
    expect(isWalkable(m, 0, 0)).toBe(true);
    // Out of bounds is never walkable.
    expect(isWalkable(m, -1, 0)).toBe(false);
    expect(isWalkable(m, 3, 0)).toBe(false);
  });

  it('fillRect paints a rectangle', () => {
    const m = blankMap(5, 5);
    fillRect(m, { x: 1, y: 1, width: 3, height: 2 }, 'water');
    expect(m.tiles[1 * 5 + 2]!.kind).toBe('water');
    expect(m.tiles[1 * 5 + 2]!.walkable).toBe(false);
  });

  it('nearestWalkable hops away from blocked target', () => {
    const m = blankMap(5, 5);
    setTile(m, 2, 2, { kind: 'wall', walkable: false });
    const found = nearestWalkable(m, { x: 2, y: 2 });
    expect(found).not.toBeNull();
    expect(isWalkable(m, found!.x, found!.y)).toBe(true);
  });
});

describe('starter town', () => {
  const map = buildStarterTown();

  it('has the four expected areas', () => {
    const names = map.areas.map((a) => a.name).sort();
    expect(names).toEqual(['cafe', 'home', 'park', 'work']);
  });

  it('every location anchor sits on a walkable tile', () => {
    for (const loc of map.locations) {
      expect(isWalkable(map, loc.anchor.x, loc.anchor.y)).toBe(true);
    }
  });

  it('exposes work, sleep, coffee, and leisure affordances', () => {
    expect(locationsByAffordance(map, 'work').length).toBeGreaterThan(0);
    expect(locationsByAffordance(map, 'sleep').length).toBe(3);
    expect(locationsByAffordance(map, 'coffee').length).toBeGreaterThan(0);
    expect(locationsByAffordance(map, 'leisure').length).toBeGreaterThan(0);
  });

  it('resolveLocation picks the affordance match within an area', () => {
    const cafeWork = resolveLocation(map, { area: 'cafe', affordance: 'coffee' });
    expect(cafeWork?.id).toBe('cafe.counter');
  });

  it('homeForAgent assigns the same home for the same id', () => {
    const a = homeForAgent(map, 'agent-x');
    const b = homeForAgent(map, 'agent-x');
    expect(a).not.toBeNull();
    expect(a?.id).toBe(b?.id);
  });

  it('homeForAgent spreads agents across multiple homes', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const homes = new Set(ids.map((id) => homeForAgent(map, id)?.id));
    expect(homes.size).toBeGreaterThan(1);
  });
});
