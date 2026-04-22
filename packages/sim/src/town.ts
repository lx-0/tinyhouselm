import type { Location, TileMap, Zone } from '@tina/shared';
import { blankMap, fillRect, setTile, strokeRect } from './tilemap.js';

/**
 * Hand-authored starter town for TINA-10.
 *
 * 32x24 tiles. Cafe top-left, park top-right, workplace middle-right,
 * three small homes across the bottom row. A horizontal main street and
 * a north–south spine path connect the buildings; walls + doors gate
 * interior tiles so A* has to route around them.
 */
export function buildStarterTown(): TileMap {
  const W = 32;
  const H = 24;
  const map = blankMap(W, H, 'grass');

  // Main horizontal street + north–south spine.
  fillRect(map, { x: 0, y: 11, width: W, height: 2 }, 'path');
  fillRect(map, { x: 15, y: 0, width: 2, height: H }, 'path');

  // Cafe (top-left).
  const cafe = { x: 1, y: 1, width: 9, height: 8 };
  fillRect(map, cafe, 'floor');
  strokeRect(map, cafe, 'wall');
  setTile(map, cafe.x + Math.floor(cafe.width / 2), cafe.y + cafe.height - 1, {
    kind: 'door',
    walkable: true,
  });

  // Park (top-right): grass + a small pond.
  const park = { x: 19, y: 1, width: 12, height: 9 };
  fillRect(map, park, 'grass');
  fillRect(map, { x: 24, y: 4, width: 3, height: 2 }, 'water');
  for (let x = park.x; x < park.x + park.width; x++) {
    setTile(map, x, park.y + park.height - 2, { kind: 'path', walkable: true });
  }

  // Workplace (middle-right, just south of the street).
  const work = { x: 19, y: 14, width: 9, height: 7 };
  fillRect(map, work, 'floor');
  strokeRect(map, work, 'wall');
  setTile(map, work.x + Math.floor(work.width / 2), work.y, { kind: 'door', walkable: true });

  // Three homes south of the street.
  const homes = [
    { x: 1, y: 16, width: 6, height: 6 },
    { x: 8, y: 16, width: 6, height: 6 },
    { x: 28, y: 14, width: 4, height: 7 },
  ];
  for (const h of homes) {
    fillRect(map, h, 'floor');
    strokeRect(map, h, 'wall');
    setTile(map, h.x + Math.floor(h.width / 2), h.y, { kind: 'door', walkable: true });
  }

  const areas: Zone[] = [
    { name: 'cafe', x: cafe.x, y: cafe.y, width: cafe.width, height: cafe.height },
    { name: 'park', x: park.x, y: park.y, width: park.width, height: park.height },
    { name: 'work', x: work.x, y: work.y, width: work.width, height: work.height },
    {
      name: 'home',
      x: homes[0]!.x,
      y: homes[0]!.y,
      width: homes[1]!.x + homes[1]!.width - homes[0]!.x,
      height: homes[0]!.height,
    },
  ];

  const locations: Location[] = [
    {
      id: 'cafe.counter',
      name: 'Cafe Counter',
      area: 'cafe',
      affordances: ['coffee', 'food', 'social'],
      anchor: { x: cafe.x + Math.floor(cafe.width / 2), y: cafe.y + 2 },
    },
    {
      id: 'cafe.table',
      name: 'Cafe Table',
      area: 'cafe',
      affordances: ['food', 'social'],
      anchor: { x: cafe.x + 2, y: cafe.y + cafe.height - 2 },
    },
    {
      id: 'park.bench',
      name: 'Park Bench',
      area: 'park',
      affordances: ['leisure', 'social'],
      anchor: { x: park.x + 2, y: park.y + park.height - 1 },
    },
    {
      id: 'park.pond',
      name: 'Pond',
      area: 'park',
      affordances: ['leisure'],
      anchor: { x: 23, y: 6 },
    },
    {
      id: 'work.desk',
      name: 'Work Desk',
      area: 'work',
      affordances: ['work'],
      anchor: { x: work.x + 3, y: work.y + 3 },
    },
    {
      id: 'home.0.bed',
      name: 'Home 0 Bed',
      area: 'home',
      affordances: ['sleep', 'leisure'],
      anchor: { x: homes[0]!.x + 2, y: homes[0]!.y + 3 },
    },
    {
      id: 'home.1.bed',
      name: 'Home 1 Bed',
      area: 'home',
      affordances: ['sleep', 'leisure'],
      anchor: { x: homes[1]!.x + 3, y: homes[1]!.y + 3 },
    },
    {
      id: 'home.2.bed',
      name: 'Home 2 Bed',
      area: 'home',
      affordances: ['sleep', 'leisure'],
      anchor: { x: homes[2]!.x + 1, y: homes[2]!.y + 3 },
    },
  ];

  map.areas = areas;
  map.locations = locations;
  return map;
}
