import { describe, expect, it } from 'vitest';
import { findPath } from './path.js';

const open = () => true;

describe('findPath', () => {
  it('returns an empty path when start equals goal', () => {
    const path = findPath({ x: 3, y: 3 }, { x: 3, y: 3 }, open, { width: 8, height: 8 });
    expect(path).toEqual([]);
  });

  it('returns a straight Manhattan-length path on an open map', () => {
    const path = findPath({ x: 0, y: 0 }, { x: 4, y: 0 }, open, { width: 8, height: 8 });
    expect(path).not.toBeNull();
    expect(path).toHaveLength(4);
    expect(path?.[path.length - 1]).toEqual({ x: 4, y: 0 });
  });

  it('routes around a wall', () => {
    // 5x3 grid with a wall column down the middle except for a gap at the top.
    //   . W .
    //   . W .
    //   . . .
    const wall = new Set<string>(['1,0', '1,1']);
    const walkable = (x: number, y: number) => !wall.has(`${x},${y}`);
    const path = findPath({ x: 0, y: 0 }, { x: 2, y: 0 }, walkable, { width: 3, height: 3 });
    expect(path).not.toBeNull();
    // Must not step on a wall.
    for (const step of path!) expect(wall.has(`${step.x},${step.y}`)).toBe(false);
    // Must end at the goal.
    expect(path![path!.length - 1]).toEqual({ x: 2, y: 0 });
  });

  it('returns null when the goal is unreachable', () => {
    // Wall the goal off completely.
    const blocked = (x: number, y: number) => x !== 2;
    const path = findPath({ x: 0, y: 0 }, { x: 4, y: 0 }, blocked, { width: 5, height: 1 });
    expect(path).toBeNull();
  });

  it('honors maxNodes and bails', () => {
    const path = findPath(
      { x: 0, y: 0 },
      { x: 9, y: 9 },
      open,
      { width: 10, height: 10 },
      { maxNodes: 2 },
    );
    expect(path).toBeNull();
  });

  it('is deterministic across runs', () => {
    const a = findPath({ x: 0, y: 0 }, { x: 5, y: 5 }, open, { width: 10, height: 10 });
    const b = findPath({ x: 0, y: 0 }, { x: 5, y: 5 }, open, { width: 10, height: 10 });
    expect(a).toEqual(b);
  });

  it('lets goalAlwaysReachable end on a non-walkable tile', () => {
    // Goal tile is a wall — we still want a path *up to* it.
    const walkable = (x: number, y: number) => !(x === 2 && y === 0);
    const path = findPath(
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      walkable,
      { width: 5, height: 1 },
      { goalAlwaysReachable: true },
    );
    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toEqual({ x: 2, y: 0 });
  });
});
